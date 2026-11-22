import * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { openGate, type EgressGate, type GateTarget } from "../../../server/browser/egress/gate.ts";
import { BrowserEgress } from "../../../server/browser/egress/registry.ts";
import { fizotCloudNameRefusal, fizotCloudRefusal } from "../../../server/fizot/sandbox/policy.ts";

const gates: EgressGate[] = [];
afterEach(async () => {
  for (const gate of gates.splice(0)) await gate.close();
});

/** Sends a SOCKS5 greeting and CONNECT; resolves with the reply code. */
const connectThrough = (proxyPort: number, target: Buffer) =>
  new Promise<{ code: number; socket: NodeNet.Socket }>((resolve) => {
    const socket = NodeNet.connect(proxyPort, "127.0.0.1", () => {
      socket.write(Buffer.from([5, 1, 0]));
      socket.write(Buffer.concat([Buffer.from([5, 1, 0]), target]));
    });
    socket.on("error", () => {});
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 12) {
        socket.off("data", onData);
        resolve({ code: received[3]!, socket });
      }
    };
    socket.on("data", onData);
    socket.on("close", () => resolve({ code: received[3] ?? -1, socket }));
  });

const nameTarget = (host: string, port: number) => {
  const name = Buffer.from(host, "latin1");
  const target = Buffer.alloc(1 + 1 + name.length + 2);
  target[0] = 3;
  target[1] = name.length;
  name.copy(target, 2);
  target.writeUInt16BE(port, 2 + name.length);
  return target;
};

const ipv4Target = (address: string, port: number) => {
  const target = Buffer.alloc(7);
  target[0] = 1;
  address.split(".").forEach((octet, index) => (target[1 + index] = Number(octet)));
  target.writeUInt16BE(port, 5);
  return target;
};

async function cloudGate(
  resolve: (host: string) => Promise<Array<{ address: string; family: number }>>,
  selfAddresses: ReadonlySet<string> = new Set(),
) {
  const opened = await openGate({
    refuseName: (target) => fizotCloudNameRefusal(target),
    decide: (target, addresses) => fizotCloudRefusal(target, addresses, { selfAddresses }),
    resolve,
  });
  gates.push(opened);
  return opened;
}

describe("browser SOCKS Fizot Cloud decide (P4.7)", () => {
  it("refuses DNS port 53 and DoT port 853 even to public resolvers", async () => {
    const gate = await cloudGate(async () => [{ address: "8.8.8.8", family: 4 }]);
    expect((await connectThrough(gate.port, ipv4Target("8.8.8.8", 53))).code).toBe(2);
    expect((await connectThrough(gate.port, nameTarget("dns.google", 853))).code).toBe(2);
  });

  it("refuses IPv4 and IPv6 private, metadata, loopback and Fly 6PN addresses", async () => {
    const cases: Array<{ host: string; address: string; family: number }> = [
      { host: "evil.example", address: "10.0.0.5", family: 4 },
      { host: "evil.example", address: "192.168.1.9", family: 4 },
      { host: "evil.example", address: "fdaa:0:0::9", family: 6 },
      { host: "evil.example", address: "fc00::1", family: 6 },
      { host: "evil.example", address: "169.254.169.254", family: 4 },
      { host: "evil.example", address: "127.0.0.1", family: 4 },
    ];
    for (const row of cases) {
      const gate = await cloudGate(async () => [{ address: row.address, family: row.family }]);
      expect((await connectThrough(gate.port, nameTarget(row.host, 443))).code, row.address).toBe(2);
    }
  });

  it("refuses metadata hostnames before relying on resolve", async () => {
    const gate = await cloudGate(async () => [{ address: "203.0.113.9", family: 4 }]);
    expect((await connectThrough(gate.port, nameTarget("metadata.google.internal", 80))).code).toBe(2);
  });

  it("refuses this instance's own private address (TC54)", async () => {
    const gate = await cloudGate(async () => [{ address: "10.70.1.4", family: 4 }], new Set(["10.70.1.4", "fdaa:0:1::2"]));
    expect((await connectThrough(gate.port, nameTarget("peer.internal", 443))).code).toBe(2);
  });

  it("refuses DNS rebinding when any resolved address is non-public", async () => {
    const gate = await cloudGate(async () => [
      { address: "203.0.113.7", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    expect((await connectThrough(gate.port, nameTarget("rebind.example", 443))).code).toBe(2);
  });

  it("decides each CONNECT independently (redirect-equivalent second host)", async () => {
    const seen: string[] = [];
    // Local closed port: decide returns null (allow) so the gate attempts TCP and fails fast with
    // connection refused — proving policy is re-run per CONNECT without hanging on a public IP.
    const gate = await openGate({
      refuseName: (target: GateTarget) => fizotCloudNameRefusal(target),
      decide: async (target) => {
        seen.push(`${target.host}:${target.port}`);
        return null;
      },
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    gates.push(gate);
    expect((await connectThrough(gate.port, nameTarget("example.com", 1))).code).not.toBe(2);
    expect((await connectThrough(gate.port, nameTarget("cdn.example", 1))).code).not.toBe(2);
    expect(seen).toEqual(["example.com:1", "cdn.example:1"]);
  });

  it("BrowserEgress cloud path refuses DNS/DoT and wires self-address", async () => {
    const egress = new BrowserEgress();
    egress.configure({
      host: "cloud",
      config: () => ({}),
      selfAddresses: () => new Set(["10.70.1.4"]),
      resolve: async (host) => {
        if (host === "peer.internal") return [{ address: "10.70.1.4", family: 4 }];
        if (host === "8.8.8.8") return [{ address: "8.8.8.8", family: 4 }];
        return [{ address: "203.0.113.7", family: 4 }];
      },
    });
    const port = await egress.open("sess-1");
    expect(egress.nameRefusal({ host: "dns.google", port: 53 })).toBe("dns-exfil");
    expect(egress.nameRefusal({ host: "metadata.google.internal", port: 80 })).toBe("metadata");
    expect((await connectThrough(port, ipv4Target("8.8.8.8", 53))).code).toBe(2);
    expect((await connectThrough(port, nameTarget("peer.internal", 443))).code).toBe(2);
    await egress.close();
  });
});
