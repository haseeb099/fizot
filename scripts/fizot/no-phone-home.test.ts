import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../control-omb.ts";
import { loadAllowList, matchesUpstreamHost } from "./scan-upstream-hosts.mjs";
import { hostKey } from "./scan-text.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
let server: VerificationServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

it("a clean server makes no request to an upstream host", async () => {
  const log = path.join(mkdtempSync(path.join(tmpdir(), "fizot-fetch-")), "outbound.txt");
  server = await launchVerificationServer({ ...process.env, FIZOT_FETCH_LOG: log });
  const health = await fetch(`${server.info.url}/api/health`);
  expect(health.ok).toBe(true);
  const text = existsSync(log) ? readFileSync(log, "utf8") : "";
  const listed = new Set(
    loadAllowList(path.join(root, "brand", "allowed-hosts.json"))
      .map((entry: { host?: string }) => entry.host)
      .filter((host: string | undefined): host is string => Boolean(host)),
  );
  const offenders = text.split("\n").filter((line) => line.length > 0 && (matchesUpstreamHost(line) || listed.has(hostKey(line))));
  expect(offenders).toEqual([]);
}, 90_000);
