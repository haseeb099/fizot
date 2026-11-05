import { expect, it } from "vitest";
import {
  WORKSPACE_STATES,
  assertTransition,
  mayTransition,
} from "../../../server/fizot/admin/public.ts";

it("state machine transition table: requested→creating→ready→sleeping|awake→deleting→deleted|failed", () => {
  expect(WORKSPACE_STATES).toEqual([
    "requested", "creating", "ready", "awake", "sleeping", "deleting", "deleted", "failed",
  ]);

  const allowed: Array<[string, string]> = [
    ["requested", "creating"],
    ["creating", "ready"],
    ["ready", "awake"],
    ["ready", "sleeping"],
    ["awake", "sleeping"],
    ["sleeping", "awake"],
    ["ready", "deleting"],
    ["deleting", "deleted"],
    ["deleting", "failed"],
    ["creating", "failed"],
    ["failed", "creating"],
    ["failed", "deleting"],
  ];
  for (const [from, to] of allowed) {
    expect(mayTransition(from as never, to as never), `${from}->${to}`).toBe(true);
  }

  expect(mayTransition("deleted", "ready")).toBe(false);
  expect(mayTransition("ready", "requested")).toBe(false);
  expect(() => assertTransition("deleted", "creating", "nope")).toThrow(/illegal_transition/);
});
