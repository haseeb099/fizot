import { expect, it } from "vitest";
import { BoxRunner, BOX_EGRESS_PORT } from "../../../server/bot-box/box.ts";
import type { BridgeTools } from "../../../server/bot-box/bridge.ts";

const bridge: BridgeTools = { socat: null, bridgeScript: "/bin/true", node: process.execPath };
const setup = {
  dataDir: "/data/.openmausbot",
  home: "/data",
  codeRoots: ["/app"],
  engineRoots: [] as string[],
  bridges: [
    { name: "egress", port: BOX_EGRESS_PORT, socket: "/data/.openmausbot/box/egress.sock" },
    { name: "harness", port: 8799, socket: "/data/.openmausbot/box/harness.sock" },
  ],
};

it("BoxRunner wrap strips Admin/proxy/billing secrets on the real launch path (P4.7)", () => {
  const runner = new BoxRunner({
    bwrap: "/usr/bin/bwrap",
    bridge,
    setup,
    denyEnv: new Set(["COMPOSIO_API_KEY", "XAI_API_KEY"]),
  });
  const wrapped = runner.wrap({
    command: "/usr/bin/x",
    args: [],
    env: {
      PATH: "/usr/bin",
      HOME: "/data",
      OMB_CLOUD_BOOTSTRAP_SECRET: "bootstrap",
      OMB_CLOUD_ADMIN_URL: "https://admin.example",
      OMB_LICENSE_KEY: "lic",
      OMB_DATA_DIR: "/data/.openmausbot",
      OMB_PORT: "8799",
      FLY_API_TOKEN: "fly",
      STRIPE_API_KEY: "sk_test",
      FIZOT_PROXY_IDEMPOTENCY_HMAC_SECRET: "hmac-secret-at-least-32-bytes-long",
      ADMIN_DATABASE_URL: "postgres://x",
      COMPOSIO_API_KEY: "composio",
      XAI_API_KEY: "xai",
      ANTHROPIC_API_KEY: "sk-ant",
    },
  });
  expect(wrapped.env.PATH).toBe("/usr/bin");
  expect(wrapped.env.ANTHROPIC_API_KEY).toBe("sk-ant");
  for (const name of [
    "OMB_CLOUD_BOOTSTRAP_SECRET",
    "OMB_CLOUD_ADMIN_URL",
    "OMB_LICENSE_KEY",
    "OMB_DATA_DIR",
    "OMB_PORT",
    "FLY_API_TOKEN",
    "STRIPE_API_KEY",
    "FIZOT_PROXY_IDEMPOTENCY_HMAC_SECRET",
    "ADMIN_DATABASE_URL",
    "COMPOSIO_API_KEY",
    "XAI_API_KEY",
  ]) {
    expect(wrapped.env[name], name).toBeUndefined();
  }
});
