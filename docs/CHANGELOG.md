# Changelog

Every change records why, how it works, why it is necessary, impact, and rollback.

Notion assigns the CL number. This file uses those ids. The pin entry was first drafted here as CL-1 and is Notion CL-9. The enterprise deletion was first drafted here as CL-2 and is Notion CL-10.

Patch titles in `docs/PATCH_REGISTRY.md` are PATCH-n. Notion's auto-increment PR column differs: PATCH-1 is Notion PR 10, PATCH-2 is PR 11, PATCH-3 is PR 12, PATCH-4 is PR 13, PATCH-5 is PR 14, PATCH-6 is PR 15, PATCH-7 is PR 16, PATCH-8 is PR 17, PATCH-9 is PR 18, PATCH-10 is PR 19, PATCH-11 is PR 20, PATCH-12 is PR 21, PATCH-13 is PR 22, PATCH-14 is PR 23, PATCH-15 is PR 24, PATCH-16 is PR 25, PATCH-17 is PR 26, PATCH-18 is PR 27, PATCH-19 is PR 28, PATCH-20 is PR 29.

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

