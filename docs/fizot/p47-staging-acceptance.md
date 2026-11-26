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

## Code-level PASS vs live Fly evidence

| Layer | What it proves | Status |
| --- | --- | --- |
| Unit harness (`isolation-harness.ts`, `staging-safety.ts`) | Probe interpretation; run-scoped cleanup selection; preflight fail-closed; cleanup failure ≠ acceptance | **Code PASS** (CI) |
| Workflow safety (concurrency, preflight step, run-scoped cleanup) | Process controls before/after spend | **Code PASS** when CI green — not live Fly proof |
| Live Fly `mode=isolation` | Actual TC28/TC52/TC54/TC59 on org `fizot` | **Not run** until owner authorizes |
| SE-I / SE-E matrix | Acceptance rows | Remain `planned` until green live evidence |
| P4.7 / G4 | Gate complete | **Not complete** |

Naming apps with `fizot-net-*` alone does **not** prove isolation. TC59 network probes run on tenant A’s guest via `flyctl ssh` and require `ENETUNREACH` / `EHOSTUNREACH` (or an explicit policy refuse). `ECONNREFUSED`, bare timeouts, and unrelated DNS/errors are **INCONCLUSIVE**.

## Prerequisites (owner-provided, out of band)

- Fly org `fizot` dedicated to staging (owner-reported: only `fizot-home-image`)
- Repo secret `FLY_API_TOKEN` — staging org Machines / apps read+write only (scope still owner-verified)
- Confirm nothing else pulls `registry.fly.io/fizot-home-image:staging`
- No production Stripe / customer workspaces
- Optional: `FIZOT_PRODUCTION_FLY_ORGS` — preflight refuses those org slugs
- Cost guard: max **2** live staging machines; isolation uses both for the probe window
- Exclusive use of org `fizot` for the duration of the workflow (see concurrency limits below)

## Manual preflight (owner, before first spend)

```bash
# Read-only. Do not create or destroy.
flyctl auth whoami
flyctl orgs list
flyctl apps list -o fizot
# Expect only fizot-home-image (or empty + image). No customer/prod apps.
flyctl machine list -a fizot-home-image   # should be empty / image-only app
```

Then dispatch the workflow (or run scripts below). The workflow also runs
`scripts/fizot/fly-staging-preflight.mjs` **before** image build or machine create
and fails closed on unexpected apps. Isolation mode additionally refuses any
pre-existing `fizot-cm-*`.

## Exact staging run procedure

1. Confirm preflight inventory (above).
2. GitHub → Actions → **Fizot Fly staging roundtrip** → Run workflow:
   - `fly_org`: `fizot`
   - `mode`: `isolation`
   - `fly_region`: `lhr` (optional)
3. Wait for completion. Download artifact `fly-staging-roundtrip`.
4. Open `isolation-evidence.json`:
   - `summary.overall` must be `PASS`
   - `cleanup.outcome` must be `ok`
   - Failed cleanup **cannot** be treated as SE-I acceptance
5. Confirm no leftover `fizot-cm-*` (`flyctl apps list -o fizot`).

```bash
# Unit / safety tests (CI / local; no Fly)
pnpm exec vitest run tests/fizot/sandbox/ tests/fizot/admin/staging-safety.test.ts

# Live Fly — owner only after authorizing spend
# Workflow inputs above, or locally:
#   FLY_API_TOKEN=… FLY_ORG=fizot FIZOT_MACHINE_IMAGE=registry.fly.io/fizot-home-image:staging \
#   node --experimental-strip-types scripts/fizot/fly-staging-preflight.mjs
#   FIZOT_ROUNDTRIP_MODE=isolation node --experimental-strip-types scripts/fizot/fly-staging-roundtrip.mjs
# Run-scoped leftover cleanup (manifest only — never all fizot-cm-*):
#   FLY_STAGING_CLEANUP_MODE=run-scoped node --experimental-strip-types scripts/fizot/fly-staging-cleanup.mjs
# Scheduled orphan age cleanup (24h; refuses MAX_AGE_MS=0):
#   FLY_STAGING_CLEANUP_MODE=age FLY_STAGING_MAX_AGE_MS=86400000 \
#   node --experimental-strip-types scripts/fizot/fly-staging-cleanup.mjs
```

## Safety controls

### Run-scoped cleanup

- Each staging script writes `artifacts/fly-staging/run-manifest.json` as apps are created.
- Workflow `always()` cleanup uses `FLY_STAGING_CLEANUP_MODE=run-scoped` and destroys **only** names in that manifest (after org + `fizot-cm-*` validation).
- It never silently falls back to deleting every `fizot-cm-*` app.
- Missing manifest → no-op (orphans rely on the 24h age job).

### Scheduled 24h orphan cleanup

- Separate workflow; `FLY_STAGING_CLEANUP_MODE=age` with 24h max age.
- Refuses `FLY_STAGING_MAX_AGE_MS=0` unless `FLY_STAGING_ALLOW_AGE_ZERO=1` (not set in CI).
- Shares the same concurrency group as roundtrip so it waits rather than racing.

### Concurrency

- Roundtrip and cleanup use `concurrency.group: fizot-fly-staging-<org>` with `cancel-in-progress: false`.
- Overlapping isolation/home/team/erase dispatches for the same org queue; an active run is not cancelled mid-flight (so `always()` cleanup can still run).
- **Limitation:** GitHub concurrency does **not** protect against local `flyctl`, other repositories, or operators outside these workflows.

### Cost and failure / timeout behaviour

| Event | Behaviour |
| --- | --- |
| Ordinary step failure | `always()` run-scoped cleanup still runs; job fails if cleanup fails |
| Isolation probe FAIL / INCONCLUSIVE | Script exits non-zero; acceptance not claimed |
| Cleanup partial failure | Non-zero exit; `isolationAcceptanceOk` is false even if probes passed |
| Job timeout (90m) / cancel | GitHub may stop the runner before `always()` finishes — orphans possible; 24h age job removes `fizot-cm-*` older than 24h |
| Runner termination | Same as timeout; rely on age orphan cleanup |

`MAX_STAGING_MACHINES = 2` is unchanged. Isolation needs both slots free (preflight enforces empty `fizot-cm-*` for isolation).

## What `mode=isolation` does

1. Preflight inventory (workflow) then create disposable A/B (`fizot-cm-*`), recording each in the run manifest.
2. Policy + network probes (TC52/TC54/TC28/TC59).
3. Write `isolation-evidence.json`.
4. Destroy A/B (script cleanup) + workflow run-scoped cleanup of the manifest.

## Expected results

- Policy refuse reasons: `metadata`, `local-network` / `self-address`, `dns-exfil` as applicable.
- Network peer probe: unreachable at the Fly private-network boundary.
- Artifacts under `artifacts/fly-staging/` with secrets redacted. No customer data.

## Failure / rollback

- On unexpected allow (`FAIL`): stop; cleanup still attempted; prefer age orphan job if run-scoped cannot finish.
- Do not mark SE-I/SE-E or P4.7/G4 Done without a green evidence file from an authorized staging run.
- Revert candidate is the PR under test; staging apps are disposable.

## SE-E (after SE-I)

- J2 / J6 browser journeys through gated Chrome on a Cloud home with the Cloud SOCKS decide.
- Matrix rows `SE-E` remain `planned` until those journeys are green on staging.
