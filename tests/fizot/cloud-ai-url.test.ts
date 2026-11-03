import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cloudPairingSignature } from "../../server/cloud-home.ts";
import { CLOUD_CREDIT_INSTANCE } from "../../server/cloud-credit-provider.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { freePortBlock } from "../../server/testing/ports.ts";
import { startMockXai, type MockXai } from "../../server/fizot/proxy/mock-xai.ts";
import { startFizotProxy, type FizotProxy } from "../../server/fizot/proxy/server.ts";

const SERVER_DIR = dirname(fileURLToPath(new URL("../../server/index.ts", import.meta.url)));
const ROOT = join(SERVER_DIR, "..");
const HOST = "omb-t-0123456789ab.fly.dev";

describe("OMB_CLOUD_AI_URL honour (Spike B open question)", () => {
  it("yes in source: CloudCreditProvider uses credential.api from OMB_CLOUD_AI_URL on a Cloud home", () => {
    const included = readFileSync(join(ROOT, "server", "included-services.ts"), "utf8");
    const provider = readFileSync(join(ROOT, "server", "cloud-credit-provider.ts"), "utf8");
    const index = readFileSync(join(ROOT, "server", "index.ts"), "utf8");
    expect(included).toContain("OMB_CLOUD_AI_URL");
    expect(included).toContain("trialCreditService");
    expect(provider).toContain("url: credential.api");
    expect(index).toContain("CLOUD_HOME ? new CloudCreditProvider");
    expect(index).toContain("trialCreditCredential()");
  });
});

describe("OMB_CLOUD_AI_URL measured through Fizot proxy ledger", () => {
  let upstream: MockXai | undefined;
  let proxy: FizotProxy | undefined;
  let child: ChildProcess | undefined;
  let home = "";

  afterEach(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    child = undefined;
    await proxy?.close();
    await upstream?.close();
    proxy = undefined;
    upstream = undefined;
    if (home) await removeTempDir(home);
    home = "";
  });

  it("records exactly one ledger entry when a Cloud home chats through the proxy", async () => {
    upstream = await startMockXai();
    proxy = await startFizotProxy({ upstreamBase: upstream.url, defaultCap: 50_000 });
    const secret = randomBytes(32).toString("base64url");
    const minted = await fetch(`${proxy.url}/internal/mint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: CLOUD_CREDIT_INSTANCE, ttlSeconds: 1800 }),
    }).then((r) => r.json()) as { token: string };
    expect(minted.token.startsWith("omb_ai_")).toBe(true);

    const port = await freePortBlock([0, 1]);
    home = mkdtempSync(join(tmpdir(), "spike-b-cloud-"));
    const data = join(home, ".openmausbot");
    mkdirSync(data, { recursive: true });
    mkdirSync(join(home, "web"));
    writeFileSync(join(home, "web", "index.html"), "<!doctype html><title>Fizot</title>");
    const cli = join(home, "fixture-claude.mjs");
    writeFileSync(cli, `#!/usr/bin/env node
process.env.FAKE_CLAUDE_AUTH = "inherited-api-key";
process.env.FAKE_CLAUDE_EXIT_AFTER_TURN = "1";
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: {
        ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
        claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
      },
    }));

    const relayUrl = `${proxy.url}/v1`;
    let log = "";
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_DATA_DIR: data,
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
        OMB_STATIC_DIR: join(home, "web"),
        OMB_CLOUD_ROLE: "home",
        OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93",
        OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
        OMB_CLOUD_BOOTSTRAP_SECRET: secret,
        OMB_PUBLIC_URL: `https://${HOST}`,
        OMB_CLOUD_AI_URL: relayUrl,
        OMB_CLOUD_AI_TOKEN: minted.token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { log += chunk; });
    child.stderr?.on("data", (chunk) => { log += chunk; });

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Cloud home exited:\n${log}`);
      try {
        const health = await fetch(`${base}/api/health`);
        if (health.ok) break;
      } catch { /* retry */ }
      if (Date.now() > deadline) throw new Error(`Cloud home did not start:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const pairBody = JSON.stringify({ label: "Spike B Cloud", ttlSeconds: 300 });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("base64url");
    const granted = await fetch(`${base}/api/cloud/pairing`, {
      method: "POST",
      headers: {
        host: HOST,
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-proto": "https",
        "content-type": "application/json",
        "x-omb-cloud-timestamp": timestamp,
        "x-omb-cloud-nonce": nonce,
        "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, pairBody)}`,
      },
      body: pairBody,
    }).then((r) => r.json()) as { code: string };
    const ownerToken = (await fetch(`${base}/api/auth/pair`, {
      method: "POST",
      headers: {
        host: HOST,
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-proto": "https",
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: granted.code }),
    }).then((r) => r.json()) as { token: string }).token;

    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          host: HOST,
          "x-forwarded-for": "203.0.113.9",
          "x-forwarded-proto": "https",
          authorization: `Bearer ${ownerToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };

    const bots = (await api("GET", "/api/bots?messages=20")).body.bots as Array<{ id: string; busy?: boolean; messages: unknown[] }>;
    const bot = bots[0]!;
    const before = bot.messages.length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "spike-b honour ping" })).status).toBe(202);
    const settleDeadline = Date.now() + 25_000;
    for (;;) {
      const settled = ((await api("GET", "/api/bots?messages=20")).body.bots as typeof bots).find((entry) => entry.id === bot.id)!;
      if (!settled.busy && settled.messages.length > before + 1) break;
      if (Date.now() > settleDeadline) throw new Error(`chat did not settle:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const entries = proxy.ledger.entries().filter((entry) => entry.instanceId === CLOUD_CREDIT_INSTANCE);
    expect(entries.length).toBe(1);
    mkdirSync(join(ROOT, "artifacts", "spike-b"), { recursive: true });
    writeFileSync(join(ROOT, "artifacts", "spike-b", "honour.json"), `${JSON.stringify({
      ombCloudAiUrlHonoured: true,
      ledgerEntries: entries.length,
      instanceId: CLOUD_CREDIT_INSTANCE,
    }, null, 2)}\n`);
  }, 90_000);
});
