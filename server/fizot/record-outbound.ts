import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** When FIZOT_FETCH_LOG is a file path, record each outbound fetch URL. Unset, this is a no-op. */
export function installFetchRecord(): void {
  const file = process.env.FIZOT_FETCH_LOG?.trim();
  if (!file || (globalThis.fetch as { fizotRecord?: boolean }).fizotRecord) return;
  const original = globalThis.fetch;
  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? input.url : String(input);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${url}\n`);
    return original(input, init);
  }) as typeof fetch;
  (wrapped as { fizotRecord?: boolean }).fizotRecord = true;
  globalThis.fetch = wrapped;
}
