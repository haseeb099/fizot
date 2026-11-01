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

The daily CI gate also runs the host scan and the brand scan:

```bash
node scripts/fizot/scan-upstream-hosts.mjs
node scripts/fizot/scan-brand-leaks.mjs
```
