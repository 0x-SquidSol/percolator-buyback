/**
 * @module solana/constants
 *
 * Pubkey constants the buyback flow reads — the well-known mainnet
 * USDC / wSOL mints, plus the $PERCOLATOR market's bound pool as the
 * first per-market example. Off-chain consumers (the keeper's
 * eligibility probe, the convert/swap leg, and `settle_buyback`) reach
 * for these; centralizing the shared mints means one edit, not a
 * grep-and-replace across services. Per-market addresses (each market's
 * token, pool, LP mint, pair asset) are read from that market's
 * on-chain binding, not hardcoded here.
 *
 * **Transfer destination:** append the exported items in this file to
 * `dcccrypto/percolator-sdk/src/solana/stake.ts` (alongside the
 * existing program-ID and PDA-derivation surface) — OR drop this file
 * at `dcccrypto/percolator-sdk/src/solana/buyback-constants.ts` and
 * re-export from `solana/index.ts`. The destination decides; staging
 * holds them in a buyback-specific file because the SDK staging tree
 * is buyback-only and a flat module layout reads cleaner here.
 *
 * **Sources for each address (every value below is re-verifiable
 * against an on-chain or PROPOSAL.md citation):**
 *   - `CANONICAL_POOL`: the $PERCOLATOR market's bound pool — see
 *     `PROPOSAL.md` §11 "Per-market buyback binding".
 *   - `WSOL_MINT`: Solana mainnet well-known wrapped-SOL mint. SOL-paired
 *     markets (e.g. the $PERCOLATOR PumpSwap pool) route their convert
 *     leg USDC → wSOL via Jupiter.
 *   - `USDC_MINT`: Solana mainnet well-known USDC mint. The slice
 *     reserved by `trigger_buyback` is USDC-denominated; the keeper's
 *     first leg is USDC → wSOL via Jupiter (PROPOSAL §5.2).
 *
 * **Intentionally excluded — every gap below is reasoned, not
 * accidental:**
 *   - `TOKEN_2022_PROGRAM_ID` is NOT redefined here. The destination
 *     SDK already exports it canonically from
 *     `src/solana/token-program.ts` and pins it through an explicit
 *     named re-export in `src/solana/index.ts` to resolve a TS2308
 *     ambiguity with `stake.ts`. A second definition would reintroduce
 *     that ambiguity, so the keeper's LP-burn leg and `settle_buyback`
 *     LP-mint check import the existing symbol. PROPOSAL §11 still
 *     fixes the canonical pool's LP mint as "vanilla Token-2022, 82
 *     bytes, no extensions".
 *   - The LP mint is pool-derived; the keeper reads it from the
 *     market's bound pool account at runtime rather than from a
 *     hardcoded constant. Hardcoding would risk drift if the AMM
 *     changes the LP-mint derivation rule.
 *   - Per-market binding fields (token mint, pool, LP mint, pair asset,
 *     AMM program ID, and the AMM program-data sha256 pin) live in each
 *     market's on-chain `BuybackConfig`, captured at bind time per the
 *     stake-program entry in `INTEGRATION.md`. They are not SDK
 *     constants — adding them here would speculate a single global pool.
 *   - `$PERCOLATOR` mint is deployment-specific and not yet
 *     finalized — leave it out until the canonical address is set.
 */

import { PublicKey } from "@solana/web3.js";

/**
 * The $PERCOLATOR market's bound PumpSwap $PERCOLATOR/SOL pool — the
 * first per-market example. The pool already exists from pump.fun's
 * migration. Each market binds its own pool on-chain (PROPOSAL.md §11
 * "Per-market buyback binding"); this constant is the $PERCOLATOR
 * market's value, read at runtime from its binding in the general case.
 */
export const CANONICAL_POOL = new PublicKey(
  "Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW",
);

/**
 * Solana mainnet wrapped-SOL mint. SOL-paired markets (PROPOSAL §11
 * "Pair asset — per-market") run a USDC → wSOL convert leg via Jupiter,
 * and pair the bought token with wSOL on add-liquidity.
 */
export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);

/**
 * Solana mainnet USDC mint. The slice reserved by `trigger_buyback`
 * is USDC-denominated (PROPOSAL §5.1, §5.2 "USDC → SOL via Jupiter").
 */
export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
