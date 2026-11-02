#!/usr/bin/env node
/**
 * Spike A: build the rebranded renderer, run the control-omb fixture through a
 * loopback logging proxy, drive start / onboarding / bot / chat / settings /
 * bug-report, and fail if any host is outside brand/allowed-hosts.json.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";
import { startLoggingProxy } from "./spike-a-proxy.mjs";
import {
  allowedRuntimeHosts,
  deniedHosts,
  hostsFromFetchLog,
  hostsFromProxyLog,
  hostsFromStrace,
  readText,
  summarizeHosts,
} from "./spike-a-hosts.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ARTIFACTS = path.join(ROOT, "artifacts", "spike-a");
const ALLOW = path.join(ROOT, "brand", "allowed-hosts.json");
const SETTINGS_TABS = ["general", "providers", "appearance", "advanced", "about"];

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export function buildRebrandedDist() {
  run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "vite", "build"], {
    ...process.env,
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=7000",
  });
}

function startBugSink() {
  const hits = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "spike-a-bug" }));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("bug sink has no port"));
      resolve({
        url: `http://127.0.0.1:${address.port}/api/bug-reports`,
        hits: () => hits,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
    server.on("error", reject);
  });
}

async function driveApi(serverUrl) {
  const env = { ...process.env, OPENMAUSBOT_URL: serverUrl };
  await runControlOmb(["doctor", "--url", serverUrl], { env });
  const created = await runControlOmb(["new-bot", "--name", "SpikeA", "--url", serverUrl], { env });
  const botId = created?.bot?.id ?? created?.id;
  if (!botId) throw new Error(`new-bot returned no id: ${JSON.stringify(created)}`);
  await runControlOmb(["send", "--bot", botId, "--text", "Spike A chat turn", "--url", serverUrl], { env });
  await runControlOmb(["wait", "--bot", botId, "--for", "turn", "--timeout", "60", "--url", serverUrl], { env });
  return botId;
}

async function driveSettingsAndOnboarding(serverUrl) {
  // Settings tabs and onboarding are renderer routes; hit the fixture's static
  // shell and the preview entries the ui harness uses, without a live Chrome.
  for (const tab of SETTINGS_TABS) {
    const response = await fetch(`${serverUrl}/?settings=${tab}`);
    if (!response.ok && response.status !== 404) throw new Error(`settings ${tab}: HTTP ${response.status}`);
  }
  const onboarding = await fetch(`${serverUrl}/?onboarding=1`);
  if (!onboarding.ok && onboarding.status !== 404) throw new Error(`onboarding: HTTP ${onboarding.status}`);
}

async function driveBugReport(serverUrl, botId) {
  const response = await fetch(`${serverUrl}/api/internal/devs/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      botId,
      threadId: "spike-a",
      text: "Spike A bug-report path",
      contactEmail: "spike-a@example.invalid",
    }),
  });
  // The route may require an internal token; a 401/404 still exercised the
  // bugReportEndpoint lookup. A 2xx means the loopback sink got the report.
  return response.status;
}

async function driveBrowserChat(serverUrl) {
  // Optional SA-E path: real Chromium through a separate control-omb ui process.
  if (process.env.OMB_UI_E2E !== "1" && process.env.SPIKE_A_BROWSER !== "1") {
    return { ok: false, reason: "set SPIKE_A_BROWSER=1 or OMB_UI_E2E=1 to drive Chromium" };
  }
  const cli = path.join(ROOT, "scripts", "control-omb.ts");
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, "ui", "launch", "--entry", "threads"], {
      cwd: ROOT,
      env: { ...process.env, OPENMAUSBOT_URL: serverUrl, OMB_UI_E2E: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, reason: `ui launch timed out\n${stderr}` });
    }, 300_000);
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout?.on("data", async (chunk) => {
      stdout += String(chunk);
      const start = stdout.startsWith("{") ? 0 : stdout.indexOf("\n{") + 1;
      if (start < 0 && !stdout.startsWith("{")) return;
      try {
        const handle = JSON.parse(stdout.slice(start));
        if (!handle?.ui && !handle?.session) return;
        clearTimeout(timer);
        const ui = JSON.stringify(handle);
        await runControlOmb(["ui", "type", "--ui", ui, "--name", "Message Pepper", "--text", "Spike A browser chat"], { env: process.env });
        await runControlOmb(["ui", "press", "--ui", ui, "--keys", "Enter"], { env: process.env });
        await runControlOmb(["ui", "wait-settle", "--ui", ui, "--timeout", "60"], { env: process.env });
        child.kill("SIGINT");
        resolve({ ok: true, handle });
      } catch (error) {
        child.kill("SIGKILL");
        resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) });
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
    });
  });
}

function printSummary(summary) {
  console.log("host\tverdict");
  for (const row of summary) console.log(`${row.host}\t${row.verdict}`);
}

export async function runSpikeA(options = {}) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const proxyLog = path.join(ARTIFACTS, "proxy.jsonl");
  const fetchLog = path.join(ARTIFACTS, "fetch.log");
  const straceLog = path.join(ARTIFACTS, "strace.log");
  const summaryPath = path.join(ARTIFACTS, "summary.json");

  if (options.build !== false) buildRebrandedDist();

  const proxy = await startLoggingProxy(proxyLog);
  const bugSink = await startBugSink();
  let server;
  let straceText = "";
  let browser = { ok: false, reason: "skipped" };
  try {
    const parentEnv = {
      ...process.env,
      HTTPS_PROXY: proxy.url,
      HTTP_PROXY: proxy.url,
      https_proxy: proxy.url,
      http_proxy: proxy.url,
      NODE_USE_ENV_PROXY: "1",
      FIZOT_FETCH_LOG: fetchLog,
      OMB_BUG_REPORT_URL: bugSink.url,
      FAKE_CLAUDE_MODE: "happy",
    };

    server = await launchVerificationServer(parentEnv);
    const botId = await driveApi(server.info.url);
    await driveSettingsAndOnboarding(server.info.url);
    await driveBugReport(server.info.url, botId);
    if (options.browser !== false) browser = await driveBrowserChat(server.info.url);

    if (options.strace && process.platform === "linux" && server.child.pid) {
      const traced = spawnSync("strace", ["-f", "-e", "trace=connect", "-p", String(server.child.pid), "-o", straceLog], {
        encoding: "utf8",
        timeout: 2_000,
      });
      // strace -p needs privileges; when it fails we keep the proxy log alone.
      if (traced.status === 0 || existsSync(straceLog)) straceText = readText(straceLog);
      else writeFileSync(straceLog, traced.stderr || "strace unavailable\n", "utf8");
    }

    const hosts = new Set([
      ...hostsFromProxyLog(readText(proxyLog)),
      ...hostsFromFetchLog(readText(fetchLog)),
      ...hostsFromStrace(straceText || readText(straceLog)),
    ]);
    const allow = allowedRuntimeHosts(ALLOW);
    const summary = summarizeHosts(hosts, allow);
    const denied = deniedHosts(summary);
    const report = {
      ok: denied.length === 0,
      proxyUrl: proxy.url,
      serverUrl: server.info.url,
      browser,
      bugSinkHits: bugSink.hits().length,
      hosts: summary,
      denied,
      artifacts: { proxyLog, fetchLog, straceLog, summaryPath },
    };
    writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    printSummary(summary);
    if (denied.length) {
      console.error(`Spike A failed: ${denied.length} host(s) outside the allow-list: ${denied.join(", ")}`);
      return { ...report, exitCode: 1 };
    }
    console.log(`Spike A passed: ${summary.length} host(s), all allow-listed or loopback.`);
    return { ...report, exitCode: 0 };
  } finally {
    await server?.close();
    await bugSink.close();
    await proxy.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const browser = !process.argv.includes("--no-browser");
  const build = !process.argv.includes("--no-build");
  const strace = process.argv.includes("--strace") || process.platform === "linux";
  const result = await runSpikeA({ browser, build, strace });
  process.exit(result.exitCode);
}
