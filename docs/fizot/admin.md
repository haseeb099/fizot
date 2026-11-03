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
| `POST` | `/admin/workspaces` | Create one Fly app (own network), 10 GB volume, one machine with `OMB_CLOUD_ROLE`, `OMB_CLOUD_MACHINE_ID`, `OMB_PUBLIC_URL`; set secrets `OMB_CLOUD_ADMIN_URL` and `OMB_CLOUD_BOOTSTRAP_SECRET`. |
| `GET` | `/admin/workspaces/:id/health` | Signed `GET /api/cloud/health?after=0` to the machine. |
| `GET` | `/admin/workspaces/:id/power` | Signed `GET /api/cloud/power` to the machine. |
| `POST` | `/admin/workspaces/:id/pairing` | Signed `POST /api/cloud/pairing`; returns `pairingLink`. Team plan requires a `member` claim (`owner`/`admin` → admin+client scopes; `member` → client). |

Signer: HMAC-SHA256 over `v1\n<timestamp>\n<nonce>\n<METHOD>\n<path+query>\n<bodyHash>` (base64url), ±300 s skew, nonces refused for 10 minutes.

## Environment

| Variable | Role |
| --- | --- |
| `FIZOT_ADMIN_URL` | Value written as `OMB_CLOUD_ADMIN_URL` on the machine. |
| `FLY_ORG` / `FLY_REGION` | Staging org and region (unused while Fly is faked). |
| `FIZOT_MACHINE_IMAGE` | Machine image reference. |
| `ADMIN_DATABASE_URL` | When set, workspaces use Postgres instead of the in-memory store. |

Never set `OMB_ADMIN_URL`, `OMB_ADMIN_WORKSPACE`, or `OMB_ADMIN_MEMBERSHIP` on a Fizot machine.

## What is faked in the daily gate

- Fly Machines API: `createFakeFlyClient()` — no network, no spend.
- Workspace store: in-memory map.
- Machine HTTP: tests inject `machineFetch` / a loopback listener.
- Nonce store: in-memory map with 10-minute TTL.

## What still needs a real Fly staging org

The signed round trip to a live machine (create app → health → pairing → delete
within 24 hours) is blocked until Gate 0b sets a spend cap. AD-I's Postgres
tenant-routing case runs only from
`.github/workflows/admin-postgres.yml` (`workflow_dispatch` + Postgres service).
