/**
 * @module services/buyback
 *
 * Off-chain eligibility probe for the buyback flow. Given a stake
 * program slab pubkey, asks the RPC to simulate `stake_trigger_buyback`
 * and classifies the result so the keeper's main loop knows whether
 * to actually submit the transaction. Read-only — never lands a tx.
 *
 * **Transfer destination:** `dcccrypto/percolator-keeper/src/services/buyback.ts`.
 *
 * **At transfer:**
 *   1. Replace `import { log } from "../lib/log.js"` with
 *      `import { createLogger } from "@percolatorct/shared"` plus a
 *      top-of-file `const log = createLogger("keeper:buyback");`.
 *      Per the `lib/log.ts` post-transfer grep guard, no
 *      `"../lib/log.js"` reference may survive in the destination's
 *      `src/services/`.
 *   2. `stakeProgramId` becomes optional with the SDK's
 *      `getStakeProgramId()` default, and the local `deriveStakePool`
 *      helper is dropped for the SDK's `deriveStakePool(slab)`
 *      (`sdk-staging` carries only the buyback additions, so it is
 *      mirrored locally here). The account-list construction, classifier,
 *      log shapes, and data bytes carry over unchanged.
 *
 * **The probe sends the real instruction.** The data byte comes from
 * `encodeStakeTriggerBuyback()` and the account list is the canonical layout
 * the on-chain `process_trigger_buyback` handler pins (see
 * `buildStakeTriggerBuybackIx`). Tests mock the `simulateTransaction` response
 * directly, so the four outcome paths (`would-fire`, `blocked`, `rpc-error`,
 * `not-live`) are exercised without a live RPC.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type SimulatedTransactionResponse,
} from "@solana/web3.js";
import {
  encodeStakeTriggerBuyback,
  parseBuybackBlockerName,
  deriveBuybackConfig,
  deriveBuybackState,
  deriveBuybackTreasury,
} from "@percolatorct/sdk";
import { log } from "../lib/log.js";

/**
 * Discriminated union returned by `probeEligibility`. The `outcome`
 * tag matches the literal union in `BuybackLogFields.outcome` so the
 * structured-log payload and the in-memory result share a vocabulary.
 *
 *   - `would-fire`: simulation succeeded; submitting the same tx for
 *     real would land. `slice` is the collateral slice the program
 *     reserved (in collateral base units). Today the stub returns
 *     "0" until the SDK's `BuybackTriggered` event decoder is wired
 *     in; the field exists now so call sites and structured-log
 *     consumers don't churn at that swap.
 *   - `blocked`: simulation succeeded but the program returned a
 *     `BuybackBlocker` discriminant. `blocker` is the variant name
 *     (e.g. `"CooldownActive"`); see `BUYBACK_BLOCKER` in
 *     `@percolatorct/sdk` for the full enumeration.
 *   - `not-live`: the program rejected the call before user logic
 *     ran (account not found, wrong program owner, missing
 *     discriminator). Treat as "buyback isn't enabled here yet".
 *   - `rpc-error`: the simulate call itself failed (network, RPC
 *     formatted error, or response shape we couldn't classify).
 *     This is a probe-side fault — not a verdict on the buyback.
 */
export type EligibilityResult =
  | { outcome: "would-fire"; slice: string }
  | { outcome: "blocked"; blocker: string }
  | { outcome: "not-live" }
  | { outcome: "rpc-error"; error: string };

/** UTF-8 encoder for PDA seed strings. */
const TEXT = new TextEncoder();

/**
 * Derive the stake-pool PDA for a slab — `[b"stake_pool", slab]`. The
 * destination SDK exports `deriveStakePool`; `sdk-staging` carries only the
 * buyback additions, so it is mirrored here for staging. **At transfer:** drop
 * this helper and use the SDK's `deriveStakePool(slab)`.
 */
function deriveStakePool(slab: PublicKey, stakeProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [TEXT.encode("stake_pool"), slab.toBytes()],
    stakeProgramId,
  )[0];
}

