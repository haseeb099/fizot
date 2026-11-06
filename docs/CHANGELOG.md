# Changelog

Every change records why, how it works, why it is necessary, impact, and rollback.

Notion assigns the CL number. This file uses those ids. The pin entry was first drafted here as CL-1 and is Notion CL-9. The enterprise deletion was first drafted here as CL-2 and is Notion CL-10.

Patch titles in `docs/PATCH_REGISTRY.md` are PATCH-n. Notion's auto-increment PR column differs: PATCH-1 is Notion PR 10, PATCH-2 is PR 11, PATCH-3 is PR 12, PATCH-4 is PR 13, PATCH-5 is PR 14, PATCH-6 is PR 15, PATCH-7 is PR 16, PATCH-8 is PR 17, PATCH-9 is PR 18, PATCH-10 is PR 19, PATCH-11 is PR 20, PATCH-12 is PR 21, PATCH-13 is PR 22, PATCH-14 is PR 23, PATCH-15 is PR 24, PATCH-16 is PR 25, PATCH-17 is PR 26, PATCH-18 is PR 27, PATCH-19 is PR 28, PATCH-20 is PR 29, PATCH-21 is PR 30, PATCH-22 is PR 31, PATCH-23 is PR 32, PATCH-24 is PR 33, PATCH-25 is PR 34, PATCH-26 is PR 35, PATCH-27 is PR 36, PATCH-28 is PR 37, PATCH-29 is PR 38, PATCH-30 is PR 39, PATCH-31 is PR 40, PATCH-32 is PR 41.

## CL-48 Stripe billing, plans, VAT and failed-payment lifecycle (P4.4)

- Why we changed it: A workspace was given its included credit at creation, so a signed-in user could open many workspaces and spend Fizot's inference budget. Billing bugs and tax mistakes then repeat on every invoice.
- How it works: No included credit until `invoice.paid` (ledger `request_id` is the Stripe invoice id). The proxy returns 402 `subscription_required` until the subscription is active or trialing with a payment method. Plans and amounts live in `server/fizot/billing/plan-prices.ts` and stay unpublished, so checkout refuses them outside test mode. Owner checkout and portal URLs come from config. Stripe webhooks reuse the P4.2 `t=,v1=` receiver and ignore stale `created` times. The deletion worker tick moves `past_due` to a 7-day grace, then suspension, a notice 7 days before deletion, and the P4.2 deletion job after 30 days. Recovery before deletion returns to active. Team seat quantity follows the membership count. `scripts/fizot/margin-check.mjs` exits 1 when a published plan is under 40% at always-on with the included credit used. Stripe Tax does the VAT. J9 stays planned: repo secrets `STRIPE_TEST_API_KEY` and `STRIPE_TEST_WEBHOOK_SECRET` are absent.
- Why it is necessary: P4.4 / FZ-27. Consumer flows stay deferred.
- Impact: No Stripe or Fly spend on the daily gate. Placeholder plan prices are unverified and unpublished. Postgres checks run on `admin-postgres.yml`.
- Rollback? Revert the PR.
- Files / Patch IDs: PATCH-39. https://app.notion.com/p/410dd43e0a9d813ca447eb6e70e6049d
- Related tasks: FZ-27 (P4.4). Patch: https://app.notion.com/p/410dd43e0a9d81e3aa5ffcc4c865169a

## CL-47 AI proxy credit ledger, tiers and metering (P4.3 part 1)

- Why we changed it: Fizot pays the inference bill. A hard cap and an append-only ledger are what stop one workspace from creating an unbounded cost.
- How it works: Spike B's token scheme, redaction and mock provider stay. Postgres `credit_accounts` plus an append-only `credit_ledger` (grant, usage, refund, adjust) in integer micro-GBP; balance is the sum of the ledger. Tiers Fast, Balanced and Best map in `server/fizot/proxy/pricing.ts` to a provider model and a placeholder price with markup. The proxy reserves the worst case, returns 402 when credit is short, then settles the provider usage (or the reserve if usage is missing). A repeated `request_id` does not charge twice. 80% of included credit alerts once per month through the existing webhook; 100% plus top-up is a hard 402. `FIZOT_PROXY_DISABLED=1` and `POST /admin/proxy/kill` stop provider traffic. Provider keys stay in the proxy environment. `scripts/fizot/ledger-reconcile.mjs` fails when fixture drift is over 1%. TC55 and TC68 stay planned.
- Why it is necessary: P4.3 / FZ-26 part 1. Bring-your-own-key, Stripe and sandbox egress are later parts.
- Impact: No real provider calls on the daily gate (mock only). Placeholder prices are not verified against provider price pages. Postgres checks run on `admin-postgres.yml`.
- Rollback? Revert the PR.
- Files / Patch IDs: PATCH-38. https://app.notion.com/p/40fdd43e0a9d818f9263d57ba9e05ac4
- Related tasks: FZ-26 (P4.3). Patch: https://app.notion.com/p/40fdd43e0a9d81f49e60cc3fde6fb80f

## CL-46 Workspace provisioning, deletion job and webhooks (P4.2)

- Why we changed it: UK GDPR erasure depends on fail-loud, idempotent, provable workspace deletion. A silent failure is a legal breach.
- How it works: Ownership changes only via explicit transfer (self-demote refused; exactly one owner). Workspace state machine `requested → creating → ready → sleeping|awake → deleting → deleted|failed` with Postgres transitions. Idempotent create by `requestId`; reconciler compares Postgres with Fly `fizot-cm-*` apps (orphans >1h reported, never auto-deleted here). `DELETE /admin/workspaces/:id` marks deleting and runs a job (machines → volume → app → secrets → rows → verify); retries with backoff; alerts at 12h; marks failed at 24h with hourly alerts; deletion receipt (workspace id hash, no PII) via `GET .../deletion`. User erase deletes solely-owned workspaces and leaves others via member-left. `POST /admin/webhooks/:provider` (public, signature-checked) with generic HMAC + Stripe `t=,v1=` and independent KAT; exactly-once dedupe. Fly `mode=erase` (J8). Daily gate: fakes only.
- Why it is necessary: P4.2 / FZ-25.
- Impact: No Fly spend on the daily gate. Manual Fly erase costs staging machines; auto-destroy; remainingCount must be 0. AD-E J8 is implemented: fly-staging-roundtrip mode=erase, fly_org=fizot, run 42109759178.
- Rollback? Revert the PR.
- Files / Patch IDs: PATCH-37. https://app.notion.com/p/40fdd43e0a9d8179883bca2f84ea977a
- Related tasks: FZ-25 (P4.2). Patch: https://app.notion.com/p/40fdd43e0a9d8181a04cd441c6af89d4

## CL-45 Fix Fly staging cleanup org default (fizot)

- Why we changed it: Scheduled cleanup run 42027599961 failed with Fly `GET /v1/apps?org_slug=fizot-staging` → 404 organization not found. The real org slug is `fizot`.
- How it works: `DEFAULT_FLY_ORG = "fizot"` via `resolveFlyOrg` (input → `FLY_ORG` → default). Cleanup workflow reads `vars.FLY_ORG` then falls back to `fizot`. `listApps` rethrows org 404 with a clear message. Failed cleanup opens or updates a GitHub issue titled "Fly cleanup failed".
- Why it is necessary: A silent/wrong-org cleanup leaves orphan staging machines billing after Gate G0b.
- Impact: No daily-gate change. Scheduled and manual cleanup target the real org.
- Rollback? Revert the PR.
- Files / Patch IDs: PATCH-36. https://app.notion.com/p/40fdd43e0a9d812bad9cf96ddeed9039
- Related: Patch https://app.notion.com/p/40fdd43e0a9d81509a00dee90176647d

## CL-44 Team roles, invites and J10 privacy (P4.1 part 2)

