# Fizot Admin skeleton (S2.11)

Clean-room Admin built only from `docs/cloud-pro.md`, `docs/team-cloud.md`, and
the Apache server helpers in `server/cloud-home.ts` / `server/cloud-team.ts` /
`server/cloud-secrets.ts`. Docs blob SHAs used for this skeleton (at the
implementing commit's base):

- `docs/cloud-pro.md` → `41229d0bd393629130dc7f30fe7cd926cbe7dc03`
- `docs/team-cloud.md` → `5e1e740e7fcb537928a753fa290970571a131abe`
- containing commit: `bdb422c8d17b842f7754ab3b0a22366f25f0b8dc`

Code lives under `server/fizot/admin/`. Tests under `tests/fizot/admin/` so the
daily gate's `fizot/` vitest filter picks them up.

## Endpoints

| Method | Path | Behaviour |
| --- | --- | --- |
| `POST` | `/admin/workspaces` | Create one Fly app (own network), allocate shared IPv4 + IPv6, 10 GB volume, one machine with `OMB_CLOUD_ROLE`, `OMB_CLOUD_MACHINE_ID`, `OMB_PUBLIC_URL`; set secrets `OMB_CLOUD_ADMIN_URL` and `OMB_CLOUD_BOOTSTRAP_SECRET`. |
| `GET` | `/admin/workspaces/:id/health` | Signed `GET /api/cloud/health?after=0` to the machine. |
| `GET` | `/admin/workspaces/:id/power` | Signed `GET /api/cloud/power` to the machine. |
| `POST` | `/admin/workspaces/:id/sleep` | Wait until power is idle, signed `POST /api/cloud/power/sleep`, then Fly Machines `suspend` (fallback `stop`; staging keeps `auto_destroy`, so stop would destroy). |
| `POST` | `/admin/workspaces/:id/wake` | Fly Machines `start`, wait for `started`, then health 200. |
| `POST` | `/admin/workspaces/:id/pairing` | Signed `POST /api/cloud/pairing`; returns `pairingLink`. Team plan requires a `member` claim (`owner`/`admin` → admin+client scopes; `member` → client). |
| `DELETE` | `/admin/workspaces/:id` | Destroy the Fly app (force) and drop the store row. |

Signer: HMAC-SHA256 over `v1\n<timestamp>\n<nonce>\n<METHOD>\n<path+query>\n<bodyHash>` (base64url), ±300 s skew, nonces refused for 10 minutes.

## Environment

| Variable | Role |
| --- | --- |
| `FIZOT_ADMIN_URL` | Value written as `OMB_CLOUD_ADMIN_URL` on the machine. |
| `FLY_ORG` / `FLY_REGION` | Staging org and region. |
| `FLY_API_TOKEN` | Fly Machines API token. Required for the real client; never logged or committed. |
| `FIZOT_MACHINE_IMAGE` | Machine image reference (`registry.fly.io/...`). |
| `ADMIN_DATABASE_URL` | When set, workspaces use Postgres instead of the in-memory store. |

Never set `OMB_ADMIN_URL`, `OMB_ADMIN_WORKSPACE`, or `OMB_ADMIN_MEMBERSHIP` on a Fizot machine.

## Cost guard (Gate G0b, 100 GBP/month)

- Refuse creating more than 2 live staging machines (`fizot-cm-*`).
- Every machine is created with `auto_destroy: true`.
- Projected daily cost (shared-cpu-1x **2 GB** = $12.70/mo + 10 GB volume, from https://fly.io/docs/about/pricing/ via `cost-sheet.ts`) is printed before each create / staging run.
- `.github/workflows/fly-staging-cleanup.yml` destroys `fizot-cm-*` apps older than 24 hours (schedule + `workflow_dispatch`).
- `scripts/fizot/fly-cost-probe.mjs` records machine seconds / volume into `artifacts/s2-10/` and refuses more than one hour of machine observation.

## What ran for real vs what is still faked

| Surface | Daily gate | Manual Fly staging (`fly-staging-roundtrip.yml`) |
| --- | --- | --- |
| Fly Machines API | Fake (`createFakeFlyClient`) | Real (`createFlyMachinesClient`, token from `FLY_API_TOKEN`); allocates shared IPv4 + IPv6 via `ip_assignments` (GraphQL fallback) |
| Workspace store | In-memory | In-memory for the round-trip script |
| Machine HTTP (health / power / pairing) | Injected `machineFetch` / loopback | Real machine at `https://<app>.fly.dev` |
| Signer / nonce | Real HMAC; in-memory nonce store | Real HMAC against the live machine; wrong signature + replayed nonce must return 401 |
| Cost probe (S2.10) | Not run | `fly-cost-probe.mjs` → `artifacts/s2-10/*.json` (egress bytes not on Machines list API → `null`) |
| Postgres tenant routing (AD-I) | Not run | Separate `admin-postgres.yml` only |

Matrix rows **AD-I** and **CS-I** stay `planned` until a green `fly-staging-roundtrip` workflow run is on record. The daily CI gate is unchanged: Fly staging stays `workflow_dispatch` only.

## Manual staging workflow

`.github/workflows/fly-staging-roundtrip.yml` (`workflow_dispatch`):

1. Requires repo secret `FLY_API_TOKEN` and input `fly_org`.
2. Builds Dockerfile `--target cloud-home` (no Grok / engine CLIs) and pushes to `registry.fly.io/fizot-home-image:staging`.
3. Runs `scripts/fizot/fly-staging-roundtrip.mjs`: create → wait health → pairing → power → awake probe → negatives → sleep (idle wait + Fly stop) → assert stopped → 60 s asleep probe → wake → health 200 → destroy → assert app gone.
4. Always runs the 24h cleanup script (max age 0 for leftovers from the run).
