# ADR (proposed): Egress hostname allow-list for Cloud browsers

Status: **Proposed — not implemented.** Do not treat as shipped policy.

## Context

Fizot Cloud egress currently allows any destination whose resolved addresses are all **public**. That correctly blocks private, metadata, loopback, link-local, reserved and Fly 6PN ranges, and (with P4.7) DNS/DoT ports 53/853 and instance self-addresses.

It does **not** stop a page or shell from opening HTTPS (`:443`) to a public DoH or other exfil endpoint (for example `dns.google`, Cloudflare DoH). Chrome flags (`--dns-over-https-mode=off`, host-resolver MAP rules) only stop **browser-local** DNS upgrades; a SOCKS CONNECT to a public DoH host still looks like ordinary HTTPS.

## Decision needed

Whether Cloud browser (and optionally box) egress should move from “public IP only” to an explicit **hostname allow-list** (or a deny-list of known DoH / telemetry hosts as a weaker interim).

## Options

1. **Stay public-IP-only** — simplest; DoH-over-443 residual remains documented.
2. **Deny-list known DoH / telemetry hosts** — small, reversible; incomplete by nature.
3. **Allow-list customer-needed hosts + provider APIs** — strongest; requires product ownership of the list and a break-glass path so legitimate workloads are not silently blocked.

## Recommendation

Keep (1) for SE-U/SE-I completion. If design partners hit DoH exfil as a real threat model item, implement (2) first with an explicit operator-owned list, then evaluate (3) with a product ADR sign-off before G4 close.

## Consequences if (3) is chosen later

- Shared policy helper must feed both box CONNECT and browser SOCKS.
- Missing allow entries become customer-visible page failures; needs runbook and metrics.
- Must not ship a restrictive default that breaks browsing without owner approval.
