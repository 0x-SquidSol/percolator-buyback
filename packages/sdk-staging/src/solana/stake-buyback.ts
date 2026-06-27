/**
 * @module stake-buyback
 *
 * Buyback additions to the percolator-stake program — instruction
 * encoders and PDA derivations.
 *
 * **Transfer destination:** append the exported items in this file to
 * `dcccrypto/percolator-sdk/src/solana/stake.ts`. The destination's
 * existing file already hosts the stake program's `STAKE_PROGRAM_IDS`,
 * `getStakeProgramId`, `STAKE_IX` enum, and `deriveStakePool` /
 * `deriveStakeVaultAuth` / `deriveDepositPda` helpers; the buyback
 * additions slot in alongside them.
 *
 * **Wire conventions inherited from destination:**
 * - Single u8 instruction discriminator (`encU8(STAKE_IX.<Variant>)`)
 * - Numeric inputs typed `bigint | string`; outputs typed `Uint8Array`
 * - PDA derivations return `[PublicKey, number]` (pubkey, bump)
 * - Subsidiary PDAs (anything not the top-level pool) are pool-keyed,
 *   not slab-keyed — matches `deriveStakeVaultAuth` and
 *   `deriveDepositPda`.
 *
 * **Code-style conventions inherited from destination:**
 * - `<Name>Args` interface + `encode<Name>(args)` function pairs
 * - ESM imports with `.js` extensions on `.ts` source files
 *   (`from "../abi/encode.js"` not `from "../abi/encode"`)
 * - Throw `Error` with namespaced messages
 *   (e.g. `"encU64: value out of range"`)
 *
 * **Programmer-facing notes the integrator MUST honor at transfer:**
 * - The `STAKE_IX_BUYBACK` enum below is a placeholder. At transfer,
 *   merge its three keys (`TriggerBuyback`, `SettleBuyback`,
 *   `EmergencyDrainBuybackPool`) into the destination's existing
 *   `STAKE_IX` enum, assigning the next available tags. The on-chain
 *   `StakeInstruction` decoder (`percolator-stake/src/instruction.rs`)
 *   occupies tags 0-10, 12-16, 18, and 19-23 — the latter being the
 *   insurance-authority family (`BindInsuranceAuthority` through
 *   `RecoverFlushedInsurance`); tags 11 and 17 are tombstoned. The
 *   next free discriminator is 24, so the staged values are 24/25/26.
 *   The destination reconfirms against its enum before merge.
 * - The `programId` parameter on derivation functions is required in
 *   this staging crate. Destination convention makes it optional with
 *   default `getStakeProgramId()` — match that pattern at transfer
 *   (see existing `deriveStakePool` for the idiom).
 * - `WithdrawForBuyback` (the wrapper-side CPI target the stake
 *   program calls into) is intentionally NOT exported here. It is a
 *   wrapper-internal CPI primitive with no legitimate public TS caller
 *   — exposing an encoder for it would be a footgun (cranker could
 *   submit it directly and bypass the gate sequence). The stake
 *   program constructs the CPI internally via `cpi::invoke_signed`.
 */

import { PublicKey } from "@solana/web3.js";
import { encU8, encU64, concatBytes } from "../abi/encode.js";

// ═══════════════════════════════════════════════════════════════
// Instruction tags — placeholder, merge into destination's STAKE_IX
// ═══════════════════════════════════════════════════════════════

/**
 * Placeholder tag values for the three buyback instructions. At
 * transfer, merge these keys into the destination's existing
 * `STAKE_IX` enum at the next available tag numbers. The on-chain
 * decoder occupies up to tag 23 (`RecoverFlushedInsurance`), so the
 * next free discriminators are 24/25/26.
 *
 * The values are plain decimal literals in source so a future reviewer
 * can grep for the actual discriminator byte that lands on-chain.
 */
export const STAKE_IX_BUYBACK = {
  TriggerBuyback: 24,
  SettleBuyback: 25,
  EmergencyDrainBuybackPool: 26,
} as const;
Object.freeze(STAKE_IX_BUYBACK);

// ═══════════════════════════════════════════════════════════════
// PDA derivations
// ═══════════════════════════════════════════════════════════════

const TEXT = new TextEncoder();

/**
 * Derive the per-pool BuybackState PDA.
 *
 * Seeds: `["buyback_state", pool_pda]` where `pool_pda` is
 * `deriveStakePool(slab).pubkey`. Pool-keyed (not slab-keyed) to match
 * the destination's existing `deriveStakeVaultAuth` and
 * `deriveDepositPda` conventions.
 *
 * @param pool       The stake pool PDA derived from the slab.
 * @param programId  The percolator-stake program ID.
 * @returns `[pda, bump]`
 */
export function deriveBuybackState(
  pool: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TEXT.encode("buyback_state"), pool.toBytes()],
    programId,
  );
}

/**
 * Derive the per-pool buyback pool ATA — the SPL Token account that
 * holds the slice between trigger and settle.
 *
 * Seeds: `["buyback_pool", pool_pda]`. Owned by the stake program,
 * holds the slab's collateral mint. Per PROPOSAL.md §11 ("Buyback pool
 * custody — fresh PDA owned by the buyback-hosting program").
 *
 * @param pool       The stake pool PDA derived from the slab.
 * @param programId  The percolator-stake program ID.
 * @returns `[pda, bump]`
 */
export function deriveBuybackPool(
  pool: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TEXT.encode("buyback_pool"), pool.toBytes()],
    programId,
  );
}

// ═══════════════════════════════════════════════════════════════
// Instruction encoders
// ═══════════════════════════════════════════════════════════════

/**
 * `trigger_buyback` takes no instruction-data payload — the handler
 * reads slab and pool state from the account list, runs the four math
 * gates, and (on success) CPIs into the wrapper to move the slice.
 * The cranker submits an empty-data ix with the canonical account list.
 */
export interface TriggerBuybackArgs {}

export function encodeStakeTriggerBuyback(
  _args: TriggerBuybackArgs = {},
): Uint8Array {
  return encU8(STAKE_IX_BUYBACK.TriggerBuyback);
}

/**
 * `settle_buyback` carries one cranker-supplied field: the
 * `roundTripId` that lands in `BuybackState`'s recently-settled ring
 * buffer (PROPOSAL.md §5.4 attribution; not authentication).
 *
 * Wire layout: `tag(1) + roundTripId u64 LE(8) = 9 bytes`.
 */
export interface SettleBuybackArgs {
  /** Cranker-generated identifier for this round-trip. Append-only attribution. */
  roundTripId: bigint | string;
}

export function encodeStakeSettleBuyback(
  args: SettleBuybackArgs,
): Uint8Array {
  return concatBytes(
    encU8(STAKE_IX_BUYBACK.SettleBuyback),
    encU64(args.roundTripId),
  );
}

/**
 * `emergency_drain_buyback_pool` returns the pool's contents to the
 * slab insurance fund. Callable only when `BuybackState.settle_disabled
 * == 1`, which is set ONLY by program upgrade — not by any runtime
 * instruction. Carries no instruction-data payload.
 */
export interface EmergencyDrainBuybackPoolArgs {}

export function encodeStakeEmergencyDrainBuybackPool(
  _args: EmergencyDrainBuybackPoolArgs = {},
): Uint8Array {
  return encU8(STAKE_IX_BUYBACK.EmergencyDrainBuybackPool);
}
