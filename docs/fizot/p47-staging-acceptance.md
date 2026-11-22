# P4.7 SE-I / SE-E staging acceptance (Fly)

**Do not run against production. Do not paste secrets into chat. Do not create paid Fly resources without owner approval.**

## Goal

Produce evidence for:

| ID | Claim |
| --- | --- |
| TC52 | Metadata endpoints refuse from the sandbox |
| TC54 | Sandbox cannot reach this instance’s own private / 6PN address |
| TC28 / TC59 | Tenant A cannot reach tenant B (two-tenant isolation) |
| SE-I | Integration acceptance for the above |
| SE-E | J2 / J6 browser journeys on a hardened Cloud home (after SE-I green) |

## Harness status

| Layer | Status |
| --- | --- |
| Unit harness (`isolation-harness.ts` + vitest) | Implemented — interprets PASS/FAIL/INCONCLUSIVE; timeouts ≠ refuse |
| Live Fly `mode=isolation` | Implemented in `fly-staging-roundtrip.mjs` — **owner must run**; not executed in this PR |
| SE-I / SE-E matrix | Remain `planned` until a green owner staging run produces evidence |
| P4.7 / G4 | **Not complete** |

Naming apps with `fizot-net-*` alone does **not** prove isolation. TC59 network probes run on tenant A’s guest via `flyctl ssh` and require `ENETUNREACH` / `EHOSTUNREACH` (or an explicit policy refuse). `ECONNREFUSED`, bare timeouts, and unrelated DNS/errors are **INCONCLUSIVE**.

## Prerequisites (owner-provided, out of band)

- Fly org with staging apps (e.g. `fizot`; override with `FLY_ORG`)
- Repo secret `FLY_API_TOKEN` — Machines / apps read+write for **staging only**
- Ability to set `OMB_SLACK_RELAY_TOKEN` on staging Cloud homes (SE-E later; not required for isolation probes)
- No production Stripe / customer workspaces
- Optional: `FIZOT_PRODUCTION_FLY_ORGS` comma-list — harness refuses those org slugs
- Cost guard: max **2** live staging machines (`MAX_STAGING_MACHINES`); isolation uses both for the probe window

## Exact scripts

```bash
# Unit harness (CI / local; no Fly)
pnpm exec vitest run tests/fizot/sandbox/

# Live Fly — owner only after authorizing spend
# Workflow (manual): .github/workflows/fly-staging-roundtrip.yml
#   inputs: fly_org=<staging-org>  mode=isolation  fly_region=lhr (optional)
#
# Or locally (never production):
#   FLY_API_TOKEN=… FLY_ORG=… FIZOT_MACHINE_IMAGE=… FIZOT_ROUNDTRIP_MODE=isolation \
#   node --experimental-strip-types scripts/fizot/fly-staging-roundtrip.mjs
# Always-on leftover sweep:
#   FLY_STAGING_MAX_AGE_MS=0 node --experimental-strip-types scripts/fizot/fly-staging-cleanup.mjs
```

## What `mode=isolation` does

1. Creates disposable staging workspaces A and B (`fizot-cm-*` only).
2. Waits for health; reads each machine’s `privateIp` and per-workspace Fly `network`.
3. From A’s policy path (`fizotCloudRefusal`): metadata, self-address, peer-private (TC52/TC54/TC28/TC59 policy).
4. From A’s guest OS via `flyctl ssh`: TCP probes to metadata / self / peer (network boundary).
5. Writes `artifacts/fly-staging/isolation-evidence.json` (git SHA, case IDs, app/machine ids, destination class, verdict, refusal reason, cleanup).
6. Destroys both apps (Admin erase with Fly destroy fallback); workflow `always()` cleanup also sweeps `fizot-cm-*`.

## Expected results

- Policy refuse reasons: `metadata`, `local-network` / `self-address`, `dns-exfil` as applicable — never a successful tunnel on those targets.
- Network peer probe: unreachable at the Fly private-network boundary (not merely “connection refused to an open port”).
- Artifacts under `artifacts/fly-staging/` with secrets redacted. No customer data.

## Evidence fields

- Exact Git SHA
- Test case ID + destination class
- Environment type (`staging-fly` / `staging-fake`)
- Staging app and machine identifiers
- Observed enforcement result + PASS/FAIL/INCONCLUSIVE
- Refusal reason (or null when inconclusive)
- Cleanup outcome
- Workflow run URL when `GITHUB_*` is set

## Failure / rollback

- On unexpected allow (`FAIL`): stop; cleanup still runs; leave triage only if cost-guard allows — prefer cleanup workflow.
- Do not mark SE-I/SE-E or P4.7/G4 Done without a green evidence file from an authorized staging run.
- Revert candidate is the PR under test; staging apps are disposable.

## SE-E (after SE-I)

- J2 / J6 browser journeys through gated Chrome on a Cloud home with the Cloud SOCKS decide.
- Matrix rows `SE-E` remain `planned` until those journeys are green on staging.
