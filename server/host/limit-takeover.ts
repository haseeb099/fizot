// When the AI a bot runs on reaches its usage limit, the bot carries on with another AI the person has set up until that
// limit resets, without anyone being asked, and the person hears it once for that stretch of the limit.
import { recoveryCapabilityError } from "../automatic-recovery.ts";
import type { InstanceConfigMap, ProviderAdapter, RuntimeEvent } from "../contracts.ts";
import { readyToRun, selectDefaultModelSelection, type DefaultSelectionContext, type SelectableInstance } from "../default-model-selection.ts";
import { billsEachUse, limitBackupAllowed, type LimitFailover } from "../limit-failover.ts";
import { LimitNotices, limitNoticeText } from "../limit-notices.ts";
import { UNNAMED_LIMIT_MS } from "../limit-resets.ts";
import type { ModelSelection } from "../../shared/wire.ts";

/** What a usage limit refused (the runtime error's `limit`): the account on that engine, one model's own window, or
 * one model's extra usage credits. */
export type LimitScope = "engine" | "model" | "credits";

/** A model's own limit holds that model at most this long before it is tried again, in case its window ended early. */
export const MODEL_HOLD_MS = 6 * 60 * 60_000;

/** A model held by its own limit: until when, when the limit said it resets, and which limit it is. */
export interface ModelHold { until: number; resetsAt?: number; scope: "model" | "credits" }

export type TakeoverEngine = SelectableInstance & { displayName?: string; capabilities: ProviderAdapter["capabilities"] };
type Bot = { id: string; name: string };

export interface LimitTakeoverDeps {
  file: string;
  /** Every engine here as last read: no probe, so a turn never waits on one. */
  engines(): TakeoverEngine[];
  configs(): InstanceConfigMap;
  context: DefaultSelectionContext;
  /** Until when this engine refuses work, or null. */
  blockedUntil(instanceId: string): number | null;
  /** The backups the person chose for this bot, or for every bot. */
  chosen(botId: string): ModelSelection[];
  engineName(instanceId: string): string;
  tell(bot: Bot, text: string): void;
  /** A conversation moved off a limited AI: it goes back once that limit resets. */
  record(failover: LimitFailover): void;
  now?(): number;
}

