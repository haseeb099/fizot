/**
 * Spike A negative control: one CONNECT to a non-allow-listed host must be denied.
 * Kept separate from spike-a.mjs so vitest can import it without loading control-omb.ts.
 */
import { request as httpRequest } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLoggingProxy } from "./spike-a-proxy.mjs";
import {
  allowedRuntimeHosts,
  deniedHosts,
  hostsFromProxyLog,
  readText,
  summarizeHosts,
} from "./spike-a-hosts.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ARTIFACTS = path.join(ROOT, "artifacts", "spike-a");
const ALLOW = path.join(ROOT, "brand", "allowed-hosts.json");

export async function runNegativeControl(options = {}) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const proxyLog = path.join(ARTIFACTS, "negative-proxy.jsonl");
  const host = options.host ?? "example.invalid";
  const proxy = await startLoggingProxy(proxyLog);
  try {
    await new Promise((resolve) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: Number(new URL(proxy.url).port),
        method: "CONNECT",
        path: `${host}:443`,
      });
      req.on("connect", (_res, socket) => { socket.end(); resolve(undefined); });
      req.on("error", () => resolve(undefined));
      req.setTimeout(3_000, () => { req.destroy(); resolve(undefined); });
      req.end();
    });
    const hosts = new Set(hostsFromProxyLog(readText(proxyLog)));
    const allow = allowedRuntimeHosts(ALLOW);
    const summary = summarizeHosts(hosts, allow);
    const denied = deniedHosts(summary);
    const named = denied.includes(host.toLowerCase());
    const report = { ok: named, host, denied, summary, proveFail: named };
    writeFileSync(path.join(ARTIFACTS, "negative-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log("host\tverdict");
    for (const row of summary) console.log(`${row.host}\t${row.verdict}`);
    if (!named) {
      console.error(`Spike A negative control failed: expected deny for ${host}, got denied=[${denied.join(", ")}]`);
      return { ...report, exitCode: 2 };
    }
    console.log(`Spike A negative control: capture named ${host} — spike would FAIL (exit 1).`);
    return { ...report, exitCode: 1 };
  } finally {
    await proxy.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  Promise.resolve().then(async () => {
    const result = await runNegativeControl({});
    process.exit(result.exitCode);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
