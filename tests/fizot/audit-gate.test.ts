import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  highCriticalFindings,
  parseExceptions,
  unmatchedFindings,
} from "../../scripts/fizot/audit-exceptions.mjs";

let scratch = "";

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

it("requires reason and YYYY-MM-DD expiry on every exception", () => {
  expect(() => parseExceptions({ exceptions: [{ id: "GHSA-xxxx", reason: "", expiry: "2026-12-01" }] }, "2026-11-03"))
    .toThrow(/reason/i);
  expect(() => parseExceptions({ exceptions: [{ id: "GHSA-xxxx", reason: "ok", expiry: "not-a-date" }] }, "2026-11-03"))
    .toThrow(/expiry/i);
  expect(() => parseExceptions({ exceptions: [{ id: "GHSA-xxxx", reason: "ok", expiry: "2026-01-01" }] }, "2026-11-03"))
    .toThrow(/expired/i);
  const active = parseExceptions({
    exceptions: [{ id: "GHSA-xxxx-yyyy-zzzz", package: "undici", reason: "awaiting upstream pin", expiry: "2026-12-31" }],
  }, "2026-11-03");
  expect(active.get("GHSA-xxxx-yyyy-zzzz")?.reason).toMatch(/awaiting/);
});

it("fails when a high advisory is not allow-listed", () => {
  const findings = highCriticalFindings({
    advisories: {
      "1": {
        id: 1,
        github_advisory_id: "GHSA-seed-vuln-test",
        module_name: "seed-vuln",
        severity: "high",
        title: "seeded vulnerable dependency",
      },
    },
  });
  expect(findings).toEqual([
    { id: "GHSA-seed-vuln-test", severity: "high", package: "seed-vuln", title: "seeded vulnerable dependency" },
  ]);
  expect(unmatchedFindings(findings, new Map())).toHaveLength(1);
});

it("passes when the high advisory is allow-listed with reason and expiry", () => {
  scratch = join(tmpdir(), `audit-gate-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });
  const exceptionsPath = join(scratch, "exceptions.json");
  writeFileSync(exceptionsPath, JSON.stringify({
    exceptions: [{
      id: "GHSA-seed-vuln-test",
      package: "seed-vuln",
      reason: "fixture only; proves the gate honouring allow-list",
      expiry: "2099-01-01",
    }],
  }), "utf8");
  const exceptions = parseExceptions(JSON.parse(readFileSync(exceptionsPath, "utf8")), "2026-11-03");
  const findings = highCriticalFindings({
    advisories: {
      "1": {
        github_advisory_id: "GHSA-seed-vuln-test",
        module_name: "seed-vuln",
        severity: "high",
        title: "seeded vulnerable dependency",
      },
    },
  });
  expect(unmatchedFindings(findings, exceptions)).toEqual([]);
  expect(findings).toHaveLength(1);
});

it("ignores low and moderate findings for the gate", () => {
  const findings = highCriticalFindings({
    advisories: {
      "1": { github_advisory_id: "GHSA-low", module_name: "katex", severity: "low", title: "low" },
      "2": { github_advisory_id: "GHSA-mod", module_name: "undici", severity: "moderate", title: "mod" },
    },
  });
  expect(findings).toEqual([]);
});
