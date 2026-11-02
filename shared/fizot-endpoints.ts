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

function readEndpoints(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    // The packaged-server smoke copies the bundle without brand/endpoints.json. A missing file is the empty config.
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function fizotEndpoints(): Record<FizotEndpointKey, string> {
  const parsed = readEndpoints();
  return Object.fromEntries(FIZOT_ENDPOINT_KEYS.map((key) => [key, typeof parsed[key] === "string" ? parsed[key].trim() : ""])) as Record<FizotEndpointKey, string>;
}

export function fizotEndpoint(key: FizotEndpointKey): string {
  return fizotEndpoints()[key];
}
