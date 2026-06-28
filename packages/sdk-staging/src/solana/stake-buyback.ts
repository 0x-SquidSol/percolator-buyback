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
 *   merge its four keys (`BindBuybackConfig`, `TriggerBuyback`,
 *   `SettleBuyback`, `EmergencyDrainTreasury`) into the destination's
 *   existing `STAKE_IX` enum, assigning the next available tags. The
 *   on-chain `StakeInstruction` decoder
 *   (`percolator-stake/src/instruction.rs`) occupies tags 0-10, 12-16,
 *   18, and 19-23 — the latter being the insurance-authority family
 *   (`BindInsuranceAuthority` through `RecoverFlushedInsurance`); tags
 *   11 and 17 are tombstoned. The next free discriminators are 24-27.
 *   The block order here (Bind=24, Trigger=25, Settle=26, Drain=27) is
 *   PROVISIONAL — the on-chain enum order authored in the matching
 *   `percolator-stake` PR is the source of truth; the destination
 *   reconfirms and may reorder before merge.
 * - The `programId` parameter on derivation functions is required in
 *   this staging crate. Destination convention makes it optional with
 *   default `getStakeProgramId()` — match that pattern at transfer
 *   (see existing `deriveStakePool` for the idiom).
 * - There is NO `WithdrawForBuyback` and no wrapper interaction. The
 *   protocol-fee-funded design funds the buyback from a `BuybackTreasury`
 *   (swept protocol-fee revenue) and never withdraws from the insurance
 *   fund, so the buyback never CPIs into the wrapper (`percolator-prog`
 *   is unchanged). See the design spec / INTEGRATION.md.
 */

import { PublicKey } from "@solana/web3.js";
import { encU8, encU64, encPubkey, concatBytes } from "../abi/encode.js";

// ═══════════════════════════════════════════════════════════════
// Instruction tags — placeholder, merge into destination's STAKE_IX
// ═══════════════════════════════════════════════════════════════

/**
 * Placeholder tag values for the four buyback instructions. At
 * transfer, merge these keys into the destination's existing
 * `STAKE_IX` enum at the next available tag numbers. The on-chain
 * decoder occupies up to tag 23 (`RecoverFlushedInsurance`), so the
 * next free discriminators are 24-27.
 *
 * Order is PROVISIONAL (see the file header): the on-chain enum order is
 * the source of truth and the destination may reorder before merge. The
 * values are plain decimal literals in source so a future reviewer can
 * grep for the actual discriminator byte that lands on-chain.
 */
export const STAKE_IX_BUYBACK = {
  BindBuybackConfig: 24,
  TriggerBuyback: 25,
  SettleBuyback: 26,
  EmergencyDrainTreasury: 27,
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
 * Derive the per-pool BuybackTreasury PDA — the program-owned token
 * account that holds swept protocol-fee revenue, the buyback's sole spend
 * source. The reserved slice sits here between trigger and settle.
 *
 * Seeds: `["buyback_treasury", pool_pda]`. Owned by the stake program,
 * holds the market's quote/collateral mint. Per the protocol-fee-funded
 * design (PROPOSAL.md §11 "Custody"); insurance is never involved.
 *
 * @param pool       The stake pool PDA derived from the slab.
 * @param programId  The percolator-stake program ID.
 * @returns `[pda, bump]`
 */
export function deriveBuybackTreasury(
  pool: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TEXT.encode("buyback_treasury"), pool.toBytes()],
    programId,
  );
}

/**
 * Derive the per-pool BuybackConfig PDA — the market's immutable buyback
 * binding (token, pool, LP mint, pair, AMM program id + sha pin).
 *
 * Seeds: `["buyback_config", pool_pda]`. Pool-keyed, matching the
 * destination's `deriveStakeVaultAuth` / `deriveDepositPda` conventions.
 * Read the account with {@link decodeBuybackConfig}.
 *
 * @param pool       The stake pool PDA derived from the slab.
 * @param programId  The percolator-stake program ID.
 * @returns `[pda, bump]`
 */
export function deriveBuybackConfig(
  pool: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TEXT.encode("buyback_config"), pool.toBytes()],
    programId,
  );
}

// ═══════════════════════════════════════════════════════════════
// Instruction encoders
// ═══════════════════════════════════════════════════════════════

/**
 * `bind_buyback_config` writes a market's immutable buyback binding at
 * launch (PROPOSAL.md §11 "Per-market buyback binding"; INTEGRATION.md
 * `## dcccrypto/percolator-stake` step 3). Set once, never mutated.
 *
 * The handler rejects a binding where `tokenMint` equals the market's
 * collateral mint or the `lpMint` (the anti-reflexivity guard), so a
 * market never buys its own backing.
 *
 * Wire layout: `tag(1) + tokenMint(32) + pool(32) + lpMint(32) +
 * pairMint(32) + ammProgramId(32) + ammProgramDataSha256(32) = 193 bytes`.
 */
