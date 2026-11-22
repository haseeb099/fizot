# Sandbox and egress (P4.7)

Prompt-injected shells are the main threat on a hosted workspace. Application URL checks are **defense in depth**; the primary controls are network isolation (`bwrap --unshare-net`), the box CONNECT/HTTP egress gate, and per-tenant Fly networks.

## Threat model (concise)

| Threat | Control |
| --- | --- |
| Reach host loopback / Admin / harness | Isolated net + egress gate refuses loopback (`omb`) |
| Cloud metadata (169.254.169.254, etc.) | Address class `metadata` + hostname aliases |
| Private RFC1918 / CGNAT / Fly 6PN (`fc00::/7`, `fdaa::`) | Address class `private` → refuse |
| DNS rebinding (public name → private A/AAAA) | Gate resolves itself; **any** non-public address refuses the whole target |
| DNS/DoT exfiltration via the proxy (TC53) | Refuse ports **53** and **853** even to public resolvers |
| Sandbox → own instance private address (TC54) | `selfAddresses` refusal on interface / 6PN addresses |
| Cross-tenant network (TC28 / TC59) | Per-workspace Fly network `fizot-net-*` (SE-I on staging) |
| SSRF / redirect bypass | Resolve once, pin connect to checked addresses; no follow of unchecked redirects at the gate |
| Slack Full-access via session-less loopback | Mutating `SERVICE_ALLOW` routes require `OMB_SLACK_RELAY_TOKEN` |
| Server env secrets in the box | `boxEnvironment` allow-list + never-list; BoxRunner strip on wrap |
| Chrome background phones-home | `gateChromeFlags` includes `--disable-background-networking` and related |

## Code map

| Piece | Path |
| --- | --- |
| Address classes | `electron/egress-addresses.mjs` |
| Browser / box refusal rules | `server/browser/egress/policy.ts`, `server/bot-box/egress-gate.ts` |
| Fizot cloud decide + self-address | `server/fizot/sandbox/policy.ts`, `egress.ts` |
| Slack relay fail-closed | `server/fizot/sandbox/service-relay.ts` → `request-auth.ts` |
| Env strip | `server/bot-box/env.ts` |

## Operator notes

- Set `OMB_SLACK_RELAY_TOKEN` (≥16 chars) on Cloud homes that run a Slack worker; without it, mutating service routes stay closed (fail closed).
- SE-U is unit-covered. SE-I (TC28/TC59 two-tenant Fly, live self-address) needs Fly staging credentials — do not mark pass without a green run.

## Residual / deferred

- Hostname allow-list beyond “public IP only” (product ADR).
- DoH over HTTPS to arbitrary public hosts (needs hostname policy).
- SE-E (J2/J6 browser) and full G4 evidence.
