import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIZOT_ENDPOINT_KEYS = [
  "bugReportUrl",
  "updateReleaseUrl",
  "analyticsHost",
  "docsUrl",
  "siteUrl",
  "cloudOrigin",
  "stagingCloudOrigin",
  "accountsOrigin",
  "adminOrigin",
  "deviceOrigin",
  "boatApiOrigin",
  "repositoryUrl",
] as const;

export type FizotEndpointKey = (typeof FIZOT_ENDPOINT_KEYS)[number];

const file = join(dirname(fileURLToPath(import.meta.url)), "../brand/endpoints.json");

export function fizotEndpoints(): Record<FizotEndpointKey, string> {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return Object.fromEntries(FIZOT_ENDPOINT_KEYS.map((key) => [key, typeof parsed[key] === "string" ? parsed[key].trim() : ""])) as Record<FizotEndpointKey, string>;
}

export function fizotEndpoint(key: FizotEndpointKey): string {
  return fizotEndpoints()[key];
}
