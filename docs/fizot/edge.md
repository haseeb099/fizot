# Fizot Edge — auth, tenant routing, Team roles (P4.1)

Clean-room from `docs/cloud-pro.md`, `docs/team-cloud.md`, and Apache
`server/cloud-home.ts` / `server/cloud-team.ts`. No `enterprise/` imports.

Code: `server/fizot/edge/` (routing) and `server/fizot/admin/` (accounts,
memberships, sessions, invites, AuthProvider, object-level authorisation).

## AuthProvider

Sign-in is bought later. Do not pick a vendor in this layer.

```ts
interface AuthProvider {
  resolveIdentity(input: { email?: string; subject?: string }): Promise<{
    email: string;
    subject: string;
  }>;
}
```

- `FakeAuthProvider` — email is the identity (tests / explicit staging only).
- `UnconfiguredAuthProvider` — default outside `NODE_ENV=test`; refuses until a
  vendor is wired. `createAdminServer` fails closed on this provider.
- Sessions are Fizot-issued: cookie `fizot_admin_session`, HttpOnly, **Secure by
  default**, SameSite=Lax; token hashed server-side; rotation on sign-in;
  revocation via `revoked_at`.

Public allow-list (no session): `GET /edge/health`, and `POST /edge/auth/fake-sign-in`
only when `FakeAuthProvider` is in use (`NODE_ENV=test` or `auth` passed
explicitly). In every other mode fake-sign-in returns **404**. Production
(`NODE_ENV` or `FIZOT_ENV` = `production`) refuses to start without
`ADMIN_DATABASE_URL` (no silent memory store).

Everything else needs a session; workspace-scoped routes also need membership
via `authorizeWorkspaceAccess`. The HTTP server dispatches **only** through
`ROUTE_REGISTRY` (auth level + handler per entry).

## Edge routing

`POST /edge/workspaces/:workspaceId/open`:

1. Resolve session cookie.
2. `authorizeWorkspaceAccess` (membership JOIN; unknown and forbidden → same 404).
3. Call Admin `workspacePairing` which signs the cloud-home pairing request
   (HMAC over method, path+query, timestamp, nonce, body hash). For Team
   workspaces the signed body carries the member's email and **membership
   role from the store** (owner/admin → admin+client scopes; member → client
   only). A client-supplied `role` in the Edge body is ignored.
4. Return `pairingLink` (and scopes) to the member. Never forwards a
   client-supplied workspace id without the membership check.

## Team roles and invites

- Roles: exactly one Owner (paying account; cannot be removed/demoted except
  by transfer); Admin manages members/settings/invites; Member uses the
  workspace. Every membership route goes through `authorizeWorkspaceAccess`
  with `minRole` from `ROUTE_REGISTRY` — never inline role checks.
- Invites: `POST/GET/DELETE /admin/workspaces/:id/invites` and
  `POST /edge/invites/:token/accept`. Tokens are 32 random bytes, stored
  hashed, single-use, 7-day expiry, email-bound (wrong signed-in email → same
  404 as unknown token). Admin may invite members; only Owner may invite
  admins. Seat limit from `plans.ts` (`home`=1, `team`=5); over → 409
  `seat_limit`.
- Remove member: revoke sessions and signed `POST /api/cloud/team/member-left`
  so private chats are deleted on the machine (Apache path; Admin never
  receives chat content).
- Admin member list returns metadata only (email, role, joinedAt).

## Object-level authorisation

Every Admin/Edge workspace route must call `authorizeWorkspaceAccess` (one
helper). TC36 enumerates `ROUTE_REGISTRY` and fails if a route is neither
`public` (explicit allow-list) nor covered by the helper path
(`session` / `membership`). Adding a route outside the registry or without
auth turns CI red.

## Independent request-signature known-answer (fixes circular S2.x test)

Canonical string (docs/cloud-pro.md contract v1):

```text
v1\n<timestamp>\n<nonce>\n<METHOD>\n<path+query>\n<bodyHash>
```

where `bodyHash` is base64url(SHA-256(raw body)), and the signature is
base64url(HMAC-SHA256(secret, canonical)). Header form: `v1=<signature>`.

Known-answer vector (fixed inputs; expected HMAC is produced by
`scripts/fizot/independent-hmac-kat.mjs` using only `node:crypto` — it must
not import `server/cloud-home.ts` or `server/fizot/admin/signer.ts`):

| Field | Value |
| --- | --- |
| secret | `kat-secret-32-bytes-base64url!!!!` (ASCII, 32 chars) |
| timestamp | `1790000000` |
| nonce | `n`.repeat(16) → `nnnnnnnnnnnnnnnn` |
| method | `POST` |
| target | `/api/cloud/pairing` |
| body | `{"label":"Fizot app (Cloud)","ttlSeconds":300}` (UTF-8) |

`tests/fizot/admin/signer-kat.test.ts` runs the independent script and
compares to `adminRequestSignature`. If they disagree the test fails.
