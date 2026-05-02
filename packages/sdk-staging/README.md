# `@percolatorct/sdk` — buyback staging

Design-home staging for the buyback additions to
[`dcccrypto/percolator-sdk`](https://github.com/dcccrypto/percolator-sdk).
Code is authored, typechecked, and tested here before transfer.

## Local dev

- `pnpm lint` runs `tsc --noEmit`
- `pnpm test` runs `vitest run`

`package.json` and `tsconfig.json` mirror the destination SDK
(Node >= 20, TS ^5.7.2, vitest ^4.0.18, `@solana/web3.js` ^1.95.4)
so type-resolution matches.

## What transfers

This README does not enumerate file destinations — that list drifted
once and would drift again. Instead:

- **Canonical transfer spec:** [`INTEGRATION.md`](../../INTEGRATION.md)
  → `## dcccrypto/percolator-sdk` (the four numbered steps name every
  destination path, plus scaffolding that stays behind).
- **Per-file destination:** the header comment at the top of each
  `src/**/*.ts` file documents where that specific file lands.

If the two disagree, INTEGRATION.md wins and the file header is a bug.
