#!/usr/bin/env node
/**
 * Spike A: build the rebranded renderer, run the control-omb fixture through a
 * loopback logging proxy under strace, drive the real renderer (onboarding,
 * Settings tabs, one chat), and fail if any host is outside brand/allowed-hosts.json.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
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
/** Simple-mode Settings pages a fixture browser can open. */
const SETTINGS_TABS = ["General", "AI", "Computer", "Billing", "Updates"];
const LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";

export function buildRebrandedDist() {
  const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "vite", "build"], {
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=7000" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`vite build failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
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

async function driveApi(serverUrl, env) {
  await runControlOmb(["doctor", "--url", serverUrl], { env });
  const created = await runControlOmb(["new-bot", "--name", "SpikeA", "--url", serverUrl], { env });
  const botId = created?.bot?.id ?? created?.id;
  if (!botId) throw new Error(`new-bot returned no id: ${JSON.stringify(created)}`);
  await runControlOmb(["send", "--bot", botId, "--text", "Spike A chat turn", "--url", serverUrl], { env });
  await runControlOmb(["wait", "--bot", botId, "--for", "turn", "--timeout", "60", "--url", serverUrl], { env });
  return botId;
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
  return response.status;
}

/**
 * Launch one control-omb ui fixture (server + Chrome) under the capture env,
 * drive onboarding, Settings tabs and one chat, then stop the ui process.
 */
async function driveBrowserCapture(parentEnv) {
  const cli = path.join(ROOT, "scripts", "control-omb.ts");
  return await new Promise((resolve) => {
    let settled = false;
    let driving = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, "ui", "launch", "--entry", "threads"], {
      cwd: ROOT,
      env: {
        ...parentEnv,
        OMB_UI_E2E: "1",
        // Vite preview and fixture API stay on loopback; never send them through the CONNECT proxy.
        NO_PROXY: LOOPBACK_NO_PROXY,
        no_proxy: LOOPBACK_NO_PROXY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: `ui launch timed out\n${stderr}` });
    }, 300_000);
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout?.on("data", async (chunk) => {
      if (settled || driving) return;
      stdout += String(chunk);
      const start = stdout.indexOf("{");
      if (start < 0) return;
      let handle;
      try {
        handle = JSON.parse(stdout.slice(start));
      } catch {
        return;
      }
      if (!handle?.ui) return;
      driving = true;
      const ui = JSON.stringify(handle);
      const env = {
        ...parentEnv,
        OMB_UI_E2E: "1",
        OPENMAUSBOT_URL: handle.url,
        NO_PROXY: LOOPBACK_NO_PROXY,
        no_proxy: LOOPBACK_NO_PROXY,
      };
      try {
        const botId = handle.botId ?? await driveApi(handle.url, env);
        await driveBugReport(handle.url, botId);

        await runControlOmb(["ui", "eval", "--ui", ui, "--js",
          "localStorage.clear(); sessionStorage.clear(); localStorage.setItem('omb-advanced-mode','1'); setTimeout(() => { location.search = '?onboarding=1'; }, 0); true"], { env });
        await runControlOmb(["ui", "wait-settle", "--ui", ui, "--timeout", "45"], { env });

        await runControlOmb(["ui", "eval", "--ui", ui, "--js",
          "setTimeout(() => { location.search = ''; }, 0); true"], { env });
        await runControlOmb(["ui", "wait-settle", "--ui", ui, "--timeout", "45"], { env });

        for (const tab of SETTINGS_TABS) {
          await runControlOmb(["ui", "eval", "--ui", ui, "--js",
            "(() => { const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Settings'); if (btn) btn.click(); return true; })()"], { env });
          await runControlOmb(["ui", "wait-settle", "--ui", ui, "--timeout", "20"], { env });
          await runControlOmb(["ui", "eval", "--ui", ui, "--js",
            `(() => { const btn = [...document.querySelectorAll('button,[role=tab]')].find(b => (b.textContent || '').trim() === ${JSON.stringify(tab)}); if (btn) btn.click(); return ${JSON.stringify(tab)}; })()`], { env });
          await runControlOmb(["ui", "wait-settle", "--ui", ui, "--timeout", "20"], { env });
        }

        await runControlOmb(["ui", "press", "--ui", ui, "--keys", "Escape"], { env }).catch(() => {});
        await runControlOmb(["ui", "type", "--ui", ui, "--name", "Message Pepper", "--text", "Spike A browser chat"], { env });
        await runControlOmb(["ui", "press", "--ui", ui, "--keys", "Enter"], { env });
        await runControlOmb(["ui", "wait-settle", "--ui", ui, "--timeout", "60"], { env });
        child.kill("SIGINT");
        finish({ ok: true, handle, settingsTabs: SETTINGS_TABS, serverUrl: handle.url, botId });
      } catch (error) {
        child.kill("SIGKILL");
        finish({ ok: false, reason: error instanceof Error ? error.message : String(error), stderr, serverUrl: handle.url });
      }
    });
    child.on("exit", () => {
      if (!driving) finish({ ok: false, reason: `ui exited before a handle\n${stderr}\n${stdout}` });
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
  let browser = { ok: false, reason: "skipped" };
  let serverUrl = "";
  try {
    const parentEnv = {
      ...process.env,
      HTTPS_PROXY: proxy.url,
      HTTP_PROXY: proxy.url,
      https_proxy: proxy.url,
      http_proxy: proxy.url,
      NODE_USE_ENV_PROXY: "1",
      NO_PROXY: LOOPBACK_NO_PROXY,
      no_proxy: LOOPBACK_NO_PROXY,
      FIZOT_FETCH_LOG: fetchLog,
      OMB_BUG_REPORT_URL: bugSink.url,
      FAKE_CLAUDE_MODE: "happy",
      ...(options.strace && process.platform === "linux" ? { OMB_VERIFY_STRACE_LOG: straceLog } : {}),
    };

    const requireBrowser = options.browser !== false && (process.env.SPIKE_A_BROWSER === "1" || process.env.OMB_UI_E2E === "1");
    if (requireBrowser) {
      browser = await driveBrowserCapture(parentEnv);
      serverUrl = browser.serverUrl ?? "";
    } else {
      server = await launchVerificationServer(parentEnv);
      serverUrl = server.info.url;
      const botId = await driveApi(serverUrl, { ...process.env, OPENMAUSBOT_URL: serverUrl });
      await driveBugReport(serverUrl, botId);
      if (options.browser !== false) browser = await driveBrowserCapture(parentEnv);
    }

    const hosts = new Set([
      ...hostsFromProxyLog(readText(proxyLog)),
      ...hostsFromFetchLog(readText(fetchLog)),
      ...hostsFromStrace(readText(straceLog)),
    ]);
    const allow = allowedRuntimeHosts(ALLOW);
    const summary = summarizeHosts(hosts, allow);
    const denied = deniedHosts(summary);
    const exitOk = denied.length === 0 && (!requireBrowser || browser.ok === true);
    const report = {
      ok: exitOk,
      proxyUrl: proxy.url,
      serverUrl,
      browser,
      bugSinkHits: bugSink.hits().length,
      hosts: summary,
      denied,
      straceWrapped: Boolean(parentEnv.OMB_VERIFY_STRACE_LOG),
      artifacts: { proxyLog, fetchLog, straceLog, summaryPath },
    };
    writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    printSummary(summary);
    if (denied.length) {
      console.error(`Spike A failed: ${denied.length} host(s) outside the allow-list: ${denied.join(", ")}`);
      return { ...report, exitCode: 1 };
    }
    if (requireBrowser && browser.ok !== true) {
      console.error(`Spike A failed: browser drive did not succeed: ${browser.reason ?? "unknown"}`);
      return { ...report, exitCode: 1 };
    }
    console.log(`Spike A passed: ${summary.length} host(s), all allow-listed or loopback; browser=${browser.ok}.`);
    return { ...report, exitCode: 0 };
  } finally {
    await server?.close();
    await bugSink.close();
    await proxy.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  Promise.resolve().then(async () => {
    const browser = !process.argv.includes("--no-browser");
    const build = !process.argv.includes("--no-build");
    const strace = process.argv.includes("--strace") || process.platform === "linux";
    const result = await runSpikeA({ browser, build, strace });
    process.exit(result.exitCode);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