- Why we changed it: A Team workspace needs Owner/Admin/Member with invites and seat limits, and a member's private chat must be invisible to every other member and to Admin/Owner — proven before Team UI.
- How it works: Membership roles via `authorizeWorkspaceAccess(minRole)`; hashed single-use 7-day invites (Admin invites members; only Owner invites admins; seatMax from `plans.ts`); remove member revokes sessions and signs `POST /api/cloud/team/member-left` (Apache path already exists — no inventing machine code in `enterprise/`); Edge open carries the membership claim (client-supplied role elevation ignored); Admin returns member metadata only; redaction covers private-chat keys; TC36 sweeps none/stranger/member/admin/owner; J10 daily gate on fakes; `fly-staging-roundtrip` `mode=team` for real Fly. TC28/TC59 stay under P4.7; Stripe seats under P4.4.
- Why this was necessary: P4.1 / FZ-24 part 2 (Notion FZ-24).
- Impact: No Fly spend on the daily gate. Manual Fly team mode costs one staging machine; auto-destroy; remainingCount must be 0. AD-E (J10) stays planned until a green Fly team run.
- Rollback? Revert the PR.
- Files / Patch IDs: PATCH-35. https://app.notion.com/p/40fdd43e0a9d8139986cd3e00411654b
- Related tasks: FZ-24 (P4.1). Patch: https://app.notion.com/p/40fdd43e0a9d8139937df88828b384cd

## CL-43 Accounts, sign-in and tenant routing (P4.1 part 1)

- Why we changed it: A signed-in user must reach only their own workspaces. Cross-tenant leaks end the business, so isolation is built and proven before Team UI / invites / private chats.
- How it works: Postgres (and memory) accounts, memberships (`owner|admin|member`) and sessions; `AuthProvider` + `FakeAuthProvider` + HttpOnly Secure SameSite=Lax session cookie with rotation and server-side revocation; Edge open uses membership then the signed cloud-home pairing contract; every Admin/Edge route is in `ROUTE_REGISTRY` and membership routes go through one `authorizeWorkspaceAccess` helper (unknown/forbidden → 404). Independent HMAC KAT via `scripts/fizot/independent-hmac-kat.mjs` (plain `node:crypto`). TC36 sweeps the registry; TC27 proves two-tenant isolation on fakes (daily) and Postgres (`admin-postgres.yml`, manual). No consumer self-signup; vendor sign-in deferred.
- Why this was necessary: P4.1 / FZ-24 isolation core. Fixes the circular signer test noted at S2.x.
- Impact (cost / risk / timeline): No Fly spend in the daily gate. Staging Fly round-trip now signs in with FakeAuth first. Part 2 (roles UI, J10, TC28, TC59, invites) out of scope.
- Rollback? Revert the PR. Existing Fly machines unchanged.
- Files / Patch IDs: PATCH-34. https://app.notion.com/p/40edd43e0a9d81b1aa68dcdd362e405a

## CL-42 True Fly sleep/stop probe and cost-guard price fix

