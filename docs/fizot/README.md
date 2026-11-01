# Fizot developer commands

From page 03 Cursor setup and rules. Node 24 or newer, pnpm 10.33, about 7 GB of heap for the full typecheck, on Linux or macOS.

```bash
node -v
pnpm install --frozen-lockfile
pnpm lint
NODE_OPTIONS=--max-old-space-size=7000 pnpm typecheck
pnpm exec vitest run server/brand.test.ts server/bot-box server/redact.test.ts server/secret-vault.test.ts server/cloud-home.test.ts
pnpm audit --prod
```

The clean-machine check for S2.7 runs `node -v`, `pnpm install --frozen-lockfile`, `pnpm lint`, `NODE_OPTIONS=--max-old-space-size=7000 pnpm typecheck`, and `pnpm exec vitest run server/bot-box server/brand.test.ts server/redact.test.ts server/cloud-home.test.ts`.

A push to main runs lint, typecheck with a 7 GB heap, the tests below, the host scan, the brand scan, the open-source edition job, the packaged server smoke and the renderer smoke. The eight vitest shards, behavior evals, browser identity and the macOS smokes run on the nightly schedule and when CI is dispatched. Dispatch CI before an upstream sync.

```bash
node scripts/fizot/scan-upstream-hosts.mjs
node scripts/fizot/scan-brand-leaks.mjs
pnpm exec vitest run scripts/fizot scripts/ci-scope.test.ts scripts/ci-workflow.test.ts scripts/testing/verification-docs.test.ts scripts/testing/matrix-plan.test.ts scripts/testing/duration-sequencer.test.ts scripts/testing/analytics-docs.test.ts scripts/testing/file-size-ratchet.test.ts scripts/docker-image.test.ts server/hosted-access.test.ts server/hosted-models-api.test.ts server/model-providers-docs.test.ts src/locales/vocabulary.test.ts
```
