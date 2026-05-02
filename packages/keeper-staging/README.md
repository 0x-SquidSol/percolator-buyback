# `@percolator/keeper` — buyback staging

Design-home staging for the buyback additions to
[`dcccrypto/percolator-keeper`](https://github.com/dcccrypto/percolator-keeper).
Code is authored, typechecked, and tested here before transfer.

## Local dev

- `pnpm lint` runs `tsc --noEmit` against both `src/` and `tests/`
- `pnpm test` runs `vitest run`

`package.json`, `tsconfig.json`, and `vitest.config.ts` mirror the
destination keeper (Node >= 20, TS ^5.7.3, vitest ^4.0.18,
`@solana/web3.js` ^1.98.0, `dotenv` ^16.4.7) so type-resolution and
test-runner behavior match.

## SDK dependency

The destination keeper imports from `@percolatorct/sdk` (the published
npm version). The buyback symbols this staging keeper needs
(`encodeStakeTriggerBuyback`, `deriveBuybackState`, etc.) live in our
local [`packages/sdk-staging/`](../sdk-staging/) and have not been
published to npm yet. To let staging code use destination-style
imports verbatim, `tsconfig.json` and `vitest.config.ts` carry path
aliases mapping `@percolatorct/sdk` → `../sdk-staging/src/index.ts`.
At transfer time the alias falls away; the integrator's import
resolves to the real npm dep, with no rename required in the source
files.

## What transfers

This README does not enumerate file destinations — that list drifted
once on the SDK side (since fixed) and would drift again. Instead:

- **Canonical transfer spec:** [`INTEGRATION.md`](../../INTEGRATION.md)
  → `## dcccrypto/percolator-keeper` (when authored).
- **Per-file destination:** the header comment at the top of each
  `src/**/*.ts` file documents where that specific file lands.

If the two disagree, INTEGRATION.md wins and the file header is a bug.