export interface BindBuybackConfigArgs {
  /** The market's buyback token mint (must differ from collateral and lpMint). */
  tokenMint: PublicKey | string;
  /** The bound AMM pool that receives the locked liquidity. */
  pool: PublicKey | string;
  /** The bound pool's Token-2022 LP mint. */
  lpMint: PublicKey | string;
  /** The pair asset paired with the bought token (e.g. wSOL, or USDC in-house). */
  pairMint: PublicKey | string;
  /** The bound AMM's program ID. */
  ammProgramId: PublicKey | string;
  /**
   * SHA-256 of the bound AMM's program-data account, captured at bind
   * time. Exactly 32 bytes — `settle_buyback` fail-closes if the AMM
   * ships an upgraded binary whose hash no longer matches.
   */
  ammProgramDataSha256: Uint8Array;
}

export function encodeStakeBindBuybackConfig(
  args: BindBuybackConfigArgs,
): Uint8Array {
  if (args.ammProgramDataSha256.length !== 32) {
    throw new Error(
      `encodeStakeBindBuybackConfig: ammProgramDataSha256 must be 32 bytes, got ${args.ammProgramDataSha256.length}`,
    );
  }
  return concatBytes(
    encU8(STAKE_IX_BUYBACK.BindBuybackConfig),
    encPubkey(args.tokenMint),
    encPubkey(args.pool),
    encPubkey(args.lpMint),
    encPubkey(args.pairMint),
    encPubkey(args.ammProgramId),
    args.ammProgramDataSha256,
  );
}

/**
 * `trigger_buyback` takes no instruction-data payload — the handler reads
 * the market, treasury, and bound-config state from the account list, runs
 * the reserve-first step and the gates against the treasury, and (on
 * success) reserves the slice inside the `BuybackTreasury`. No wrapper CPI;
 * no insurance/vault/LP account is touched. The cranker submits an
 * empty-data ix with the canonical account list.
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
 * `emergency_drain_treasury` returns a stranded reserved slice to the
 * `BuybackTreasury` — a protocol problem, never a staker one; insurance is
 * never involved. Callable only when `BuybackState.settle_disabled == 1`,
 * which is set ONLY by program upgrade — not by any runtime instruction.
 * Carries no instruction-data payload.
 */
export interface EmergencyDrainTreasuryArgs {}

export function encodeStakeEmergencyDrainTreasury(
  _args: EmergencyDrainTreasuryArgs = {},
): Uint8Array {
  return encU8(STAKE_IX_BUYBACK.EmergencyDrainTreasury);
}

// ═══════════════════════════════════════════════════════════════
// Account decoders
// ═══════════════════════════════════════════════════════════════

/**
 * Decoded `BuybackConfig` account — a market's immutable buyback binding,
 * written once by `bind_buyback_config`. Field order matches
 * INTEGRATION.md `## dcccrypto/percolator-stake` step 3.
 */
export interface BuybackConfig {
  /** The market's buyback token mint. */
  tokenMint: PublicKey;
  /** The bound AMM pool that receives the locked liquidity. */
  pool: PublicKey;
  /** The bound pool's Token-2022 LP mint. */
  lpMint: PublicKey;
  /** The pair asset paired with the bought token. */
  pairMint: PublicKey;
  /** The bound AMM's program ID. */
  ammProgramId: PublicKey;
  /** SHA-256 of the bound AMM's program-data account, captured at bind time (32 bytes). */
  ammProgramDataSha256: Uint8Array;
}

/**
 * Wire size of the `BuybackConfig` data section — five pubkeys + one
 * 32-byte hash. PROVISIONAL: the on-chain struct authored in the matching
 * `percolator-stake` PR is the source of truth. If that struct prepends a
 * bump or an account-type tag, the caller strips it (or the offsets are
 * reconciled) at transfer; this decoder reads the documented binding
 * fields only.
 */
export const BUYBACK_CONFIG_BYTE_LENGTH = 32 * 6;

/**
 * Decode a `BuybackConfig` account's data section (binding fields only,
 * no account header — the caller pre-strips any leading bump or
 * discriminator). Throws if the input is the wrong length. Byte-offset
 * safe: `slice` reads logical indices, so a sub-array view of a larger
 * account buffer decodes correctly.
 */
export function decodeBuybackConfig(data: Uint8Array): BuybackConfig {
  if (data.length !== BUYBACK_CONFIG_BYTE_LENGTH) {
    throw new Error(
      `decodeBuybackConfig: data length must be exactly ${BUYBACK_CONFIG_BYTE_LENGTH} bytes, got ${data.length}`,
    );
  }
  return {
    tokenMint: new PublicKey(data.slice(0, 32)),
    pool: new PublicKey(data.slice(32, 64)),
    lpMint: new PublicKey(data.slice(64, 96)),
    pairMint: new PublicKey(data.slice(96, 128)),
    ammProgramId: new PublicKey(data.slice(128, 160)),
    ammProgramDataSha256: data.slice(160, 192),
  };
}