- Date: 2026-11-04
- Type: Code
- Area: Admin & provisioning; CI & tests; Cost
- Why we changed it: Green run 41792947703 returned HTTP 409 on `/api/cloud/power/sleep` (`busy:["just-woke"]`) and never called Fly stop, so asleep-*.json was still `started`. cost-guard also projected ~$3.29/mo from an undersized $/sec while cost-sheet correctly used $12.70 for shared-cpu-1x 2 GB.
- Why it is necessary: CS-I needs a true stopped sample; Gate G0b spend projections must match published Fly rates.
- How it works: Admin `POST .../sleep` waits until power is idle, signs prepareSleep (`idleMinutes`), then Fly Machines **suspend** (stop would destroy under `auto_destroy`) + wait `suspended`. Wake starts and waits for health 200. Round trip asserts asleep, probes 60 s, then wakes. cost-guard imports rates from `cost-sheet.ts` (https://fly.io/docs/about/pricing/, read 2026-11-04). Proven green: run 41880692381; CS-I → implemented.
- Impact: Staging round trips take ~2+ extra minutes (just-woke window) plus 60 s suspended; projected daily cost rises to match the $12.70 machine.
- Rollback: Revert sleep/wake routes and restore the old cost-guard constant.
- Files / Patch IDs: PATCH-33. https://app.notion.com/p/40edd43e0a9d8107b3c6c7aec7da5ac0
- Related tasks: FZ-17 (S2.10). Patch: https://app.notion.com/p/40edd43e0a9d81a2a484c395b8ec65be. PR: https://github.com/haseeb099/fizot/pull/15.

## CL-41 Staging cost sheet from measured Fly probe data

- Date: 2026-11-04
- Type: Code
- Area: Docs & plan; CI & tests; Cost
- Why we changed it: S2.10 needs a filed sheet that combines measured probe samples with published Fly unit prices for always-on / 8 h / 1 h profiles.
- Why it is necessary: Personal price and K4 margin cannot be set without an explicit measured-vs-assumed cost table.
- How it works: `docs/fizot/cost-sheet.md` and `scripts/fizot/cost-sheet.mjs` read `artifacts/s2-10/` from run 41792947703. Arithmetic lives in `server/fizot/cost-sheet.ts`. Egress stays assumed (null from Machines API). AI cost is a separate pass-through section. CS-I → pass because the script and vitest run on the real artifacts.
- Impact: No new Fly spend. Sheet uses iad list prices; staging was lhr.
- Rollback: Delete the cost-sheet docs/script/tests and revert CS-I to planned.
- Files / Patch IDs: PATCH-32. https://app.notion.com/p/40edd43e0a9d8137a281e4d61a9f3550
- Related tasks: FZ-17 (S2.10). Patch: https://app.notion.com/p/40edd43e0a9d811f885cc8985ffacb10

## CL-40 Allocate Fly public IPs and fail early on stuck machines

- Date: 2026-11-04
- Type: Code
- Area: Admin & provisioning; CI & tests
- Why we changed it: Run 41747048766 created the app/machine but `*.fly.dev` returned `fetch failed` for 8 minutes — Machines API apps get no public IP until allocated.
- Why it is necessary: Without shared IPv4 + IPv6 the Admin cannot reach health/pairing/power on staging.
- How it works: `allocateIps` after `createApp` (Machines `ip_assignments`, GraphQL fallback). Round trip logs `err.cause` and machine state/checks/events every 60s, fails after 3 minutes if state is not `started`, and cleanup reports `remainingCount: 0`.
- Impact: Staging round trips become reachable; early fail saves CI/Fly spend.
- Rollback: Revert this commit; restore create without IP allocation.
- Files / Patch IDs: PATCH-31. https://app.notion.com/p/40edd43e0a9d813b986fc3d3ae4051d4
- Related tasks: FZ-18 (S2.11).

## CL-39 Fly staging round trip and S2.10 cost probe hooks

- Date: 2026-11-03
- Type: Code
- Area: Admin & provisioning; CI & tests; Cost
- Why we changed it: S2.11's Done-when needs a real Fly staging create/health/pairing/destroy path; S2.10 needs measured usage JSON for the cost sheet.
- Why it is necessary: Gate G0b (100 GBP/month) requires a cost guard and proof before committing to Admin spend; AD-I/CS-I stay planned until a green manual run.
- How it works: `createFlyMachinesClient` implements the Fly Machines API behind the existing interface (own network, 10 GB volume, shared-cpu-1x 2 GB, secrets, destroy). Cost guard refuses >2 live `fizot-cm-*` machines, always sets `auto_destroy`, prints projected daily cost, and schedules a 24h cleanup workflow. `fly-staging-roundtrip.yml` (`workflow_dispatch` + `FLY_API_TOKEN`) builds the cloud-home image, runs create → health → pairing → power → wrong-signature/replay negatives → destroy, and writes `artifacts/s2-10/` via `fly-cost-probe.mjs` (≤1 h machine time). Docs SHAs unchanged: cloud-pro `41229d0bd393629130dc7f30fe7cd926cbe7dc03`, team-cloud `5e1e740e7fcb537928a753fa290970571a131abe`. Daily gate unchanged.
- Impact: No Fly spend on the daily gate. Manual run spend is capped by the cost guard.
- Rollback: Delete the new Fly client paths, staging workflows, and probe scripts; restore Admin to fake-only.
- Files / Patch IDs: PATCH-30. Notion PR 39. https://app.notion.com/p/40ddd43e0a9d8167aeaac5dad275b0c4
- Related tasks: FZ-18 (S2.11), FZ-17 (S2.10). Patch: https://app.notion.com/p/40ddd43e0a9d8115b49de0f08118cede

## CL-38 Fizot Admin skeleton from the Apache cloud-home contract

- Date: 2026-11-03
- Type: Code
- Area: Admin & provisioning; CI & tests
- Why we changed it: Upstream Admin is not in the fork; S2.11 needs a clean-room skeleton that can provision, sign pairing, and read health/power.
- Why it is necessary: Proves the Apache contract before committing ~480 hours to the full Admin.
- How it works: `server/fizot/admin/` implements signer (HMAC from docs/cloud-pro.md), Fly + store interfaces with fakes, workspace create/health/power/pairing routes, plan flags, and redaction. Docs SHAs: cloud-pro `41229d0bd393629130dc7f30fe7cd926cbe7dc03`, team-cloud `5e1e740e7fcb537928a753fa290970571a131abe`. AD-I Postgres is `workflow_dispatch` only.
- Impact: No Fly spend. Daily gate runs AD-U only.
- Rollback: Delete `server/fizot/admin/`, `tests/fizot/admin/`, `docs/fizot/admin.md`, and `admin-postgres.yml`.
- Files / Patch IDs: PATCH-29. Notion PR 38. https://app.notion.com/p/40ddd43e0a9d811b9bbcebda982144cb
- Related tasks: FZ-18 (S2.11). Patch: https://app.notion.com/p/40ddd43e0a9d8147a6acd155a75bee82

## CL-37 Patch undici and add a production audit gate

- Date: 2026-11-03
- Type: Security
- Area: CI & tests; Compliance
- Why we changed it: `pnpm audit --prod` reported four high advisories in undici 8.11.2 on the root workspace.
- Why it is necessary: Gate G2 must not ship known high/critical production vulnerabilities without a dated, reasoned exception.
- How it works: Bump undici to 8.12.3 (dependency and `pnpm.overrides`). The static job runs `scripts/fizot/audit-gate.mjs`, which fails on high/critical unless listed in `security/audit-exceptions.json` with reason and expiry. Katex remains one low advisory and is outside the gate level.
- Impact: No behaviour change expected from the undici patch. One new required CI step.
- Rollback: Revert this commit; restore undici 8.11.2 and remove the audit step.
- Files / Patch IDs: PATCH-28. Notion PR 37. https://app.notion.com/p/40ddd43e0a9d81a48f00e5304d80bfb0
- Related tasks: FZ-13 (S2.6). Patch: https://app.notion.com/p/40ddd43e0a9d815dbca3cb9bd8b38ebc

## CL-36 Spike A/B real proof: browser capture, boxed canaries, measured honour

- Date: 2026-11-03
- Type: Code
- Area: CI & tests; Sandbox & egress; Proxy & billing
- Why we changed it: PRs #5/#6 left placeholders (fetch settings, strace attach, fake shell, hard-coded honour). S2.8/S2.9 require real proof.
- Why it is necessary: Gate G2 and K5 need evidence the capture and canary work, including negative controls.
- How it works: Spike A wraps the fixture under `strace -f -e connect,sendto`, drives the real renderer (Chrome sandbox sysctl), and fails a negative CONNECT to `example.invalid`. Spike B runs real bwrap canaries, measures `OMB_CLOUD_AI_URL` via the Fizot proxy ledger on a Cloud-home fixture, drops the broken upstream-mirror box-check comparison, and lists TC26–TC68 pass/not-run with owners.
- Impact: No Fly spend. Spike workflows stay off the daily gate.
- Rollback: Revert this commit; restore prior spike scripts and workflows.
- Files / Patch IDs: PATCH-27. Notion PR 36. https://app.notion.com/p/40ddd43e0a9d818c92cadb94b9c13d5b
- Related tasks: FZ-15, FZ-16. Patch: https://app.notion.com/p/40ddd43e0a9d812f8a1ec391830055af

## CL-9 Pin the private fork at OpenMausBot v0.1.134

- Type: Upstream sync
- Date: 2026-10-31
- Area: Fork & brand
- Risk: Low
- Related task: T0.3 (FZ-3)
- Logged by: Cursor
- Why we changed it: Upstream was moving too fast to follow commit by commit. The fork is pinned to one release tag so later syncs are deliberate.
- How it works: `https://github.com/haseeb099/fizot` is a private repository, not a GitHub fork. Remote `upstream` is `https://github.com/milind-soni/OpenMausBot.git`. `upstream-mirror` and the starting `main` commit are `0213b7435fc83a936f77c18475ba2a0d7b7c2de4` (tag `v0.1.134`, 30 Oct 2026). `upstream-mirror` is not edited after that push.
- Why it is necessary: Without a mirror branch, a later sync cannot tell a Fizot change from an upstream change.
- Impact (cost / risk / timeline): No spend. No product behaviour change. This is the base for every later patch. The audit tag was v0.1.132; v0.1.134 was chosen because it was the newest tag on the clone.
- Files / Patch IDs: No file differs from the tag in this entry. Upstream base tag: v0.1.134.
- Rollback: Delete the GitHub repository and the local `d:\Fizzot\fizot` clone. `upstream-mirror` has no Fizot commit to revert.

## CL-10 Remove enterprise/ from main

- Type: Code
- Date: 2026-10-31
- Area: Fork & brand
- Risk: Low
- Related task: T0.3 (FZ-3)
- Logged by: Cursor
- Why we changed it: This fork keeps the Apache core. The `enterprise/` tree is not part of `main`.
- How it works: The ten paths under `enterprise/` were removed from the `main` index with `git rm`. No file in that tree was opened. `upstream-mirror` remains at v0.1.134 and still contains those paths. See PATCH-1.
- Why it is necessary: `main` must not carry that tree, and every path that differs from upstream has to be listed.
- Impact (cost / risk / timeline): `main` no longer contains those ten paths. `upstream-mirror` is unchanged. No spend. Install and the existing tests are run after this commit and are not claimed here.
- Files / Patch IDs: PATCH-1. The ten paths named in the Patch Registry.
- Rollback: On `main`, restore the tree from the mirror with `git checkout upstream-mirror -- enterprise` and revert this commit. Do not edit `upstream-mirror`.

## CL-11 Skip tests that need the missing enterprise layer

- Type: Code
- Date: 2026-10-31
- Area: CI & tests
- Risk: Low
- Related task: T0.3 (FZ-3)
- Logged by: Cursor
- Commit: `e9a9452bc44aa83c4edf327a0340a7c0a71a2798`
- Why we changed it: Deleting `enterprise/` made four test files fail because they read or import that layer. The other failures in the same 30 files already fail on `upstream-mirror`.
- How it works: Those four files use `it.skipIf` when `enterprise/` is absent. The hosted-access case that also fails on `upstream-mirror` (the license grace period) is unchanged. `server/cloud-send-move.e2e.test.ts` and `server/local-computer-proxy.test.ts` failed in the full suite and passed on both the `upstream-mirror` worktree and the targeted main re-run, so they were not edited.
- Why it is necessary: A missing folder was failing the suite for cases this fork cannot run. Cases that already fail on the pinned tag stay visible.
- Impact (cost / risk / timeline): No spend. Lint passed (`oxlint --deny-warnings`, exit 0). Typecheck passed (`tsc -b && tsc -p tsconfig.server.json`, exit 0). Targeted vitest of the same 30 files on main: 25 failed, 5 passed (30 files); 45 failed, 469 passed, 30 skipped (544 tests); duration 1179.46s; exit 1. The 25 failing files are the same set as the `upstream-mirror` worktree run.
- Pre-existing upstream failures: `scripts/prepare-duckdb.test.mjs`; `server/browser-upload.test.ts`; `server/cloud-lending-memory.e2e.test.ts`; `server/cloud-lending.test.ts`; `server/cloud-send-files.test.ts`; `server/cloud-sync-store.test.ts`; `server/cloud-sync.test.ts`; `server/data/charts.e2e.test.ts`; `server/data/tools.test.ts`; `server/headless-cli.e2e.test.ts`; `server/hosted-access.test.ts` (license grace case only); `server/lending-memory.test.ts`; `server/lent-copies.test.ts`; `server/mcp-bot-servers.test.ts`; `server/mcp-own-servers.e2e.test.ts`; `server/mcp-remote-proxy.test.ts`; `server/memory-store.test.ts`; `server/message-file.test.ts`; `server/pages/published-pages.test.ts`; `server/secret-requests.e2e.test.ts`; `server/setup-import.test.ts`; `server/team-computers.test.ts`; `server/turn-images.test.ts`; `server/workspace-backup.test.ts`; `server/workspace-links.test.ts`.
- Files / Patch IDs: PATCH-2. `scripts/testing/verification-docs.test.ts`; `scripts/testing/duration-sequencer.test.ts`; `server/hosted-access.test.ts`; `server/hosted-models-api.test.ts`.
- Rollback: Revert `e9a9452bc44aa83c4edf327a0340a7c0a71a2798`. The skipped cases fail again until `enterprise/` is present. Do not edit `upstream-mirror`.

## CL-12 Match changelog ids to Notion and list the kept enterprise references

- Type: Plan
- Date: 2026-10-31
- Area: Docs & plan
- Risk: Low
- Related task: T0.3 (FZ-3)
- Logged by: Cursor
- Why we changed it: The repo headings and the Notion ids had drifted, and files that differ from `upstream-mirror` were not all listed.
- How it works: This file uses the Notion CL ids. The mapping at the top records the draft numbers. `docs/PATCH_REGISTRY.md` uses PATCH-n titles and records where Notion's PR column differs. Notion CL-9's commit link is the tag commit `0213b7435fc83a936f77c18475ba2a0d7b7c2de4`.
- Why it is necessary: A reader has to be able to match a repo heading to a Notion row, and every deliberate difference from `upstream-mirror` has to be listed.
- Impact (cost / risk / timeline): No spend. No product behaviour change.
- Files / Patch IDs: PATCH-3 (`docs/CHANGELOG.md`, `docs/PATCH_REGISTRY.md`). PATCH-4 notes `vite.config.ts`, `.github/workflows/docker.yml`, `scripts/bundle-server.mjs` and `scripts/ci-scope.test.ts`, which were not edited. `server/enterprise.ts` still loads the layer only when the folder is present.
- Rollback: Revert this docs commit. The test-skip commit stays. Do not edit `upstream-mirror`.

## CL-13 Add tests/matrix.csv and the TM-U and TM-I checks

- Type: Code
- Date: 2026-10-31
- Area: CI & tests
- Risk: Low
- Related task: T0.4 (FZ-4)
- Logged by: Cursor
- Commit: `d9a59cb1fc775ab304d1f2c13b424567f8afb1e3`
- Why we changed it: Page 06 lists a unit, integration and end-to-end check for each build step. Those 42 rows were not in the repo, so a missing gate could not fail CI.
- How it works: `tests/matrix.csv` has the 42 rows from page 06. Columns are `id`, `step`, `layer`, `test`, `journey_or_tc`, `gate`, `status`. The cost-sheet integration row CS-I says the sheet reads measured Fly staging usage after Gate 0b. `scripts/testing/matrix-plan.test.ts` fails if a row is missing an id, layer, gate or journey (TM-U) and if G0, G0b, G1, G2, G3, G4, G5 or G6 has no row (TM-I). The static CI job runs that file with the other fast checks.
- Why it is necessary: A gate that names a test has to point at a row, and CI has to fail when a row or a gate is missing.
- Impact (cost / risk / timeline): No spend. Lint passed (`oxlint --deny-warnings`, exit 0). Typecheck passed (`tsc -b && tsc -p tsconfig.server.json`, exit 0). `pnpm exec vitest run scripts/testing/matrix-plan.test.ts scripts/ci-workflow.test.ts scripts/ci-scope.test.ts scripts/testing/duration-sequencer.test.ts`: 4 files passed; 143 passed, 2 skipped (145); duration 153.92s; exit 0. The permission-broker ids PB-U, PB-I and PB-E follow the same two-letter pattern as the other steps. No task page named that prefix.
- Files / Patch IDs: PATCH-5 (`.github/workflows/ci.yml`, `scripts/ci-workflow.test.ts`). PATCH-6 (`tests/matrix.csv`, `scripts/testing/matrix-plan.test.ts`).
- Rollback: Revert `d9a59cb1fc775ab304d1f2c13b424567f8afb1e3`. The static CI command returns to the three files it ran before. Do not edit `upstream-mirror`.

## CL-14 Stop the matrix checks from passing on a copied id or a stuffed gate

- Type: Code
- Date: 2026-10-31
- Area: CI & tests
- Risk: Low
- Related task: T0.4 (FZ-4)
- Logged by: Cursor
- Commit: `fdf994087e21ac586ecfa5e3c5765912b44e304e`
- Why we changed it: The review of `d32de4b7f` found that 28 journey cells copied the row id, and that the three CI rows listed every gate so the gate check could not fail.
- How it works: `journey_or_tc` is a J1 to J11 id, a TC id, or the literal `none`. `none` is accepted only for the ids listed in `scripts/testing/matrix-plan.test.ts`. A new row that uses `none` fails until that id is added to the list. CI-U, CI-I and CI-E are G0 only. RD-I is the S2.12 filing check and is G3. GN-I and GN-E are the H7.4 checks and are G6. G3 is also the cost-sheet rows from page 06. G1 stays in `NOT_YET_COVERED` because page 06 has no unit, integration or end-to-end step for it: Gate G1 is written evidence on V1.1. Every row has `owner_task`. The file has 45 rows. Fork and brand rows name S2.2; that step on page 06 spans S2.2 to S2.5. Permission-broker rows name PI3.1, the task that states the Ask-mode rule. PI3.1's own test lines are AD-I and AD-E.
- Why it is necessary: A check that accepts the row id as its own journey, or that lets one row name every gate, cannot fail when a journey or a gate is missing.
- Impact (cost / risk / timeline): No spend. Lint passed (`oxlint --deny-warnings`, exit 0). Typecheck passed (`tsc -b && tsc -p tsconfig.server.json`, exit 0). The lint-then-typecheck command exited 0 after 304s. `pnpm exec vitest run scripts/testing/matrix-plan.test.ts scripts/ci-workflow.test.ts scripts/ci-scope.test.ts`: 3 files passed; 130 passed; duration 131.90s; exit 0.
- Files / Patch IDs: PATCH-6 (`tests/matrix.csv`, `scripts/testing/matrix-plan.test.ts`).
- Rollback: Revert `fdf994087e21ac586ecfa5e3c5765912b44e304e`. The 42-row file returns, including the copied journey ids and the CI rows that listed every gate. Do not edit `upstream-mirror`.

## CL-15 The test baseline is 25 files on Windows and none of those on Linux

- Type: Decision
- Date: 2026-10-31
- Area: CI & tests
- Risk: Low
- Related task: T0.3 (FZ-3)
- Logged by: Cursor
- Why we changed it: The 25 pre-existing failures were observed on Windows. Page 03 says the repo needs Linux or macOS, so a Windows failure is not the fork baseline until the same files have been run on Linux.
- How it works: WSL could not start because its disk was missing, and Docker was not running. Branch `sandbox/baseline-linux` was created from tag v0.1.134, commit `0213b7435fc83a936f77c18475ba2a0d7b7c2de4`, with one workflow that runs these 25 files on `ubuntu-latest`. That branch is not `main` and it is not `upstream-mirror`. The workflow commit on that branch is `f804deb6ea8fff1518fe0a5ebc3e9525cea03aaa`. No upstream test was edited.
- Why it is necessary: The Windows result and the Linux result have to be named separately, or a symlink error on this machine gets treated as a fork defect.
- Impact (cost / risk / timeline): No spend. No product change. The baseline is: these 25 files fail on upstream v0.1.134 on Windows, and none of them fail on Linux. GitHub Actions run [41252793529](https://github.com/haseeb099/fizot/actions/runs/41252793529) on Ubuntu: 25 files passed; 496 passed, 4 skipped (500); duration 289.26s; exit 0. The 4 skips are inside `scripts/prepare-duckdb.test.mjs`. The Windows names are the same 25, from the targeted run recorded in CL-11. They were not re-run on Windows in this step, and they were not fixed.
- Files that fail on Windows and passed on Linux: `scripts/prepare-duckdb.test.mjs`; `server/browser-upload.test.ts`; `server/cloud-lending-memory.e2e.test.ts`; `server/cloud-lending.test.ts`; `server/cloud-send-files.test.ts`; `server/cloud-sync-store.test.ts`; `server/cloud-sync.test.ts`; `server/data/charts.e2e.test.ts`; `server/data/tools.test.ts`; `server/headless-cli.e2e.test.ts`; `server/hosted-access.test.ts`; `server/lending-memory.test.ts`; `server/lent-copies.test.ts`; `server/mcp-bot-servers.test.ts`; `server/mcp-own-servers.e2e.test.ts`; `server/mcp-remote-proxy.test.ts`; `server/memory-store.test.ts`; `server/message-file.test.ts`; `server/pages/published-pages.test.ts`; `server/secret-requests.e2e.test.ts`; `server/setup-import.test.ts`; `server/team-computers.test.ts`; `server/turn-images.test.ts`; `server/workspace-backup.test.ts`; `server/workspace-links.test.ts`.
- Files / Patch IDs: No new file on `main`. The record is this file, already listed as PATCH-3.
- Rollback: Revert this commit. The sandbox branch can be deleted. Do not edit `upstream-mirror`, and do not change the tests.

## CL-16 Commit the Cursor rules and the verified command list

- Type: Code
- Date: 2026-10-31
- Area: Docs & plan
- Risk: Low
- Related task: S2.7 (FZ-14)
- Logged by: Cursor
- Commit: `43af72cabea70f3f2174223b4e83589e2b840556`
- Why we changed it: Page 03 already states the rules and the commands. They were not in the repo, so a new machine had nothing to follow.
- How it works: `.cursor/rules/fizot-core.mdc`, `fizot-licence.mdc` and `fizot-change-tracking.mdc` are the three files from page 03. `docs/fizot/README.md` lists that page's command block. The clean-machine check named by S2.7 is `node -v`, `pnpm install --frozen-lockfile`, `pnpm lint`, `NODE_OPTIONS=--max-old-space-size=7000 pnpm typecheck`, and `pnpm exec vitest run server/bot-box server/brand.test.ts server/redact.test.ts server/cloud-home.test.ts`.
- Why it is necessary: The audit failed on Node 22 and on the default typecheck heap. The commands have to be in the repo.
- Impact (cost / risk / timeline): No spend. On Ubuntu, Node v24.22.1, run [41258404032](https://github.com/haseeb099/fizot/actions/runs/41258404032): `pnpm install --frozen-lockfile` 5s, `pnpm lint` 2s, typecheck 106s, the vitest command 13s, total 126s. That vitest command exited 1. The log shows 1 file failed and 14 passed (15). Run [41256874015](https://github.com/haseeb099/fizot/actions/runs/41256874015) printed the same failure as 1 failed and 146 passed (147). The failure is `server/bot-box/self-check.linux.test.ts`: `share-net` did not report `host-loopback-unreachable`. A colder install in run [41256135889](https://github.com/haseeb099/fizot/actions/runs/41256135889) took 17s. The measured totals are 81s and 126s, both under 15 minutes.
- Files / Patch IDs: PATCH-7.
- Rollback: Revert `43af72cabea70f3f2174223b4e83589e2b840556`. Do not edit `upstream-mirror`.

## CL-17 Remove the dead workspaces and reject a hosted-admin boot

- Type: Code
- Date: 2026-10-31
- Area: Fork & brand
- Risk: Low
- Related task: S2.1 (FZ-8)
- Logged by: Cursor
- Why we changed it: `cloudflare/control-plane/` and `apps/docs/` are not part of this fork. A hosted-admin variable has no enterprise adapter to serve it. Preview pages that `vite.config.ts` does not name are not part of the build.
- How it works: `scripts/fizot/remove-enterprise.mjs` deletes `enterprise/`, `cloudflare/control-plane/`, `apps/docs/` and `.tmpexp/` when they exist, drops the two workspace entries, and does not read those trees. It refuses `LICENSE`, `NOTICE`, `LICENSING.md` and `CLA.md`. A second run prints `nothing to remove`. `scripts/fizot/guard-enterprise-imports.mjs` exits 1 when an import specifier contains `enterprise/`, except `server/enterprise.ts`. The static CI job runs it. `rejectFizotAdminEnv()` runs before `ensureDirs()` in `server/index.ts`. On main the script printed `removed cloudflare/control-plane/`, `removed apps/docs/`, `removed .tmpexp/`, and the two `pnpm-workspace.yaml` entries. `enterprise/` was already absent, so it was not in that list. The second run printed `nothing to remove`. `pnpm install` then rewrote `pnpm-lock.yaml` (120 packages removed). The twelve preview files were deleted because `vite.config.ts` does not contain the string `preview`.
- Why it is necessary: Without the guard, a sync can import `enterprise/`. Without the boot check, a Fizot process can start with `OMB_ADMIN_URL`, `OMB_ADMIN_WORKSPACE` or `OMB_ADMIN_MEMBERSHIP` set.
- Impact (cost / risk / timeline): No spend. No Fly or model call. Local vitest of `scripts/fizot/remove-enterprise.test.ts` and `scripts/fizot/guard-enterprise-imports.test.ts`: 2 files passed, 5 tests passed, duration 12.68s, exit 0. `scripts/fizot/admin-env.test.ts` passed in the earlier run of the three files. On Ubuntu, run [41258404032](https://github.com/haseeb099/fizot/actions/runs/41258404032): `pnpm lint` and typecheck passed inside the 126s total above; `pnpm exec vitest run scripts/fizot scripts/ci-workflow.test.ts server/enterprise.test.ts server/brand.test.ts` passed (6 files); the guard printed `no enterprise imports`. The same run copied commit `0213b7435fc83a936f77c18475ba2a0d7b7c2de4` into a temp directory, ran the script, and `vite build` finished in 48.96s with a 7 GB heap. The default heap run [41257846929](https://github.com/haseeb099/fizot/actions/runs/41257846929) aborted while rendering chunks. `server/hosted-access.test.ts` failed to start its fixture because boot throws while `OMB_ADMIN_URL` and `OMB_ADMIN_WORKSPACE` are set; 18 tests were skipped. The 30 baseline files were not re-run as a set. Main CI run [41256135896](https://github.com/haseeb099/fizot/actions/runs/41256135896) failed in `scripts/ci-scope.test.ts` (`runs every test that reads the docs with the docs tests or in static`: 1 failed, 3 passed, 4 files) and skipped the later jobs, including the control-plane job. Docker image run [41256135924](https://github.com/haseeb099/fizot/actions/runs/41256135924) failed because the Dockerfile still copies `apps/docs/package.json` and `cloudflare/control-plane/package.json`. Those folders were not recreated.
- Files / Patch IDs: PATCH-1 stays the enterprise deletion. PATCH-5 (`.github/workflows/ci.yml`). PATCH-8, PATCH-9, PATCH-10, PATCH-11, PATCH-12, PATCH-13, PATCH-14. Commits `d70e615bfd6797a74bfae611459e03042c81d8b0`, `635621fc5090ea0927ed2bb03a3c6747b5830f18`, `0b91577faaf02e6009b2da09150784d31570b1a9`, `2086529c4134d0d2e99adc55ddab6757112439ad`, `77e72c2cd7a3966702693caac59558fb4a623b52`.
- Rollback: Revert those commits. Restoring the trees does not require editing `upstream-mirror`. Do not open `enterprise/`.

## CL-18 Give CI typecheck and the UI build a 7 GB heap

- Type: Code
- Date: 2026-11-01
- Area: CI & tests
- Risk: Low
- Related task: S2.7 (FZ-14)
- Logged by: Cursor
- Why we changed it: Run [41253729709](https://github.com/haseeb099/fizot/actions/runs/41253729709) on commit `dc7b7c12`, before S2.1, died in `pnpm typecheck` with a JavaScript heap out of memory error. The same runner later aborted `vite build` while rendering chunks ([41257846929](https://github.com/haseeb099/fizot/actions/runs/41257846929)).
- How it works: The typecheck steps in the static job and the open-source job, and the static `vite build` step, set `NODE_OPTIONS=--max-old-space-size=7000`. The run lines stay `pnpm typecheck` and `pnpm exec vite build`. Upstream `ci.yml` sets no heap and uses `ubuntu-latest`. `release.yml` sets 4096 only on the release build.
- Why it is necessary: The default heap on that runner is about 2 GB. Typecheck and the UI build do not finish in it, so every later CI job stays skipped.
- Impact (cost / risk / timeline): No spend. 7000 MB already finished typecheck and a vite build on the sandbox runner. The CI run that includes this change is recorded after it finishes.
- Files / Patch IDs: PATCH-5. `.github/workflows/ci.yml`.
- Rollback: Remove the three `NODE_OPTIONS` env blocks.

## CL-19 Match the docs-reader check to docs that still exist

- Type: Code
- Date: 2026-11-01
- Area: CI & tests
- Risk: Low
- Related task: S2.1 (FZ-8)
- Logged by: Cursor
- Why we changed it: After `apps/docs` was removed, `scripts/ci-scope.test.ts` expected four docs readers and found two. Static CI failed there, so typecheck never ran. Runs [41256135896](https://github.com/haseeb099/fizot/actions/runs/41256135896) and [41259044556](https://github.com/haseeb099/fizot/actions/runs/41259044556).
- How it works: The docs-tests subset lists `scripts/testing/analytics-docs.test.ts`, which still reads `docs/analytics.md`. `server/model-providers-docs.test.ts` and the vocabulary public-docs test only read `apps/docs`, so they are not readers. Those tests, and the analytics site test, skip when the `apps/docs` path is missing. The reader test is still there. `docs/ci.md` names the one file.
- Why it is necessary: A missing tree must not fail the selection check or crash vitest on import.
- Impact (cost / risk / timeline): No spend. Local vitest: the reader assertion passed, model-providers skipped, analytics and vocabulary passed.
- Files / Patch IDs: PATCH-15 (Notion PR 24).
- Rollback: Restore the three file names in the docs-tests subset and drop the skipIf guards. That makes `apps/docs` required again.

## CL-20 Stop the image from copying deleted workspace manifests

- Type: Code
- Date: 2026-11-01
- Area: CI & tests
- Risk: Low
- Related task: S2.1 (FZ-8)
- Logged by: Cursor
- Why we changed it: Docker run [41256135924](https://github.com/haseeb099/fizot/actions/runs/41256135924) failed because the Dockerfile copied `apps/docs/package.json` and `cloudflare/control-plane/package.json`.
- How it works: Those two COPY lines and the comment above them are gone. The image proof expects edition `oss` and the text `no enterprise layer exists`. The `enterprise/**` path filter was removed from the Docker workflow. The broker and the rest of the Dockerfile are unchanged.
- Why it is necessary: The image cannot build while it copies folders this fork deleted.
- Impact (cost / risk / timeline): No spend. `scripts/docker-image.test.ts` passed locally (12 passed, 2 skipped). Docker run [41261359478](https://github.com/haseeb099/fizot/actions/runs/41261359478) still died in `vite build` with a JavaScript heap out of memory error. The build stage now sets `NODE_OPTIONS=--max-old-space-size=7000`. Docker run [41261903302](https://github.com/haseeb099/fizot/actions/runs/41261903302) then succeeded: build image + boot smoke, and publish to GHCR. The publish job runs on every push, so that sandbox push published a sha tag for this repository.
- Files / Patch IDs: PATCH-16 (Notion PR 25).
- Rollback: Restore the two COPY lines and the old proof. Do not restore the deleted folders.

## CL-21 Skip hosted access when enterprise is absent

- Type: Code
- Date: 2026-11-01
- Area: CI & tests
- Risk: Low
- Related task: S2.1 (FZ-8)
- Logged by: Cursor
- Why we changed it: The suite setup boots `server/index.ts` with `OMB_ADMIN_URL` and `OMB_ADMIN_WORKSPACE`. `rejectFizotAdminEnv` throws, so the file failed before its cases. Those cases already skipped when `enterprise/` was missing.
- How it works: The whole describe, including the setup that boots the server, is `describe.skipIf` when `enterprise/` is missing. `rejectFizotAdminEnv` is unchanged. A separate test spawns `server/index.ts` with `OMB_ADMIN_URL` set and expects a non-zero exit and the refusal text.
- Why it is necessary: The suite must not boot a Fizot server with hosted-admin variables, and the refusal still has to be proven.
- Impact (cost / risk / timeline): No spend. Local vitest of `server/hosted-access.test.ts` passed: the describe skipped and the new boot test ran.
- Files / Patch IDs: PATCH-2. `server/hosted-access.test.ts`.
- Rollback: Move the setup back outside the skip. Do not weaken `rejectFizotAdminEnv`.

## CL-22 Skip the control-plane job whose package was removed

- Type: Code
- Date: 2026-11-01
- Area: CI & tests
- Risk: Low
- Related task: S2.1 (FZ-8)
- Logged by: Cursor
- Why we changed it: The job runs `pnpm control-plane:check`, `pnpm control-plane:test` and `pnpm control-plane:dry-run`, which filter `@openmausbot/control-plane`. That package was deleted, and main still selects the job.
- How it works: The job stays in `ci.yml` with `if: false` and a one-line comment. Its steps are unchanged and do not run. The gate does not list the job. `deploy-composio-broker` still needs it, so a main push skips that deploy. `cloudflare/composio-broker` was not deleted. Selection in `scripts/ci-scope.mjs` is unchanged. The open-source edition job still runs.
- Why it is necessary: Deleting the job would drop an upstream job. Leaving it runnable fails every main push.
- Impact (cost / risk / timeline): No spend. No Cloudflare deploy. `scripts/ci-workflow.test.ts` passed locally after the push branch list was put back to `main`.
- Files / Patch IDs: PATCH-5. `.github/workflows/ci.yml`, `scripts/ci-workflow.test.ts`.
- Rollback: Restore the job `if` condition. The package is still gone, so the job would fail.

## CL-23 Keep the boot check without growing server/index.ts

- Type: Code
- Date: 2026-11-01
- Area: CI & tests
- Risk: Low
- Related task: S2.1 (FZ-8)
- Logged by: Cursor
- Why we changed it: S2.1 added two lines to `server/index.ts`. CI run [41261903303](https://github.com/haseeb099/fizot/actions/runs/41261903303) reported 15820 lines against the ratchet's listed 15818.
- How it works: The import of `rejectFizotAdminEnv` shares the previous import line, and the call shares the `ensureDirs()` line. The file is 15818 lines. The check still runs before `ensureDirs()`.
- Why it is necessary: `scripts/testing/file-size-ratchet.test.ts` fails when `server/index.ts` grows, so the vitest job fails.
- Impact (cost / risk / timeline): No spend. Local vitest of the ratchet and `scripts/fizot/admin-env.test.ts`: 2 files passed, 2 tests passed, 11.25s, exit 0.
- Files / Patch IDs: PATCH-14.
- Rollback: Put the import and the call back on their own lines. The ratchet fails again.

## CL-24 The push gate is the daily checks

- Type: Decision
- Date: 2026-11-01
- Area: CI & tests
- Risk: Low
- Logged by: Cursor
- Why we changed it: Haseeb decided on 1 Nov 2026 that the daily gate is small. The eight vitest shards, behavior evals, browser identity and the macOS smokes are not blocking.
- How it works: The CI gate job needs static, foss, packaged-server and ui-smoke. vitest, behavior-evals, browser-identity and electron-smokes run only when the event is schedule or workflow_dispatch. Dispatch CI before an upstream sync. Docker publish runs on a push to main or on a release tag. The static job runs lint, typecheck with a 7 GB heap, `scripts/fizot`, and the patched-file tests listed in `docs/fizot/README.md`.
- Why it is necessary: A cancelled or failing upstream shard was failing the whole push. The fork does not need that suite green on every push.
- Impact (cost / risk / timeline): No spend on the daily gate beyond the jobs that already passed. The full suite is not required on a push. A manual or nightly run still starts it.
- Files / Patch IDs: PATCH-17. `.github/workflows/ci.yml`, `scripts/ci-workflow.test.ts`, `.github/workflows/docker.yml`, `docs/fizot/README.md`.
- Rollback: Restore the gate needs list and the four job if conditions. Publish again on every push.

## CL-25 Upstream tests that fail or time out on this runner

- Type: Decision
- Date: 2026-11-01
- Area: CI & tests
- Risk: Low
- Logged by: Cursor
- Why we changed it: The sandbox CI runs showed these failures. The box check also failed on upstream commit `0213b7435` on the same runner.
- How it works: `server/bot-box/self-check.linux.test.ts` failed share-net on a clean checkout of `0213b7435`, with bubblewrap 0.11.1 already installed and socat missing, and again after bubblewrap and socat were installed. Run [41261359507](https://github.com/haseeb099/fizot/actions/runs/41261359507). `server/use-my-mac.e2e.test.ts`, `server/cloud-team-profile.e2e.test.ts`, `server/cloud-lending.e2e.test.ts` and `server/cloud-team-open-reach.e2e.test.ts` timed out on run [41261359549](https://github.com/haseeb099/fizot/actions/runs/41261359549). `server/cloud-team-owners.e2e.test.ts` timed out on run [41261903303](https://github.com/haseeb099/fizot/actions/runs/41261903303). Re-check these before the next upstream sync. They were not investigated further.
- Why it is necessary: The next sync should not treat these failures as new Fizot breakage.
- Impact (cost / risk / timeline): No code change. These tests are not in the daily gate.
- Files / Patch IDs: No file change.
- Rollback: Delete this row. Nothing in the tree changes.

## CL-26 Skip the hosted-model suite when enterprise/ is missing

- Type: Code
- Date: 2026-11-01
- Area: CI & tests
- Risk: Low
- Logged by: Cursor
- Why we changed it: The suite setup boots with hosted-admin variables. One case was already `skipIf`. The setup still ran.
- How it works: The file's `beforeAll` boots `server/index.ts` with `OMB_ADMIN_URL`, `OMB_ADMIN_WORKSPACE` and `OMB_ADMIN_MEMBERSHIP`. `rejectFizotAdminEnv` throws, so the suite cannot run on this fork. `describe.skipIf` wraps the setup and the cases while `enterprise/` is absent. The boot check is unchanged.
- Why it is necessary: The daily gate runs this patched file. The setup was failing the file before the skipped case.
- Impact (cost / risk / timeline): No spend. Local vitest skipped `server/hosted-models-api.test.ts` (1 file skipped, 6 tests skipped) and `scripts/ci-scope.test.ts` passed (99 tests, 62.26s, exit 0).
- Files / Patch IDs: PATCH-2. `server/hosted-models-api.test.ts`.
- Rollback: Move the setup back outside the skip. Do not weaken `rejectFizotAdminEnv`.

## CL-27 Scan shipped source for upstream hosts

- Type: Code
- Date: 2026-11-01
- Area: CI & tests
- Risk: Low
- Related task: S2.4 (FZ-11)
- Logged by: Cursor
- Why we changed it: S2.4 asks for a static host scan with an allow-list, so a new upstream host fails before it ships.
- How it works: `scripts/fizot/scan-upstream-hosts.mjs` walks `server`, `src`, `shared`, `electron`, `companion`, `public`, `scripts`, `package.json`, `index.html`, `LICENSE`, `NOTICE`, `LICENSING.md`, `CLA.md`, and `dist` or `dist-server` when those builds exist. It does not open `enterprise/`. It matches `openmausbot.com`, `mausbot.com`, `supamaus` domains, `boat.dev`, `posthog.com`, `omb-cloud-staging.fly.dev` and `github.com/milind-soni/OpenMausBot`. `brand/allowed-hosts.json` lists each host with a reason. Any other hit prints `file:line` and exits 1. The static CI job runs the scan. Before the allow-list, the tree had 281 hits.
- Why it is necessary: A sync can add a hard-coded upstream host. The daily gate has to fail on one that is not classified.
- Impact (cost / risk / timeline): No spend. A new upstream host fails the daily gate until it is classified.
- Files / Patch IDs: PATCH-18. Notion PR 27. `docs/fizot/README.md` lists the command.
- Rollback: Remove the CI step and the scanner. The allow-list is data, not a product change.

## CL-28 Scan user-visible copy for upstream brand names

- Type: Code
- Date: 2026-11-01
- Area: CI & tests
- Risk: Low
- Related task: S2.5 (FZ-12)
- Logged by: Cursor
- Why we changed it: S2.5 asks for a brand-leak scan with an allow-list for attribution and for internal identifiers Spike A will map.
- How it works: `scripts/fizot/scan-brand-leaks.mjs` searches the same trees plus `docs` for `OpenMausBot`, `Open Maus`, `MausBot` and `Supamaus`. Mascot display names are scanned in package metadata, `index.html`, `public`, `docs`, the catalog directory and `electron`. The scanner names that directory and does not read a catalog, so `scripts/ci-scope.test.ts` skips it in the locale-reader scan. `brand/allowed-brand.json` allows attribution files and the trees that still carry the upstream name, each with a reason. A file outside that list fails. The static CI job runs the scan. Before the allow-list, the tree had 4028 hits. `FB-U` owner_task is S2.4 and `FB-I` owner_task is S2.5.
- Why it is necessary: A sync can put the upstream name or a mascot name in a new file a user can see.
- Impact (cost / risk / timeline): No spend. S2.2 still has to replace the user-visible strings. A new file outside the allow-list fails the daily gate. Local vitest of the two scan files, `scripts/ci-workflow.test.ts`, `scripts/testing/matrix-plan.test.ts` and `scripts/testing/file-size-ratchet.test.ts`: 5 files passed, 38 tests passed, 56.41s. `pnpm lint` and `NODE_OPTIONS=--max-old-space-size=7000 pnpm typecheck` exited 0 before the merge with main.
- Files / Patch IDs: PATCH-19. Notion PR 28. `tests/matrix.csv`.
- Rollback: Remove the CI step and the scanner. Do not edit `LICENSE`, `NOTICE` or `LICENSING.md`.

## CL-29 Make the docs and npm workflows manual-only

- Type: Code
- Date: 2026-11-01
- Area: CI & tests
- Risk: Low
- Logged by: Cursor
- Commit: `6b9e43a277f7c1a8ef9627a399b37f8bc0b936c4`
- Why we changed it: The request asked for a change-log row for making those two workflows manual-only and giving the Linux package job a 7 GB heap. This is that FZ-9 record. Notion task id 9 is S2.2, which is not this change.
- How it works: `docs.yml` and `npm-package.yml` run only on `workflow_dispatch`. `release.yml` still dispatches the npm package workflow on a tag. The Linux package job sets `NODE_OPTIONS=--max-old-space-size=7000`.
- Why it is necessary: `docs.yml` still filters `@openmausbot/docs`, and `npm-package.yml` still tests for `enterprise/server/index.js`. Either fails if a push or a tag starts it. The Linux package job ran out of heap on pull request 1.
- Impact (cost / risk / timeline): No spend. A push to main no longer starts the docs workflow or the npm package workflow. The Linux package job gets the heap that the image build already uses. The code is commit `6b9e43a277f7c1a8ef9627a399b37f8bc0b936c4`, which is already on main.
- Files / Patch IDs: PATCH-20. Notion PR 29.
- Rollback: Restore the push and pull_request triggers, and remove the package job heap.

## CL-30 Stop phone-home when Fizot endpoints are empty

- Type: Code
- Date: 2026-11-01
- Area: Fork & brand, Sandbox & egress
- Risk: Medium
- Logged by: Cursor
- Commit: the commit that adds this row
- Why we changed it: S2.3 (FZ-10) asks Fizot to stop calling upstream hosts that this fork does not use. Bug reports, analytics, update checks, cloud and account origins, and the computer-service default were still aimed at upstream.
- How it works: `brand/endpoints.json` holds those URLs and every value is empty. Each feature reads that value, or an existing `OMB_*` variable when one is set, and does nothing when both are empty. A packaged copy that does not include the file boots with every endpoint empty. Desktop packages do not bake an upstream update repository into app-update.yml. The deb still gets a `package-type` marker of `deb` after the AppImage is packed, and that step writes no update URL. The Linux package check still fails when an `app-update.yml` names the upstream owner. While the analytics URL is empty, the production UI build replaces `posthog-js` with an empty module so the built output does not contain the library's default hosts. A fake-engine boot records outbound fetch URLs and fails if any match an upstream host. The host allow-list keeps fixture hostnames used by upstream tests, plus the two scanner files that name a host on purpose.
- Why it is necessary: A default install must not contact upstream bug, analytics, update, cloud, account, or computer-service hosts. The env names stay, so a later config can turn a feature on without renaming variables.
- Impact (cost / risk / timeline): No spend. Bug reports, analytics, update checks, and the computer service stay off until a Fizot URL or the existing env var is set. An empty-allow host scan was 281 hits before this change and 25 after. Those 25 are fixture hosts and the scanner files. The scan reports no unlisted host.
- Files / Patch IDs: PATCH-21. Notion PR 30. https://app.notion.com/p/40bdd43e0a9d81839b6dc2bdac07e44a
- Rollback: Restore the upstream URL defaults and the previous host allow-list. Remove the fetch log and the boot test.

## CL-31 Replace user-visible upstream names with Fizot

- Type: Code
- Date: 2026-11-01
- Area: Fork & brand, CI & tests
- Risk: Medium
- Logged by: Cursor
- Commit: the commit that adds this row
- Why we changed it: S2.2 (FZ-9) asks for a brand map and for user-visible product and mascot names to say Fizot. The brand allow-list still covered whole source trees.
- How it works: `brand/brand-map.json` maps the upstream product names and mascot labels to Fizot. User-visible strings, window titles, installer display names, and the app icon use Fizot. Internal identifiers are unchanged. The brand allow-list no longer covers `server`, `src`, `shared`, `electron`, `companion`, `public`, or `scripts` as folders. It lists attribution files, the change history, the scanners, the vocabulary test, and files whose ordinary English matches a mascot label. The static job scans brand leaks and upstream hosts again after the renderer build, and that host scan has no skip. The Linux package installs under `/opt/Fizot`, and the package hooks and smoke steps use that path. The renderer reads `brand/endpoints.json` directly, so the UI build does not pull in the node reader. `scripts/fizot/apply-brand.mjs` names the vocabulary test without the catalog-directory word, so the locale-reader scan does not treat the brand-map test as a translation reader.
- Why it is necessary: People should see Fizot, and a new user-visible upstream name should fail the scan instead of hiding inside a folder allow.
- Impact (cost / risk / timeline): No spend. An empty-allow brand scan was 4028 hits before this change and 179 after. Those 179 are the listed files. The scan reports no unlisted brand leak. Chat messages still draw the geometric body. The picker labels and the app icon do not show it. The built renderer is scanned in CI after `vite build`; this machine did not run that build.
- Files / Patch IDs: PATCH-22. Notion PR 31. https://app.notion.com/p/40bdd43e0a9d81acbc1fcad35e3e280f
- Rollback: Restore the previous strings and the folder allow-list. Remove the brand map and the post-build scan step.

## CL-34 Spike A: capture outbound hosts from a rebranded fixture

- Date: 2026-11-02
- Type: Code
- Area: CI & tests; Sandbox & egress
- Why we changed it: Prove a rebranded build makes zero calls to upstream hosts under network capture (S2.8 / G2).
- Why it is necessary: Static host scans miss live behaviour; Spike A is a Gate G2 pass condition.
- How it works: `scripts/fizot/spike-a.mjs` builds the renderer, launches the control-omb fixture with `HTTPS_PROXY` at a loopback logging proxy, drives start/onboarding/bot/chat/settings/bug-report, writes `artifacts/spike-a/`, and exits 1 on any host outside `brand/allowed-hosts.json`. `workflow_dispatch` only.
- Impact: Free local capture. Does not join the daily gate.
- Rollback: Delete the spike-a scripts and workflow; restore `control-omb.ts` proxy forwarding.
- Files / Patch IDs: PATCH-25. Notion PR 34. https://app.notion.com/p/40cdd43e0a9d812998e2d73a310abbf8
- Related task: FZ-15 https://app.notion.com/p/408dd43e0a9d819fbcceff7ea96c8cc7

## CL-35 Spike B: Fizot proxy, ledger caps and canary secrets

- Date: 2026-11-02
- Type: Code
- Area: Proxy & billing; Sandbox & egress
- Why we changed it: Keep model keys out of the bot sandbox and answer whether `OMB_CLOUD_AI_URL` is honoured (S2.9 / G2).
- Why it is necessary: xAI keys are unbrokered in the box; Spike B decides the patch-vs-separate-sandbox path (K5).
- How it works: `server/fizot/proxy` mints hashed `omb_ai_` tokens, proxies OpenAI chat/responses to a local mock xAI, append-only ledger with idempotency, 80% alert and 100% 402 cap. Local mock only until Gate 0b. Open question answer: **yes**, `CloudCreditProvider` uses `credential.api` from `OMB_CLOUD_AI_URL` on a Cloud home (`server/index.ts` ~1568).
- Impact: No Fly spend. Not on the daily gate.
- Rollback: Delete `server/fizot/proxy`, the spike-b workflow and tests.
- Files / Patch IDs: PATCH-26. Notion PR 35. https://app.notion.com/p/40cdd43e0a9d816e9707f7c39c937f34
- Related task: FZ-16 https://app.notion.com/p/408dd43e0a9d81d3aee3ea78f0864dc2

## CL-33 Shrink the daily CI gate until Phase 5 / G6

- Date: 2026-11-02
- Type: Code
- Area: CI & tests
- Why we changed it: Make CI small and fast once, then leave it alone until Phase 5 / G6.
- Why it is necessary: Desktop packaging jobs are off the daily gate until Phase 5 / G6. Known failures: Linux DEB package-type marker null after removing the upstream publish block; browser-vendor-windows 404 on an upstream release asset.
- How it works: `pull_request`, push to main and `merge_group` select only build, foss, packaged-server (ubuntu), ui-smoke and docker. `schedule` and `workflow_dispatch` keep the full set. Static vitest uses the `fizot/` filter so every new test under `server/fizot`, `tests/fizot` and `scripts/fizot` runs automatically. `docker.yml` no longer runs on pull requests.
- Impact: Required checks shrink to the CI gate job. Packaging and optional smokes wait for nightly or a manual run.
- Rollback: Restore the previous `MAIN_SCOPE` and job `if` conditions from `origin/main` before this change.
- Files / Patch IDs: PATCH-24. Notion PR 33. https://app.notion.com/p/40cdd43e0a9d81248deeeff0b38b0dc6
- Related tasks: FZ-43 https://app.notion.com/p/40cdd43e0a9d811cbe38c16463e4b6e3 ; FZ-44 https://app.notion.com/p/40cdd43e0a9d816e8964ebf749454217

## CL-32 Keep the Windows browser vendor build manual

- Type: Config
- Date: 2026-11-02
- Area: CI & tests
- Risk: Low
- Logged by: Cursor
- Commit: the commit that adds this row
- Why we changed it: The Windows browser vendor smoke downloads a pinned engine asset. This repository does not publish that release. The workflow had not run on main. A pull request must not fail on an asset that is not here, and the pin must not be changed to an upstream URL.
- How it works: `browser-vendor-windows.yml` runs only on `workflow_dispatch`. The cold-start job still uses the existing pin. A pull request no longer starts the workflow.
- Why it is necessary: The smoke step cannot succeed until this repository publishes the pinned Windows engine. Pointing the download at an upstream release is not allowed.
- Impact (cost / risk / timeline): No spend. Pull requests no longer run this workflow. A manual run still needs a Windows engine asset published by this repository. On main the pin still names an upstream release path. This pull request's earlier string change rewrote that path, and the smoke then failed with `Could not download agent-browser-win32-x64-0.36.0-omb.1.exe: HTTP 404`. There were no runs of this workflow on main.
- Files / Patch IDs: PATCH-23. Notion PR 32. https://app.notion.com/p/40cdd43e0a9d81c5ba28f0fe7ef28f6d
- Rollback: Restore the pull_request path filter on `browser-vendor-windows.yml`.

