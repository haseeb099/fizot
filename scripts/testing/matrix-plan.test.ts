import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REQUIRED = ["id", "layer", "gate", "journey_or_tc", "owner_task"] as const;
// G0 through G6, plus the week-6 checkpoint G0b.
const PLAN_GATES = ["G0", "G0b", "G1", "G2", "G3", "G4", "G5", "G6"];

// Page 06 leaves these cells without a J1–J11 or TC id. The literal "none"
// is accepted only for this list. A new row is not here, so "none" fails
// until someone adds that id on purpose.
const JOURNEY_NONE = new Set([
  "FB-U", "FB-I", "FB-E",
  "TM-U", "TM-I", "TM-E",
  "SA-U", "SA-I", "SA-E",
  "SB-U", "SB-E",
  "CS-U", "CS-I",
  "AD-U",
  "PX-U", "PX-I",
  "SW-U",
  "PL-U", "PL-I",
  "SE-U",
  "PB-U", "PB-I",
  "MR-U",
  "CL-U", "CL-I",
  "AB-U", "AB-I",
  "CI-U", "CI-I", "CI-E",
  "DA-U", "DA-I",
  "RD-I",
  "GN-I",
]);

// Page 06 has no step for G1. Gate G1 is written evidence on V1.1 (pilot
// letters, a price-floor answer, a chosen niche), not a unit, integration
// or end-to-end test. Do not add a gate here to hide a missing row.
const NOT_YET_COVERED = ["G1"];

const JOURNEY_TOKEN = /^(?:J(?:1[01]|[1-9])|TC\d+)$/;

/** RFC 4180 fields. A quoted field may contain commas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === "\"" && text[i + 1] === "\"") { field += "\""; i++; }
      else if (char === "\"") quoted = false;
      else field += char;
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }
  return rows;
}

export function matrixRows(text: string): Array<Record<string, string>> {
  const [header, ...body] = parseCsv(text);
  if (!header) return [];
  return body.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""])));
}

/** Gate tokens, with G0b kept distinct from G0. */
export function gatesIn(field: string): string[] {
  return field.match(/G0b|G[0-6]/g) ?? [];
}

export function missingRequired(row: Record<string, string>): string[] {
  return REQUIRED.filter((name) => (row[name] ?? "").trim() === "");
}

export function journeyProblems(row: Record<string, string>): string[] {
  const value = (row.journey_or_tc ?? "").trim();
  if (value === "") return ["journey_or_tc"];
  if (value === "none") return JOURNEY_NONE.has(row.id) ? [] : ["journey_or_tc"];
  const tokens = value.split(";").map((part) => part.trim()).filter((part) => part.length > 0);
  if (tokens.length === 0 || tokens.some((token) => !JOURNEY_TOKEN.test(token))) return ["journey_or_tc"];
  return [];
}

const matrix = matrixRows(readFileSync(join(ROOT, "tests", "matrix.csv"), "utf8"));

it("rejects a row missing an id, layer, gate, journey or owner task (TM-U)", () => {
  expect(matrix).toHaveLength(49);
  expect(matrix.flatMap((row) => missingRequired(row).map((field) => `${row.id || "(blank)"}:${field}`))).toEqual([]);
  expect(matrix.flatMap((row) => journeyProblems(row).map((field) => `${row.id}:${field}`))).toEqual([]);
  const blank: Record<string, string> = {
    id: "TM-U", layer: "unit", gate: "G0", journey_or_tc: "none", owner_task: "T0.4",
  };
  expect(missingRequired({ ...blank, journey_or_tc: "" })).toEqual(["journey_or_tc"]);
  expect(missingRequired({ ...blank, id: "  " })).toEqual(["id"]);
  expect(missingRequired({ ...blank, layer: "" })).toEqual(["layer"]);
  expect(missingRequired({ ...blank, gate: "" })).toEqual(["gate"]);
  expect(missingRequired({ ...blank, owner_task: "" })).toEqual(["owner_task"]);
  expect(journeyProblems({ ...blank, id: "ZZ-U", journey_or_tc: "none" })).toEqual(["journey_or_tc"]);
  expect(journeyProblems({ ...blank, id: "FB-U", journey_or_tc: "FB-U" })).toEqual(["journey_or_tc"]);
  expect(journeyProblems({ ...blank, journey_or_tc: "none" })).toEqual([]);
});

it("fails when a gate in the plan has no row (TM-I)", () => {
  const covered = new Set(matrix.flatMap((row) => gatesIn(row.gate ?? "")));
  const missing = PLAN_GATES.filter((gate) => !covered.has(gate));
  expect(missing).toEqual([...NOT_YET_COVERED]);
  for (const gate of NOT_YET_COVERED) expect(covered.has(gate)).toBe(false);
  expect(matrix.filter((row) => PLAN_GATES.every((gate) => gatesIn(row.gate ?? "").includes(gate))).map((row) => row.id)).toEqual([]);
  expect(matrix.filter((row) => row.id.startsWith("CI-")).map((row) => row.gate)).toEqual(["G0", "G0", "G0"]);
  expect(covered.has("G0b")).toBe(true);
  expect(covered.has("G3")).toBe(true);
  expect(covered.has("G6")).toBe(true);
  expect(gatesIn("G0")).toEqual(["G0"]);
  expect(gatesIn("G0b, G2")).toEqual(["G0b", "G2"]);
});
