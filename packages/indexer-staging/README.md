# `@percolator/indexer` — buyback staging

Design-home staging for the buyback additions to
[`dcccrypto/percolator-indexer`](https://github.com/dcccrypto/percolator-indexer).
Code is authored, typechecked, and tested here before transfer.

## Local dev

- `pnpm lint` runs `tsc --noEmit` against both `src/` and `tests/`
- `pnpm test` runs `vitest run`

`package.json`, `tsconfig.json`, and `vitest.config.ts` mirror the destination
indexer (Node >= 20, TS ^5.7.3, vitest ^4.0.18, `@solana/web3.js` ^1.98) so
type-resolution and test-runner behavior match. The destination indexer is a
Hono + Supabase service; only the **pure aggregation logic** (decode + the
headline metrics) is staged here — the HTTP / DB layer is destination-specific
and is NOT mirrored.

## SDK dependency

The aggregator consumes the buyback event decoders (`decodeBuybackTriggered`,
`decodeLiquidityLocked`, and the `BuybackTriggered` / `LiquidityLocked` types)
from `@percolatorct/sdk`. Those symbols live in our local
[`packages/sdk-staging/`](../sdk-staging/) and are not published to npm yet, so
`tsconfig.json` and `vitest.config.ts` carry path aliases mapping
`@percolatorct/sdk` → `../sdk-staging/src/index.ts`. At transfer the alias falls
away and the import resolves to the real dep.

## What transfers

`src/` only. Each `src/**/*.ts` file's header documents its destination. The
toolchain files (`package.json`, `tsconfig*.json`, `vitest.config.ts`, the
lockfile) are verification-only and do NOT cross over.
