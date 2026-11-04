# Fizot Edge — auth and tenant routing (P4.1 part 1)

Clean-room from `docs/cloud-pro.md`, `docs/team-cloud.md`, and Apache
`server/cloud-home.ts` / `server/cloud-team.ts`. No `enterprise/` imports.

Code: `server/fizot/edge/` (routing) and `server/fizot/admin/` (accounts,
memberships, sessions, AuthProvider, object-level authorisation).

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

- `FakeAuthProvider` — email is the identity (tests / staging fake-sign-in).
- `UnconfiguredAuthProvider` — refuses until a vendor is wired.
- Sessions are Fizot-issued: cookie `fizot_admin_session`, HttpOnly, Secure
  (production), SameSite=Lax; token hashed server-side; rotation on sign-in;
  revocation via `revoked_at`.

Public allow-list (no session): `GET /edge/health`, `POST /edge/auth/fake-sign-in`
(FakeAuthProvider only). Everything else needs a session; workspace-scoped
routes also need membership via `authorizeWorkspaceAccess`.

## Edge routing

`POST /edge/workspaces/:workspaceId/open`:

1. Resolve session cookie.
2. `authorizeWorkspaceAccess` (membership JOIN; unknown and forbidden → same 404).
3. Call Admin `workspacePairing` which signs the cloud-home pairing request
   (HMAC over method, path+query, timestamp, nonce, body hash).
4. Return `pairingLink` to the member. Never forwards a client-supplied
   workspace id without the membership check.

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
