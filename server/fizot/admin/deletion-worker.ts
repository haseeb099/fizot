/**
 * Background deletion worker: processQueue on an interval so the 24h guarantee
 * does not depend on another HTTP DELETE after a crash.
 */
import type { DeletionRunner } from "./deletion.ts";

export const DEFAULT_DELETION_WORKER_INTERVAL_MS = 60_000;

export type DeletionWorker = {
  stop(): void;
  /** Exposed for tests — runs one tick immediately. */
  tick(): Promise<void>;
  readonly running: boolean;
};

export function createDeletionWorker(input: {
  runner: DeletionRunner;
  intervalMs?: number;
  /** When false, do not start the timer (tests enable explicitly). */
  enabled?: boolean;
  onError?: (error: unknown) => void;
  /** Billing lifecycle shares this tick. Failures stay off the deletion queue. */
  onTick?: () => Promise<void>;
}): DeletionWorker {
  const intervalMs = input.intervalMs ?? DEFAULT_DELETION_WORKER_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      await input.runner.processQueue();
    } catch (error) {
      input.onError?.(error);
      console.error(`deletion_worker_error:${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await input.onTick?.();
    } catch (error) {
      input.onError?.(error);
      console.error(`billing_worker_error:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ticking = false;
    }
  }

  const worker: DeletionWorker = {
    get running() {
      return timer != null && !stopped;
    },
    tick,
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };

  if (input.enabled !== false) {
    void tick();
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    // Do not keep the process alive solely for the deletion worker.
    if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  }

  return worker;
}

/** Start worker unless NODE_ENV=test (unless FIZOT_DELETION_WORKER=1 or explicit enabled). */
export function shouldStartDeletionWorker(options: {
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
} = {}): boolean {
  if (typeof options.enabled === "boolean") return options.enabled;
  const env = options.env ?? process.env;
  if (env.FIZOT_DELETION_WORKER === "1" || env.FIZOT_DELETION_WORKER === "true") return true;
  if (env.FIZOT_DELETION_WORKER === "0" || env.FIZOT_DELETION_WORKER === "false") return false;
  return env.NODE_ENV !== "test";
}
