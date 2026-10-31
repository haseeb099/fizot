# Changelog

Every change records why, how it works, why it is necessary, impact, and rollback.

Notion assigns the CL number. This file uses those ids. The pin entry was first drafted here as CL-1 and is Notion CL-9. The enterprise deletion was first drafted here as CL-2 and is Notion CL-10.

Patch titles in `docs/PATCH_REGISTRY.md` are PATCH-n. Notion's auto-increment PR column differs: PATCH-1 is Notion PR 10, PATCH-2 is PR 11, PATCH-3 is PR 12, PATCH-4 is PR 13, PATCH-5 is PR 14, PATCH-6 is PR 15.

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
