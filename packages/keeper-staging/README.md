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

The destination keeper also depends on `@percolatorct/shared` (a
sibling utility package). It is **deliberately omitted** here until a
buyback source file actually imports a symbol from it. If that
happens, mirror the SDK pattern — add a `shared-staging/` sibling
package with stubbed exports, plus matching `paths` and
`resolve.alias` entries — rather than installing the published
package speculatively (which may live on a private registry that
contributors lack auth for).

## What transfers

This README does not enumerate file destinations — that list drifted
once on the SDK side (since fixed) and would drift again. Instead:

- **Canonical transfer spec (pending):** [`INTEGRATION.md`](../../INTEGRATION.md)
  will gain a `## dcccrypto/percolator-keeper` section once there is
  enough substantive content to populate it (file paths, transfer
  recipe, verification block). Until then, INTEGRATION.md has no
  entry for this repo — same pattern as the SDK staging entry at
  INTEGRATION.md's `## dcccrypto/percolator-sdk`, which landed
  alongside the staged source rather than ahead of it.
- **Per-file destination:** the header comment at the top of each
  `src/**/*.ts` file documents where that specific file lands.

Once the canonical entry is authored, it supersedes any per-file
header that conflicts. Until then, the file headers are the binding
specification — and today both staged files (`src/index.ts`,
`src/lib/log.ts`) declare themselves staging-only, so a transfer
right now produces no destination diff.
