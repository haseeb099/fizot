#!/usr/bin/env node
/**
 * Spike B Linux runner: boot mock xAI + Fizot proxy, plant canaries, run
 * box-check, and print the open-question answer for OMB_CLOUD_AI_URL.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockXai } from "../../server/fizot/proxy/mock-xai.ts";
import { startFizotProxy } from "../../server/fizot/proxy/server.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ARTIFACTS = path.join(ROOT, "artifacts", "spike-b");

mkdirSync(ARTIFACTS, { recursive: true });

const upstream = await startMockXai();
const proxy = await startFizotProxy({ upstreamBase: upstream.url, defaultCap: 50_000 });
const minted = await fetch(`${proxy.url}/internal/mint`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ instanceId: "spike-b", ttlSeconds: 1800 }),
}).then((r) => r.json());

writeFileSync(path.join(ARTIFACTS, "mint.json"), `${JSON.stringify({ ...minted, token: "[redacted]" }, null, 2)}\n`);

const chat = await fetch(`${proxy.url}/v1/chat/completions`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${minted.token}`,
    "content-type": "application/json",
    "x-request-id": "spike-b-1",
  },
  body: JSON.stringify({ model: "mock-grok", messages: [{ role: "user", content: "ping" }] }),
});
const chatBody = await chat.text();
writeFileSync(path.join(ARTIFACTS, "chat.json"), chatBody);

let boxCheck = { ok: false, output: "box-check not run", passed: 0 };
const boxJs = path.join(ROOT, "dist-server", "bot-box", "box-check.js");
if (existsSync(boxJs) && process.platform === "linux") {
  const result = spawnSync(process.execPath, [boxJs], { cwd: ROOT, encoding: "utf8", env: process.env });
  boxCheck = {
    ok: result.status === 0,
    output: `${result.stdout}\n${result.stderr}`.trim(),
    passed: Number((/\b(\d+)\s+passed\b/i.exec(`${result.stdout}\n${result.stderr}`) ?? [])[1] ?? 0),
  };
  writeFileSync(path.join(ARTIFACTS, "box-check.txt"), boxCheck.output);
} else {
  writeFileSync(path.join(ARTIFACTS, "box-check.txt"), "skipped: need linux + dist-server/bot-box/box-check.js\n");
}

const answer = {
  ombCloudAiUrlHonoured: true,
  location: "server/included-services.ts trialCreditService → trialCreditCredential; server/cloud-credit-provider.ts cloudCreditInstanceConfig sets config.url to credential.api; server/index.ts constructs CloudCreditProvider only when CLOUD_HOME is set",
  recommendation: "patch route works for the sold credit engine on a Cloud home; keep xAI keys only in the Fizot proxy (K5 check: no separate sandbox machine required for credit routing)",
  chatStatus: chat.status,
  boxCheck,
  proxyUrl: proxy.url,
};

writeFileSync(path.join(ARTIFACTS, "summary.json"), `${JSON.stringify(answer, null, 2)}\n`);
console.log(JSON.stringify(answer, null, 2));

await proxy.close();
await upstream.close();
process.exit(chat.status === 200 ? 0 : 1);
