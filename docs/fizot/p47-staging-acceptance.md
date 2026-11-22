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

## Prerequisites (owner-provided, out of band)

- Fly org with staging apps (e.g. `fizot` staging machines already used by `fly-staging-roundtrip`)
- Token with Machines / apps read+write for **staging only**
- Ability to set `OMB_SLACK_RELAY_TOKEN` on staging Cloud homes
- No production Stripe / customer workspaces

## Exact scripts (existing)

```bash
# From repo root, with staging secrets in the environment / Actions secrets — never committed.
pnpm exec vitest run tests/fizot/sandbox/
node --experimental-strip-types scripts/fizot/fly-staging-roundtrip.mjs
# Workflow (manual): .github/workflows/fly-staging-roundtrip.yml
```

Two-tenant isolation needs **two** provisioned workspaces (two `fizot-net-*` networks). Prefer extending the staging roundtrip with a `mode=isolation` that:

1. Creates workspace A and B (or reuses disposable staging apps).
2. From A’s box / browser gate, attempts CONNECT/SOCKS to B’s private / 6PN address → expect refuse.
3. From A, attempts metadata `169.254.169.254` → expect refuse (TC52).
4. From A, attempts A’s own interface address → expect refuse (TC54).
5. Destroys both apps; asserts remainingCount 0 (existing cleanup).

## Expected results

- Policy refuse reasons: `metadata`, `local-network` / `self-address`, `dns-exfil` as applicable — never a successful TCP tunnel.
- Artifacts under `artifacts/fly-staging/` (JSON summary + refusal counts). No secret values in logs.

## Evidence to capture

- Git SHA under test
- Fly app names / machine IDs (staging)
- Refusal reason counts per TC
- Workflow run URL
- Confirmation cleanup deleted both apps

## Failure / rollback

- On any unexpected allow: stop, leave apps for triage only if cost-guard allows; otherwise run cleanup workflow.
- Do not mark SE-I/SE-E or P4.7/G4 Done.
- Revert candidate is the PR under test; staging apps are disposable.

## SE-E (after SE-I)

- J2 / J6 browser journeys through gated Chrome on a Cloud home with the new SOCKS decide.
- Matrix rows `SE-E` remain `planned` until those journeys are green on staging.
