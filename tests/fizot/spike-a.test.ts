import { createServer } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyBrandText, loadBrandMap } from "../../scripts/fizot/apply-brand.mjs";
import {
  allowedRuntimeHosts,
  deniedHosts,
  hostsFromFetchLog,
  hostsFromProxyLog,
  summarizeHosts,
} from "../../scripts/fizot/spike-a-hosts.mjs";
import { startLoggingProxy } from "../../scripts/fizot/spike-a-proxy.mjs";
import { runNegativeControl } from "../../scripts/fizot/spike-a-negative.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("Spike A brand map (SA-U)", () => {
  it("covers every string the build reads from the brand map and endpoints", () => {
    const map = loadBrandMap(path.join(ROOT, "brand", "brand-map.json"));
    const endpoints = JSON.parse(readFileSync(path.join(ROOT, "brand", "endpoints.json"), "utf8"));
    const sources = [
      ...map.replace.map((row) => row[0]),
      map.productName,
      ...Object.values(map.mascotLabels || {}),
      ...Object.values(endpoints),
    ].filter((value) => typeof value === "string" && value.length > 0);
    const out = applyBrandText(sources.map((value) => "see " + value).join("\n"), map.replace, "index.html");
    for (const [from] of map.replace) expect(out.includes(from)).toBe(false);
    expect(map.productName).toBe("Fizot");
  });
});

describe("Spike A host capture (SA-I)", () => {
  it("accepts only allow-listed and loopback hosts from a capture log", () => {
    const allow = allowedRuntimeHosts(path.join(ROOT, "brand", "allowed-hosts.json"));
    const proxyHosts = hostsFromProxyLog([
      JSON.stringify({ kind: "connect", host: "127.0.0.1" }),
      JSON.stringify({ kind: "connect", host: "fixture.openmausbot.com" }),
      JSON.stringify({ kind: "connect", host: "api.x.ai" }),
    ].join("\n"));
    const fetchHosts = hostsFromFetchLog("http://127.0.0.1:9/api/bug-reports\nhttps://posthog.com/e\n");
    const summary = summarizeHosts(new Set([...proxyHosts, ...fetchHosts]), allow);
    expect(deniedHosts(summary).sort()).toEqual(["api.x.ai", "posthog.com"]);
    expect(summary.find((row) => row.host === "update.googleapis.com")?.verdict).toBe("harness");
  });

  it("records CONNECT hosts through the logging proxy", async () => {
    const sink = createServer((socket) => socket.end());
    await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const sinkPort = (sink.address() as { port: number }).port;
    const logPath = path.join(mkdtempSync(path.join(tmpdir(), "spike-a-proxy-")), "proxy.jsonl");
    const proxy = await startLoggingProxy(logPath);
    try {
      await new Promise((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port: Number(new URL(proxy.url).port),
          method: "CONNECT",
          path: `127.0.0.1:${sinkPort}`,
        });
        req.on("connect", (_res, socket) => {
          socket.end();
          resolve(undefined);
        });
        req.on("error", reject);
        req.end();
      });
      expect(hostsFromProxyLog(readFileSync(logPath, "utf8"))).toContain("127.0.0.1");
    } finally {
      await proxy.close();
      await new Promise((resolve) => sink.close(resolve));
    }
  });

  it("negative control names a non-allow-listed host and fails the spike (exit 1)", async () => {
    const result = await runNegativeControl({ host: "example.invalid" });
    expect(result.denied).toContain("example.invalid");
    expect(result.exitCode).toBe(1);
    expect(result.proveFail).toBe(true);
  });
});

describe("Spike A browser chat step (SA-E)", () => {
  it("drives the real renderer via control-omb ui for onboarding, Settings and chat", () => {
    const source = readFileSync(path.join(ROOT, "scripts", "fizot", "spike-a.mjs"), "utf8");
    expect(source).toContain("SPIKE_A_BROWSER");
    expect(source).toContain("Message Pepper");
    expect(source).toContain("ui launch");
    expect(source).toContain("?onboarding=1");
    expect(source).toContain("SETTINGS_TABS");
    expect(source).toContain("OMB_VERIFY_STRACE_LOG");
    const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "spike-a.yml"), "utf8");
    expect(workflow).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
    expect(workflow).toContain("spike-a-negative.mjs");
  });
});
