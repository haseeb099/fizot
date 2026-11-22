/**
 * Fizot cloud sandbox egress policy (P4.7).
 * Application-level checks are defense in depth on top of bwrap `--unshare-net`
 * plus the box HTTP CONNECT gate. Network isolation remains the primary control.
 */

import { isIP } from "node:net";

import { addressClass, type AddressClass } from "../../../electron/egress-addresses.mjs";
import {
  boxRefusal,
  BOX_EGRESS_RULES,
} from "../../bot-box/egress-gate.ts";
import type { ResolvedAddress } from "../../browser/egress/gate.ts";

/** Ports that would turn the egress gate into a DNS/DoT tunnel (TC53). */
export const DNS_EXFIL_PORTS: ReadonlySet<number> = new Set([53, 853]);

/** Hostnames that name cloud metadata without needing a successful resolve. */
export const METADATA_HOSTNAMES: ReadonlySet<string> = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
]);

export type FizotEgressRefusal =
  | "omb"
  | "this-computer"
  | "local-network"
  | "link-local"
  | "metadata"
  | "reserved"
  | "rebinding"
  | "reddit"
  | "home-network"
  | "port"
  | "dns-exfil"
  | "self-address"
  | "error";

export type FizotEgressTarget = { host: string; port: number };

export type FizotEgressDecideOptions = {
  /** This instance's own private / 6PN / interface addresses (TC54 self-address). */
  selfAddresses?: ReadonlySet<string>;
};

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

export function isMetadataHostname(host: string): boolean {
  const name = normalizeHost(host);
  if (METADATA_HOSTNAMES.has(name)) return true;
  return name.endsWith(".metadata.google.internal");
}

export function isDnsExfilPort(port: number): boolean {
  return DNS_EXFIL_PORTS.has(port);
}

export function classifyAddress(address: string): AddressClass {
  return addressClass(address);
}

/**
 * Why a Fizot cloud box must refuse `target` given resolved `addresses`, or null to allow.
 * Refuses when any address is non-public, when DNS/DoT ports are used, when the name is a
 * metadata alias, or when any address is this instance's own private address.
 */
export async function fizotBoxRefusal(
  target: FizotEgressTarget,
  addresses: readonly ResolvedAddress[],
  options: FizotEgressDecideOptions = {},
): Promise<FizotEgressRefusal | null> {
  if (isDnsExfilPort(target.port)) return "dns-exfil";
  if (isMetadataHostname(target.host)) return "metadata";

  const self = options.selfAddresses;
  if (self && self.size > 0) {
    for (const { address } of addresses) {
      const bare = address.split("%", 1)[0]!;
      if (self.has(bare) || self.has(normalizeHost(bare))) return "self-address";
    }
  }

  const base = await boxRefusal(target, addresses).catch(() => "error" as const);
  return base as FizotEgressRefusal | null;
}

/** Cloud box rules: public internet only; no local-network allow-list. */
export function fizotCloudEgressRules() {
  return BOX_EGRESS_RULES;
}

/** True when every resolved address is publicly routable (no private/metadata/loopback mix). */
export function allAddressesPublic(addresses: readonly { address: string }[]): boolean {
  if (addresses.length === 0) return false;
  return addresses.every((row) => addressClass(row.address) === "public");
}

/** Literal IP or hostname form of an allow-list CIDR entry is validated by the browser policy parser. */
export function isLiteralIp(host: string): boolean {
  return isIP(normalizeHost(host)) !== 0;
}
