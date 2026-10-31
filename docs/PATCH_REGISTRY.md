# Patch Registry

Every upstream file Fizot edits or deletes is listed here. A file that differs from `upstream-mirror` and is not listed is a bug.

| Patch | Kind | State | Upstream base tag | Upstream file(s) | Why | Conflict risk on sync | Guarded by (test / CI check) | Related task |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PATCH-1 | Delete | Applied | v0.1.134 | `enterprise/FEATURES`; `enterprise/LICENSE`; `enterprise/README.md`; `enterprise/scripts/issue-license.mjs`; `enterprise/server/index.ts`; `enterprise/server/license.test.ts`; `enterprise/server/license.ts`; `enterprise/server/register.test.ts`; `enterprise/server/workspace-access.test.ts`; `enterprise/server/workspace-access.ts` | The private fork keeps the Apache core. These ten paths were removed from `main` only. Their contents were not opened. `upstream-mirror` still points at v0.1.134 and still contains them. | Medium | None in this step. | T0.3 (FZ-3) |
