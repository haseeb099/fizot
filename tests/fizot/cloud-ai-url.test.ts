import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("OMB_CLOUD_AI_URL honour (Spike B open question)", () => {
  it("yes: CloudCreditProvider uses credential.api from OMB_CLOUD_AI_URL on a Cloud home", () => {
    const included = readFileSync(path.join(ROOT, "server", "included-services.ts"), "utf8");
    const provider = readFileSync(path.join(ROOT, "server", "cloud-credit-provider.ts"), "utf8");
    const index = readFileSync(path.join(ROOT, "server", "index.ts"), "utf8");
    expect(included).toContain("OMB_CLOUD_AI_URL");
    expect(included).toContain("trialCreditService");
    expect(provider).toContain("url: credential.api");
    expect(index).toContain("CLOUD_HOME ? new CloudCreditProvider");
    expect(index).toContain("trialCreditCredential()");
  });
});
