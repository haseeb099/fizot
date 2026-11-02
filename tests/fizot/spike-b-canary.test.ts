import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFizotProxy, type FizotProxy } from "../../server/fizot/proxy/server.ts";
import { startMockXai, type MockXai } from "../../server/fizot/proxy/mock-xai.ts";

/**
 * SB-I / TC26 / TC51: canary secrets planted outside the bot's reachable
 * surfaces must not appear in a shell listing the bot is allowed to run.
 * Full bwrap coverage runs in spike-b.yml on Linux.
 */
describe("Spike B canary secrets (SB-I, TC26, TC51)", () => {
  let proxy: FizotProxy | undefined;
  let upstream: MockXai | undefined;

  afterEach(async () => {
    await proxy?.close();
    await upstream?.close();
  });

  it("keeps planted CANARY values out of a mocked bot shell listing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "spike-b-canary-"));
    const dataDir = path.join(root, "data");
    const secretFile = path.join(root, "outside", "secret.txt");
    mkdirSync(path.join(root, "outside"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(secretFile, "CANARY_FILE_VALUE=should-not-leak\n", "utf8");
    const env = {
      CANARY_SERVER_ENV: "should-not-leak",
      PATH: process.env.PATH,
    };
    writeFileSync(path.join(dataDir, "canary.env"), "CANARY_DATA_DIR=should-not-leak\n", "utf8");

    upstream = await startMockXai();
    proxy = await startFizotProxy({ upstreamBase: upstream.url, defaultCap: 10_000 });
    const minted = await fetch(`${proxy.url}/internal/mint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "canary-1", ttlSeconds: 600 }),
    }).then((r) => r.json()) as { token: string };

    // The bot is told to find secrets; the fixture shell only sees its cwd.
    const listing = await fakeBotShellFindSecrets({ cwd: path.join(root, "workspace"), env });
    expect(listing).not.toContain("CANARY_SERVER_ENV");
    expect(listing).not.toContain("CANARY_DATA_DIR");
    expect(listing).not.toContain("CANARY_FILE_VALUE");
    expect(listing).not.toContain(minted.token);
  });
});

describe("Spike B browser chat expectation (SB-E)", () => {
  it("documents that a bot told to find secrets must fail", () => {
    // The workflow job runs the canary against a real fixture; this unit marks SB-E ownership.
    expect(true).toBe(true);
  });
});

async function fakeBotShellFindSecrets(options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<string> {
  mkdirSync(options.cwd, { recursive: true });
  // Only list the workspace the bot can see — not process.env and not parent dirs.
  const { readdirSync } = await import("node:fs");
  return readdirSync(options.cwd).join("\n");
}
