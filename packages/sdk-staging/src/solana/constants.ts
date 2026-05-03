/**
 * @module solana/constants
 *
 * Hardcoded canonical pubkey constants the buyback flow reads — pool
 * address, USDC and wSOL mints, Token-2022 program ID. Off-chain
 * consumers (the keeper's eligibility probe, Jupiter swap leg, and
 * `settle_buyback` LP-mint check) all reach for these; centralizing
 * the values means a future address rotation is one edit, not a
 * grep-and-replace across services.
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
 *   - `CANONICAL_POOL`: `PROPOSAL.md` §11 "Canonical PumpSwap pool
 *     address" — re-verified 2026-04-30.
 *   - `WSOL_MINT`: Solana mainnet well-known wrapped-SOL mint. The
 *     canonical pool is SOL-paired (PROPOSAL §11), so the keeper's
 *     Jupiter leg routes USDC → wSOL.
 *   - `USDC_MINT`: Solana mainnet well-known USDC mint. The slice
 *     reserved by `trigger_buyback` is USDC-denominated; the keeper's
 *     first leg is USDC → wSOL via Jupiter (PROPOSAL §5.2).
 *   - `TOKEN_2022_PROGRAM_ID`: Solana mainnet well-known Token-2022
 *     program. PROPOSAL §11 fixes the canonical pool's LP mint as
 *     "vanilla Token-2022, 82 bytes, no extensions"; the keeper's LP
 *     burn leg invokes Token-2022's `Burn` ix (PROPOSAL §11
 *     "LP token burn mechanism").
 *
 * **Intentionally excluded — every gap below is reasoned, not
 * accidental:**
 *   - `CANONICAL_LP_MINT` is pool-derived; the keeper reads it from
 *     the canonical pool account at runtime rather than from a
 *     hardcoded constant. Hardcoding would risk drift if PumpSwap
 *     changes the LP-mint derivation rule.
 *   - `CANONICAL_SLAB` is deployment-specific and pinned in the
 *     wrapper program (`percolator-prog`), not the SDK.
 *   - `PUMPSWAP_PROGRAM_ID` and `PUMPSWAP_PROGRAM_DATA_SHA256` are
 *     authored at the wrapper-program landing per
 *     `INTEGRATION.md:65`, where the runtime sha256 pin is captured
 *     at deploy time. Adding them here ahead of that capture would
 *     speculate.
 *   - `$PERCOLATOR` mint is deployment-specific and not yet
 *     finalized — leave it out until the canonical address is set.
 */

import { PublicKey } from "@solana/web3.js";

/**
 * Canonical PumpSwap $PERCOLATOR/SOL pool that receives every locked
 * liquidity deposit. The pool already exists from pump.fun's migration
 * and is hardcoded on the program (the cranker reads the address from
 * the program rather than from a config). Per `PROPOSAL.md` §11
 * "Canonical PumpSwap pool address" — re-verified 2026-04-30.
 *
 * Changing this value requires a program upgrade; the address is not
 * a runtime tunable.
 */
export const CANONICAL_POOL = new PublicKey(
  "Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW",
);

/**
 * Solana mainnet wrapped-SOL mint. The canonical PumpSwap pool is
 * SOL-paired (PROPOSAL §11 "USDC vs SOL pair side — SOL"); the
 * keeper's first cranker leg is USDC → wSOL via Jupiter, and the
 * add-liquidity leg pairs $PERCOLATOR with wSOL.
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

/**
 * Solana Token-2022 program. The canonical pool's LP mint is
 * "vanilla Token-2022, 82 bytes, no extensions" (PROPOSAL §11). The
 * keeper's LP-burn leg constructs a Token-2022 `Burn` ix targeting
 * the LP receipt; `settle_buyback` validates against this same
 * program ID when checking the LP mint owner.
 */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
