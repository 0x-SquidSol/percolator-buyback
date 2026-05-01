# `@percolatorct/sdk` — buyback staging

Reference implementation of the buyback additions to
[`dcccrypto/percolator-sdk`](https://github.com/dcccrypto/percolator-sdk),
authored and verified in this design-home repo before transfer.

## What's in here

| Path | Transfer? |
|---|---|
| `src/` | **Yes** — these files are the production code that lands in the destination SDK. |
| `package.json` | No — verification scaffolding only. The destination has its own. |
| `tsconfig.json` | No — verification scaffolding only. The destination has its own. |
| `pnpm-lock.yaml` (if generated) | No — never. |
| `node_modules/` | No — never. |

The `package.json` and `tsconfig.json` here exist solely so the staged
TypeScript can be type-checked (`pnpm lint` → `tsc --noEmit`) and tested
(`pnpm test` → `vitest run`) in this repo before transfer. Their
versions mirror the destination SDK's `package.json` (Node ≥ 20, TS
^5.7.2, vitest ^4.0.18, `@solana/web3.js` ^1.95.4) so type-resolution
matches, but neither file is part of the transfer.

## Where each file lands in the destination

The destination SDK groups all per-program code in a single file under
`src/solana/<program>.ts`. The buyback additions extend the existing
[`src/solana/stake.ts`](https://github.com/dcccrypto/percolator-sdk/blob/main/src/solana/stake.ts)
file (the stake program already hosts top-up / withdraw flows the
buyback inherits the seam from).

| Staged file | Destination |
|---|---|
| `src/buyback/instructions.ts` | append exported items to `src/solana/stake.ts` |
| `src/buyback/pda.ts` | append exported items to `src/solana/stake.ts` |
| `src/buyback/events.ts` | new file `src/abi/events/buyback.ts` (or per existing event-parser convention) |
| `src/buyback/errors.ts` | append to `src/abi/errors.ts` (or new `src/abi/errors/buyback.ts`) |

The integrator merges the exports into the destination's existing
modules rather than dropping a new top-level package. Destination's
naming conventions (e.g. `encodeStake<Action>` prefix for stake-program
encoders) are followed in this staging crate so the merge is
copy-and-paste, not translation.

## Conventions inherited from the destination SDK

- ESM imports with `.js` extensions on `.ts` source files
  (`from "../encode.js"` not `from "../encode"`)
- Numeric inputs typed `bigint | string`; outputs typed `Uint8Array`
- Single-byte (`encU8`) instruction discriminator (NOT Anchor 8-byte hash)
- `<Name>Args` interface + `encode<Name>(args)` function pairs
- PDA derivations return `[PublicKey, number]` (pubkey, bump)
- Throw `Error` with namespaced messages (`"encU64: value out of range"`)

The `encU8`/`encU64`/`encPubkey`/`concatBytes` helpers used by these
files are imported from the destination's `src/abi/encode.ts` — they
are NOT re-vendored here. The staging files reference them as if they
were already present in the destination crate (which they are).
