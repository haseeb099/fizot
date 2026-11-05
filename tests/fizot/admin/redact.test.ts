import { expect, it } from "vitest";
import { redactForLog, safeLogLine, mintBootstrapSecret } from "../../../server/fizot/admin/public.ts";

it("never logs bootstrap secrets or pairing credentials", () => {
  const secret = mintBootstrapSecret();
  const redacted = redactForLog({
    OMB_CLOUD_BOOTSTRAP_SECRET: secret,
    bootstrapSecret: secret,
    credential: "omb_pair_abcdefghijklmnop",
    nested: { token: secret, ok: true },
    signature: `v1=${secret}`,
  }) as Record<string, unknown>;
  const dump = JSON.stringify(redacted);
  expect(dump).not.toContain(secret);
  expect(dump).not.toContain("omb_pair_abcdefghijklmnop");
  expect(redacted.OMB_CLOUD_BOOTSTRAP_SECRET).toBe("[redacted]");
  expect(redacted.bootstrapSecret).toBe("[redacted]");
  expect((redacted.nested as { token: string }).token).toBe("[redacted]");
  expect(safeLogLine("admin", { bootstrapSecret: secret })).not.toContain(secret);
});

it("never logs private-chat content fields", () => {
  const redacted = redactForLog({
    privateChat: "Ada's interview notes",
    threadBody: "salary expectations",
    messages: [{ text: "keep this private" }],
    messageText: "secret",
    aboutMe: "personal bio",
    ok: true,
  }) as Record<string, unknown>;
  const dump = JSON.stringify(redacted);
  expect(dump).not.toContain("interview");
  expect(dump).not.toContain("salary");
  expect(dump).not.toContain("keep this private");
  expect(redacted.privateChat).toBe("[redacted]");
  expect(redacted.messages).toBe("[redacted]");
  expect(redacted.ok).toBe(true);
});
