# Sandbox and egress (P4.7)

Prompt-injected shells are the main threat on a hosted workspace. Application URL checks are **defense in depth**; the primary controls are network isolation (`bwrap --unshare-net`), the box CONNECT/HTTP egress gate, the browser SOCKS gate, and per-tenant Fly networks.

## Threat model (concise)

| Threat | Control |
| --- | --- |
| Reach host loopback / Admin / harness | Isolated net + egress gate refuses loopback (`omb`) |
| Cloud metadata (169.254.169.254, etc.) | Address class `metadata` + hostname aliases |
| Private RFC1918 / CGNAT / Fly 6PN (`fc00::/7`, `fdaa::`) | Address class `private` → refuse |
| DNS rebinding (public name → private A/AAAA) | Gate resolves itself; **any** non-public address refuses the whole target; each SOCKS/CONNECT is decided again (redirects do not reuse a prior allow) |
| DNS/DoT exfiltration via the proxy (TC53) | Refuse ports **53** and **853** even to public resolvers (box CONNECT **and** browser SOCKS) |
| Sandbox → own instance private address (TC54) | `selfAddresses` refusal on interface / 6PN addresses (both gates) |
| Cross-tenant network (TC28 / TC59) | Per-workspace Fly network `fizot-net-*` (SE-I on staging) |
| SSRF / redirect bypass | Resolve once, pin connect to checked addresses; no follow of unchecked redirects at the gate |
| Slack Full-access via session-less loopback | Mutating `SERVICE_ALLOW` routes require `OMB_SLACK_RELAY_TOKEN`; token is on `BOX_ENV_NEVER` + `CONTROL_PLANE_ENV` so boxed shells cannot inherit it |
| Server env secrets in the box | `boxEnvironment` allow-list + never-list; BoxRunner strip on wrap |
| Chrome background phones-home | `gateChromeFlags` includes `--disable-background-networking` and related |
| Chrome Secure DNS / DoH upgrades | `--dns-over-https-mode=off` (MAP `~NOTFOUND` host-resolver rules deferred: broke gated Chrome smoke with `ERR_PROXY_CONNECTION_FAILED`) |

## Where enforcement lives

| Layer | What it enforces | What it does not |
| --- | --- | --- |
| `bwrap --unshare-net` + bridges | Only loopback bridges leave the box | Policy of those bridges |
| Box CONNECT (`openFizotBoxEgressGate`) | Public addresses only; DNS/DoT 53/853; metadata names; self-address | Browser path; hostname allow-list |
| Browser SOCKS (`BrowserEgress` on Cloud) | Same Fizot Cloud decide as the box gate (`fizotCloudRefusal`) | UDP outside SOCKS (blocked by netns in the box); DoH over HTTPS to public hosts |
| Chrome launch flags | No local resolver / no DoH upgrade; no WebRTC UDP; no background networking | A page that CONNECT-tunnels HTTPS to a public DoH endpoint on 443 |
| Fly per-workspace network | Tenant A cannot route to tenant B’s 6PN (SE-I) | Application bugs that call public APIs |

## Code map

| Piece | Path |
| --- | --- |
| Address classes | `electron/egress-addresses.mjs` |
| Browser / box refusal rules | `server/browser/egress/policy.ts`, `server/bot-box/egress-gate.ts` |
| Shared Fizot Cloud decide | `server/fizot/sandbox/policy.ts` (`fizotCloudRefusal` / `fizotCloudNameRefusal`) |
| SE-I isolation harness | `server/fizot/sandbox/isolation-harness.ts` + `FIZOT_ROUNDTRIP_MODE=isolation` |
| Staging safety | `server/fizot/admin/staging-safety.ts` (run manifest, preflight, run-scoped cleanup) |
| Box wiring | `server/fizot/sandbox/egress.ts` |
| Browser SOCKS Cloud wiring | `server/browser/egress/registry.ts` |
| Slack relay fail-closed | `server/fizot/sandbox/service-relay.ts` → `request-auth.ts` |
| Env strip | `server/bot-box/env.ts` |
| Chrome SOCKS + resolver flags | `server/browser/egress/gate.ts` |

## Operator notes

- Set `OMB_SLACK_RELAY_TOKEN` (≥16 chars) on Cloud homes that run a Slack worker; without it, mutating service routes stay closed (fail closed).
- SE-U is unit-covered (box + browser SOCKS). SE-I harness + `mode=isolation` are implemented; a green owner Fly staging run is still required — do not mark pass without evidence.
- Staging acceptance checklist: `docs/fizot/p47-staging-acceptance.md`.

## Residual / deferred

- Hostname allow-list beyond “public IP only” (product ADR: `docs/fizot/adr-egress-hostname-allowlist.md`). **DoH over HTTPS to arbitrary public hosts on 443 is not closed** without that policy; Chrome flags only stop local DNS upgrades, not a page CONNECT to `dns.google:443`.
- SE-E (J2/J6 browser) and full G4 evidence.