/**
 * Build the `trigger_buyback` instruction. The account list is the canonical
 * layout pinned by the on-chain `process_trigger_buyback` handler in
 * `dcccrypto/percolator-stake`:
 *
 *   0. `[]`         pool PDA (`deriveStakePool(slab)`)
 *   1. `[]`         market account (the slab — `market.key == pool.slab`)
 *   2. `[]`         `BuybackConfig` PDA (the bound token/pool/pair)
 *   3. `[writable]` `BuybackState` PDA (lazy-init + cooldown stamp)
 *   4. `[]`         `BuybackTreasury` token account (balance read; NOT writable
 *                   at trigger — the slice is only reserved in state here)
 *   5. `[signer]`   cranker (fee payer; pays state rent on the first trigger)
 *   6. `[]`         System program (lazy-init)
 *
 * No insurance, vault, or LP account; `Clock` is read via syscall on-chain, not
 * passed as an account. The DATA byte comes from `encodeStakeTriggerBuyback()`.
 *
 * **At transfer:** `stakeProgramId` becomes optional with the SDK's
 * `getStakeProgramId()` default, and `deriveStakePool` resolves to the SDK's.
 */
function buildStakeTriggerBuybackIx(
  cranker: PublicKey,
  slab: PublicKey,
  stakeProgramId: PublicKey,
): TransactionInstruction {
  const pool = deriveStakePool(slab, stakeProgramId);
  const config = deriveBuybackConfig(pool, stakeProgramId)[0];
  const state = deriveBuybackState(pool, stakeProgramId)[0];
  const treasury = deriveBuybackTreasury(pool, stakeProgramId)[0];
  return new TransactionInstruction({
    programId: stakeProgramId,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: slab, isSigner: false, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: state, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: false },
      { pubkey: cranker, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(encodeStakeTriggerBuyback()),
  });
}

/**
 * On-chain `Custom`-error base for the buyback gate failures. The destination
 * `dcccrypto/percolator-stake` is a NATIVE program: `trigger_buyback` surfaces
 * a `BuybackBlocker` as a `StakeError::Buyback*` variant, which serialize to
 * `ProgramError::Custom(28..34)` — the next-free `StakeError` block after the
 * existing `0..27`. This base is NOT the math crate's `0..6` `BuybackBlocker`
 * discriminants and NOT an Anchor `0x1770` / 6000 offset. It is pinned, with a
 * compile-time lock, by `src/error.rs` in `dcccrypto/percolator-stake` (a
 * reorder there fails its build); this constant is the off-chain mirror.
 */
const BUYBACK_ERROR_BASE = 28;

/**
 * Extract the on-chain `BuybackBlocker` variant name from a failed
 * `simulateTransaction` `err`, or `null` when the failure is not a buyback gate
 * rejection.
 *
 * Reads the structured `InstructionError` `Custom` code — authoritative for a
 * native program — rather than scraping program logs: a gate rejection is
 * `Custom(BUYBACK_ERROR_BASE + discriminant)`, so the discriminant is
 * `code - BUYBACK_ERROR_BASE`, resolved to its name by the SDK's order-locked
 * `parseBuybackBlockerName`, which returns `null` for any code outside the
 * canonical `0..6` (i.e. any non-buyback `StakeError`, which then falls through
 * to the not-live / rpc-error branches).
 *
 * The probe submits a SINGLE-instruction transaction, so the failing
 * instruction is unambiguously the buyback ix and the `Custom` code is its own.
 * If the destination ever bundles `trigger_buyback` with other instructions
 * (e.g. a ComputeBudget prefix), verify the `InstructionError` index against the
 * buyback ix's position before attributing a `Custom` code to the gate.
 */
function extractBlocker(err: unknown): string | null {
  const code = customErrorCode(err);
  if (code === null) return null;
  return parseBuybackBlockerName(code - BUYBACK_ERROR_BASE);
}