export function createLimitTakeover(deps: LimitTakeoverDeps) {
  const now = deps.now ?? Date.now;
  const notices = new LimitNotices(deps.file, now);
  const heldModels = new Map<string, ModelHold>();
  const modelKey = (selection: ModelSelection) => `${selection.instanceId}\u0000${selection.model}`;
  const incidentKey = (botId: string) => `incident\u0000${botId}`;

  const modelHeld = (selection: ModelSelection): ModelHold | null => {
    const held = heldModels.get(modelKey(selection));
    if (!held) return null;
    if (held.until > now()) return held;
    heldModels.delete(modelKey(selection));
    return null;
  };

  const holdModel = (selection: ModelSelection, scope: "model" | "credits", resetsAt?: number): void => {
    const at = now(), named = resetsAt !== undefined && resetsAt > at ? resetsAt : undefined;
    heldModels.set(modelKey(selection), { until: Math.min(named ?? at + UNNAMED_LIMIT_MS, at + MODEL_HOLD_MS), ...(named ? { resetsAt: named } : {}), scope });
  };

  const usable = (engines: TakeoverEngine[], current: TakeoverEngine, selection: ModelSelection): boolean => {
    const engine = engines.find((candidate) => candidate.instanceId === selection.instanceId);
    if (!engine || !readyToRun(engine, deps.context) || deps.blockedUntil(engine.instanceId) !== null || modelHeld(selection) !== null) return false;
    if (engine.instanceId !== current.instanceId && !limitBackupAllowed(current, engine, deps.configs()[engine.instanceId])) return false;
    if (recoveryCapabilityError(current, engine)) return false;
    return engine.models.default === selection.model || engine.models.options.some((model) => model.id === selection.model);
  };

  /** The AIs that may carry on while `from` is limited, best first: for one model's limit the same AI's own default
   * model, then the backups the person chose, then the AI Fizot would pick for a new bot among the rest that draw on
   * a plan. One that bills each use spends the person's money, so it carries on only as a backup they chose. */
  function backups(botId: string, from: ModelSelection, scope: LimitScope = "engine"): ModelSelection[] {
    const engines = deps.engines();
    const current = engines.find((engine) => engine.instanceId === from.instanceId);
    if (!current) return [];
    const out: ModelSelection[] = [];
    const add = (selection: ModelSelection) => {
      if (selection.instanceId === from.instanceId && (scope === "engine" || selection.model === from.model)) return;
      if (out.some((known) => known.instanceId === selection.instanceId && known.model === selection.model)) return;
      if (usable(engines, current, selection)) out.push({ instanceId: selection.instanceId, model: selection.model });
    };
    if (scope !== "engine") add({ instanceId: current.instanceId, model: current.models.default });
    for (const selection of deps.chosen(botId)) add(selection);
    const others = engines.filter((engine) => engine.instanceId !== from.instanceId && engine.access !== "api" && !billsEachUse(deps.configs()[engine.instanceId])
      && usable(engines, current, { instanceId: engine.instanceId, model: engine.models.default }));
    const pick = selectDefaultModelSelection(others, undefined, deps.context);
    if (pick.instanceId && pick.model) add(pick);
    return out;
  }

  const label = (selection: ModelSelection, from: ModelSelection) => (selection.instanceId === from.instanceId
    ? `${deps.engineName(selection.instanceId)} ${selection.model}` : deps.engineName(selection.instanceId));

  return {
    backups,
    /** This model alone, held by its own limit; null when it is not. */
    modelHeld,
    /** This model's own limit refused a turn: it is held until the reset the limit named, an hour when it named none,
     * and at most MODEL_HOLD_MS. */
    holdModel,
    /** Every runtime event of a bot's thread, with the model it runs on: a model's own limit holds that model. */
    noteRuntimeEvent(selection: ModelSelection | undefined, event: RuntimeEvent): void {
      if (!selection || event.type !== "runtime.error" || (event.limit !== "model" && event.limit !== "credits")) return;
      holdModel(selection, event.limit, event.limitResetsAt);
    },
    /** Once for this stretch of `from`'s limit: which AI carries on for `bot` meanwhile, or that it waits. */
    tell(bot: Bot, from: ModelSelection, facts: { resetsAt?: number; scope?: LimitScope; backup?: ModelSelection }): void {
      const scope = facts.scope ?? "engine";
      const limited = scope === "engine" ? from.instanceId : modelKey(from);
      if (!notices.first(bot.id, limited, facts.resetsAt)) return;
      deps.tell(bot, limitNoticeText({
        engine: scope === "engine" ? deps.engineName(from.instanceId) : `${deps.engineName(from.instanceId)} ${from.model}`,
        bot: bot.name, ...(facts.resetsAt ? { resetsAt: facts.resetsAt } : {}), ...(scope === "credits" ? { credits: true } : {}),
        ...(facts.backup ? { backup: label(facts.backup, from) } : {}),
      }));
    },
    /** A conversation of `botId` moved from `from` to `to` because of `from`'s limit; it goes back once that resets. */
    moved(botId: string, threadId: string, from: ModelSelection, to: ModelSelection, resetsAt?: number): void {
      deps.record({ botId, threadId, from, to, resetsAt: resetsAt ?? null, at: now() });
    },
    /** True once per bot for each stretch of this limit: the one incident its Chief is told about, not one per refused turn. */
    firstIncident(botId: string, from: ModelSelection, scope: LimitScope = "engine", resetsAt?: number): boolean {
      return notices.first(incidentKey(botId), scope === "engine" ? from.instanceId : modelKey(from), resetsAt);
    },
    /** A turn on `selection` worked for this bot: its engine's next limit is a new stretch, with a notice of its own. */
    worked(botId: string, selection: ModelSelection): void {
      for (const who of [botId, incidentKey(botId)]) {
        notices.ended(who, selection.instanceId);
        notices.ended(who, modelKey(selection));
      }
      heldModels.delete(modelKey(selection));
    },
  };
}

export type LimitTakeover = ReturnType<typeof createLimitTakeover>;
