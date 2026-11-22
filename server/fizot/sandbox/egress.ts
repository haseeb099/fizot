/**
 * Fizot wiring for the upstream box egress gate: same unix-socket CONNECT proxy,
 * with Fizot cloud refusals (DNS/DoT ports, metadata hostnames, self-address).
 */

import { networkInterfaces } from "node:os";

import { openBoxEgressGate, type BoxEgressGate, type EgressGateOptions } from "../../bot-box/egress-gate.ts";
import { fizotBoxRefusal, type FizotEgressDecideOptions } from "./policy.ts";

/** Collect this machine's interface addresses for TC54 self-address refusal. */
export function instanceSelfAddresses(
  interfaces: NodeJS.Dict<ReturnType<typeof networkInterfaces>[string]> = networkInterfaces(),
): Set<string> {
  const out = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry) continue;
      out.add(entry.address.split("%", 1)[0]!);
    }
  }
  return out;
}

export type FizotBoxEgressOptions = Omit<EgressGateOptions, "decide"> & {
  decideOptions?: FizotEgressDecideOptions;
};

/** Open the box egress gate with Fizot cloud decide() (fail-closed on decide errors). */
export function openFizotBoxEgressGate(options: FizotBoxEgressOptions): Promise<BoxEgressGate> {
  const selfAddresses = options.decideOptions?.selfAddresses ?? instanceSelfAddresses();
  const decideOptions: FizotEgressDecideOptions = { ...options.decideOptions, selfAddresses };
  return openBoxEgressGate({
    ...options,
    decide: (target, addresses) => fizotBoxRefusal(target, addresses, decideOptions),
  });
}