/**
 * Read `err.InstructionError[1].Custom` as a number, or `null` when the error
 * is not a structured `Custom` program error (a string-form `InstructionError`
 * variant, or any non-object RPC fault).
 */
function customErrorCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const ie = (err as Record<string, unknown>)["InstructionError"];
  if (!Array.isArray(ie) || ie.length !== 2) return null;
  const variant = ie[1];
  if (typeof variant !== "object" || variant === null) return null;
  const custom = (variant as Record<string, unknown>)["Custom"];
  return typeof custom === "number" ? custom : null;
}

/**
 * Detect the "this program/account isn't live for buyback yet" case.
 * The Solana RPC reports these as `InstructionError` tuples carrying
 * a string variant or as a string-form `err` directly.
 */
function isNotLiveErr(err: unknown): boolean {
  const NOT_LIVE_TAGS = new Set([
    "ProgramAccountNotFound",
    "AccountNotFound",
    "InvalidAccountData",
    "MissingAccount",
    "UnsupportedProgramId",
  ]);
  if (typeof err === "string") return NOT_LIVE_TAGS.has(err);
  if (typeof err !== "object" || err === null) return false;
  const obj = err as Record<string, unknown>;
  if (typeof obj["InstructionError"] !== "undefined") {
    const ie = obj["InstructionError"];
    if (Array.isArray(ie) && ie.length === 2) {
      const inner = ie[1];
      if (typeof inner === "string") return NOT_LIVE_TAGS.has(inner);
    }
  }
  return false;
}

/**
 * Pure classifier — given a `simulateTransaction` response, derive
 * the `EligibilityResult`. Kept pure (no logging, no I/O) so tests
 * can drive each branch with synthetic responses.
 */
function classifySim(sim: SimulatedTransactionResponse): EligibilityResult {
  if (sim.err === null) {
    return { outcome: "would-fire", slice: "0" };
  }
  const blocker = extractBlocker(sim.err);
  if (blocker !== null) {
    return { outcome: "blocked", blocker };
  }
  if (isNotLiveErr(sim.err)) {
    return { outcome: "not-live" };
  }
  return {
    outcome: "rpc-error",
    error:
      typeof sim.err === "string" ? sim.err : JSON.stringify(sim.err),
  };
}

/**
 * Run the eligibility probe for a single slab. Builds the `trigger_buyback`
 * transaction (real account list — see `buildStakeTriggerBuybackIx`), asks the
 * RPC to simulate it, and emits one structured log line for the outcome. Always
 * returns an `EligibilityResult` — never throws (RPC faults become `rpc-error`
 * results so the caller can decide on retry vs. skip without a try/catch wrapper
 * at every probe site).
 */
export async function probeEligibility(
  connection: Connection,
  slab: PublicKey,
  payer: PublicKey,
  stakeProgramId: PublicKey,
): Promise<EligibilityResult> {
  const slabStr = slab.toBase58();

  let sim: SimulatedTransactionResponse;
  try {
    const ix = buildStakeTriggerBuybackIx(payer, slab, stakeProgramId);
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    const response = await connection.simulateTransaction(tx, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    });
    sim = response.value;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn("eligibility probe rpc error", {
      slab: slabStr,
      outcome: "rpc-error",
    });
    return { outcome: "rpc-error", error: errorMsg };
  }

  const result = classifySim(sim);
  switch (result.outcome) {
    case "would-fire":
      log.info("eligibility probe would-fire", {
        slab: slabStr,
        outcome: "would-fire",
        slice: result.slice,
      });
      break;
    case "blocked":
      log.info("eligibility probe blocked", {
        slab: slabStr,
        outcome: "blocked",
        blocker: result.blocker,
      });
      break;
    case "not-live":
      log.info("eligibility probe not-live", {
        slab: slabStr,
        outcome: "not-live",
      });
      break;
    case "rpc-error":
      log.warn("eligibility probe rpc error", {
        slab: slabStr,
        outcome: "rpc-error",
      });
      break;
  }
  return result;
}
