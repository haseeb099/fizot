import { expect, it } from "vitest";
import { parseAllowEntry, allowList } from "../../../server/browser/egress/policy.ts";
import {
  allAddressesPublic,
  classifyAddress,
  fizotBoxRefusal,
  fizotCloudEgressRules,
  isDnsExfilPort,
  isLiteralIp,
  isMetadataHostname,
} from "../../../server/fizot/sandbox/policy.ts";

it("classifies private, metadata, loopback, link-local, reserved, Fly 6PN and public addresses", () => {
  expect(classifyAddress("10.0.0.5")).toBe("private");
  expect(classifyAddress("192.168.1.1")).toBe("private");
  expect(classifyAddress("172.16.9.1")).toBe("private");
  expect(classifyAddress("100.64.1.1")).toBe("private");
  expect(classifyAddress("fdaa:0:0::1")).toBe("private");
  expect(classifyAddress("fc00::1")).toBe("private");
  expect(classifyAddress("169.254.169.254")).toBe("metadata");
  expect(classifyAddress("fd00:ec2::254")).toBe("metadata");
  expect(classifyAddress("100.100.100.200")).toBe("metadata");
  expect(classifyAddress("127.0.0.1")).toBe("loopback");
  expect(classifyAddress("::1")).toBe("loopback");
  expect(classifyAddress("169.254.1.1")).toBe("link-local");
  expect(classifyAddress("fe80::1")).toBe("link-local");
  expect(classifyAddress("0.0.0.0")).toBe("reserved");
  expect(classifyAddress("203.0.113.7")).toBe("public");
  expect(classifyAddress("8.8.8.8")).toBe("public");
});

it("treats NAT64/6to4 embeddings of private addresses as private", () => {
  // 64:ff9b::c0a8:0101 embeds 192.168.1.1
  expect(classifyAddress("64:ff9b::c0a8:101")).toBe("private");
});

it("allow-list matcher parses IPv4/IPv6 CIDR and port forms used by self-hosted policy", () => {
  expect(parseAllowEntry("10.0.0.5")).toEqual({ network: "10.0.0.5", prefix: 32, port: null });
  expect(parseAllowEntry("192.168.1.0/24")).toEqual({ network: "192.168.1.0", prefix: 24, port: null });
  expect(parseAllowEntry("[fd12::1]:443")).toEqual({ network: "fd12::1", prefix: 128, port: 443 });
  const allowed = allowList(["10.0.0.0/8:443", "192.168.1.0/24"]);
  expect(allowed("10.1.2.3", 443)).toBe(true);
  expect(allowed("10.1.2.3", 80)).toBe(false);
  expect(allowed("192.168.1.50", 80)).toBe(true);
  expect(allowed("203.0.113.7", 443)).toBe(false);
});

it("cloud box rules never open local-network or an allow-list hole", () => {
  const rules = fizotCloudEgressRules();
  expect(rules.host).toBe("cloud");
  expect(rules.localNetwork).toBe(false);
  expect(rules.allowed("10.0.0.1", 443)).toBe(false);
  expect(rules.ownPort(8799)).toBe(true);
});

it("refuses DNS/DoT exfil ports even when the destination address is public", async () => {
  expect(isDnsExfilPort(53)).toBe(true);
  expect(isDnsExfilPort(853)).toBe(true);
  expect(isDnsExfilPort(443)).toBe(false);
  const publicAddr = [{ address: "8.8.8.8", family: 4 }];
  expect(await fizotBoxRefusal({ host: "8.8.8.8", port: 53 }, publicAddr)).toBe("dns-exfil");
  expect(await fizotBoxRefusal({ host: "8.8.8.8", port: 853 }, publicAddr)).toBe("dns-exfil");
  expect(await fizotBoxRefusal({ host: "8.8.8.8", port: 443 }, publicAddr)).toBeNull();
});

it("refuses metadata hostnames before relying on resolve", async () => {
  expect(isMetadataHostname("metadata.google.internal")).toBe(true);
  expect(isMetadataHostname("METADATA")).toBe(true);
  expect(await fizotBoxRefusal(
    { host: "metadata.google.internal", port: 80 },
    [{ address: "203.0.113.9", family: 4 }],
  )).toBe("metadata");
});

it("refuses private, metadata and loopback resolved addresses (TC52)", async () => {
  expect(await fizotBoxRefusal({ host: "evil.example", port: 443 }, [{ address: "10.0.0.5", family: 4 }])).toBe("local-network");
  expect(await fizotBoxRefusal({ host: "evil.example", port: 80 }, [{ address: "169.254.169.254", family: 4 }])).toBe("metadata");
  expect(await fizotBoxRefusal({ host: "evil.example", port: 443 }, [{ address: "127.0.0.1", family: 4 }])).toBe("omb");
  expect(await fizotBoxRefusal({ host: "evil.example", port: 443 }, [{ address: "fdaa:0:0::9", family: 6 }])).toBe("local-network");
});

it("refuses DNS rebinding when any resolved address is non-public", async () => {
  expect(await fizotBoxRefusal(
    { host: "evil.example", port: 443 },
    [{ address: "203.0.113.7", family: 4 }, { address: "127.0.0.1", family: 4 }],
  )).toBe("omb");
  expect(allAddressesPublic([{ address: "203.0.113.7" }, { address: "8.8.8.8" }])).toBe(true);
  expect(allAddressesPublic([{ address: "203.0.113.7" }, { address: "10.0.0.1" }])).toBe(false);
});

it("refuses this instance's own private address (TC54 self-address)", async () => {
  const self = new Set(["fdaa:0:1::2", "10.70.1.4"]);
  expect(await fizotBoxRefusal(
    { host: "peer.internal", port: 443 },
    [{ address: "fdaa:0:1::2", family: 6 }],
    { selfAddresses: self },
  )).toBe("self-address");
  expect(await fizotBoxRefusal(
    { host: "peer.internal", port: 443 },
    [{ address: "10.70.1.4", family: 4 }],
    { selfAddresses: self },
  )).toBe("self-address");
  expect(await fizotBoxRefusal(
    { host: "example.com", port: 443 },
    [{ address: "203.0.113.7", family: 4 }],
    { selfAddresses: self },
  )).toBeNull();
});

it("identifies literal IPs for direct-IP access paths", () => {
  expect(isLiteralIp("203.0.113.7")).toBe(true);
  expect(isLiteralIp("[fdaa::1]")).toBe(true);
  expect(isLiteralIp("example.com")).toBe(false);
});
