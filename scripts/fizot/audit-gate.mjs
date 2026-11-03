#!/usr/bin/env node
/**
 * Fail the daily gate on high/critical production advisories unless each is
 * listed in security/audit-exceptions.json with a reason and a future expiry.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  highCriticalFindings,
  parseExceptions,
  unmatchedFindings,
} from "./audit-exceptions.mjs";

export {
  highCriticalFindings,
  isIsoDate,
  parseExceptions,
  unmatchedFindings,
} from "./audit-exceptions.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_EXCEPTIONS = path.join(ROOT, "security", "audit-exceptions.json");

export function evaluateAuditGate(options = {}) {
  const exceptionsPath = options.exceptionsPath ?? DEFAULT_EXCEPTIONS;
  const raw = JSON.parse(readFileSync(exceptionsPath, "utf8"));
  const exceptions = parseExceptions(raw, options.todayIso);
  const report = options.auditJson ?? runPnpmAuditJson(options.cwd ?? ROOT);
  const findings = highCriticalFindings(report);
  const unmatched = unmatchedFindings(findings, exceptions);
  return { findings, unmatched, exceptions: [...exceptions.values()] };
}

function runPnpmAuditJson(cwd) {
  // pnpm audit exits non-zero when advisories exist; stdout still carries JSON.
  const result = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["audit", "--prod", "--json"],
    { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, shell: process.platform === "win32" },
  );
  const stdout = result.stdout || "";
  const start = stdout.indexOf("{");
  if (start < 0) {
    throw new Error(`pnpm audit produced no JSON (status ${result.status}):\n${result.stderr || stdout}`);
  }
  return JSON.parse(stdout.slice(start));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    const { findings, unmatched } = evaluateAuditGate();
    if (unmatched.length === 0) {
      console.log(`audit-gate: ok (${findings.length} high/critical covered by patch or allow-list)`);
      process.exit(0);
    }
    console.error("audit-gate: high/critical advisories without a valid allow-list entry:");
    for (const finding of unmatched) {
      console.error(`- ${finding.severity} ${finding.package} ${finding.id}: ${finding.title}`);
    }
    console.error("Add a dated reason in security/audit-exceptions.json or bump the package.");
    process.exit(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
