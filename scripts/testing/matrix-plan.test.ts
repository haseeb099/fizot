import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REQUIRED = ["id", "layer", "gate", "journey_or_tc"] as const;
// G0 through G6, plus the week-6 checkpoint G0b.
const PLAN_GATES = ["G0", "G0b", "G1", "G2", "G3", "G4", "G5", "G6"];

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

const matrix = matrixRows(readFileSync(join(ROOT, "tests", "matrix.csv"), "utf8"));

it("rejects a row missing an id, layer, gate or journey (TM-U)", () => {
  expect(matrix).toHaveLength(42);
  expect(matrix.flatMap((row) => missingRequired(row).map((field) => `${row.id || "(blank)"}:${field}`))).toEqual([]);
  const blank: Record<string, string> = { id: "TM-U", layer: "unit", gate: "G0", journey_or_tc: "" };
  expect(missingRequired(blank)).toEqual(["journey_or_tc"]);
  expect(missingRequired({ ...blank, journey_or_tc: "TM-U", id: "  " })).toEqual(["id"]);
  expect(missingRequired({ ...blank, journey_or_tc: "TM-U", layer: "" })).toEqual(["layer"]);
  expect(missingRequired({ ...blank, journey_or_tc: "TM-U", gate: "" })).toEqual(["gate"]);
});

it("fails when a gate in the plan has no row (TM-I)", () => {
  const covered = new Set(matrix.flatMap((row) => gatesIn(row.gate ?? "")));
  expect(PLAN_GATES.filter((gate) => !covered.has(gate))).toEqual([]);
  expect(covered.has("G0b")).toBe(true);
  expect(gatesIn("G0")).toEqual(["G0"]);
  expect(gatesIn("G0b, G2")).toEqual(["G0b", "G2"]);
});
