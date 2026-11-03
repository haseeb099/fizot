import { readFileSync } from "node:fs";
import { loadAllowList } from "./scan-upstream-hosts.mjs";
import { hostKey } from "./scan-text.mjs";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

/** Hosts the spike may contact without failing: allow-list entries plus loopback. */
export function allowedRuntimeHosts(allowListPath) {
  const listed = loadAllowList(allowListPath)
    .map((entry) => entry.host)
    .filter((host) => typeof host === "string" && host.length > 0)
    .map((host) => host.toLowerCase());
  return new Set([...listed, ...LOOPBACK]);
}

/** Hostnames recorded in the proxy JSONL log. */
export function hostsFromProxyLog(text) {
  const hosts = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (typeof row.host === "string" && row.host) hosts.add(row.host.toLowerCase());
    } catch {
      /* ignore malformed */
    }
  }
  return [...hosts].sort();
}

/** Hostnames recorded by FIZOT_FETCH_LOG (one URL per line). */
export function hostsFromFetchLog(text) {
  const hosts = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      hosts.add(hostKey(line).toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return [...hosts].sort();
}

/** Parse `strace -e connect` lines for sockaddr hostnames and IPv4 dotted quads. */
export function hostsFromStrace(text) {
  const hosts = new Set();
  for (const match of text.matchAll(/sin_addr=inet_addr\("([^"]+)"\)/g)) hosts.add(match[1].toLowerCase());
  for (const match of text.matchAll(/\{sa_family=AF_INET,\s*sin_port=htons\(\d+\),\s*sin_addr=inet_addr\("([^"]+)"\)\}/g)) {
    hosts.add(match[1].toLowerCase());
  }
  // Node may resolve and connect by name in some builds; keep dotted quads from connect().
  for (const match of text.matchAll(/connect\(\d+,\s*\{[^}]*sin_addr=inet_addr\("([^"]+)"\)/g)) hosts.add(match[1].toLowerCase());
  return [...hosts].sort();
}

/** Chrome for Testing / agent-browser bootstrap hosts — not the rebranded app. */
export function isHarnessHost(host) {
  const h = host.toLowerCase();
  if (LOOPBACK.has(h)) return false;
  return (
    h === "github.com"
    || h.endsWith(".githubusercontent.com")
    || h.endsWith(".google.com")
    || h.endsWith(".googleapis.com")
    || h.endsWith(".gvt1.com")
    || h.endsWith(".googleusercontent.com")
  );
}

export function summarizeHosts(hosts, allow) {
  return [...hosts].sort().map((host) => ({
    host,
    verdict: allow.has(host) || LOOPBACK.has(host) ? "allow" : isHarnessHost(host) ? "harness" : "deny",
  }));
}

export function deniedHosts(summary) {
  return summary.filter((row) => row.verdict === "deny").map((row) => row.host);
}

export function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
