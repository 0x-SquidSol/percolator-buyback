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
 *   2. Drop the local `buildStakeTriggerBuybackIxStub` helper and call
 *      the real `buildStakeTriggerBuybackIx` from `@percolatorct/sdk`
 *      (which lands alongside this file's first dependency-bearing
 *      commit). The classification logic and call shape do not
 *      change; only the instruction encoder swaps in.
 *
 * **Why the simulated instruction is stubbed today:** the SDK
 * encoder (`buildStakeTriggerBuybackIx`) is staged separately and
 * lands in its own change; landing a half-implemented service file
 * just to wait for the encoder makes the diff harder to review. The
 * stub builds a no-op `SystemProgram.transfer(payer → payer, 0
 * lamports)` so the call to `simulateTransaction` is well-formed
 * end-to-end. Tests inject the simulate response directly via a
 * mock, so the four outcome paths (`would-fire`, `blocked`,
 * `rpc-error`, `not-live`) are exercised without depending on the
 * real instruction at all. When the encoder lands, the swap is
 * scoped: drop the local stub function, drop its `import` (if any
 * gets added), and replace the single call site with
 * `buildStakeTriggerBuybackIx(...)` from `@percolatorct/sdk`. The
 * classifier and log shapes do not move.
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
import { parseBuybackBlockerName } from "@percolatorct/sdk";
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

/**
 * Stub for the real `buildStakeTriggerBuybackIx` from
 * `@percolatorct/sdk`. Replaced at the encoder's landing commit; see
 * the module header for the swap recipe. The stub returns a no-op
 * SystemProgram self-transfer of 0 lamports — a syntactically valid
 * instruction that lets the message compile and the simulate call go
 * through end-to-end. Test files mock the simulate response directly,
 * so the stub's content does not affect classification.
 */
function buildStakeTriggerBuybackIxStub(
  payer: PublicKey,
): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: payer,
    lamports: 0,
  });
}

/**
 * Walk the simulation logs for a `BuybackBlocker` variant name. Anchor
 * programs surface user errors in two shapes — both are checked:
 *
 *   - `Program log: AnchorError ... Error Code: <Name>. ...`
 *   - `Program log: Custom error code: 0x<hex>` (where the hex value,
 *     minus Anchor's `0x1770` (= 6000) base offset, is the
 *     `BuybackBlocker` discriminant).
 *
 * Returns `null` when no recognizable variant is present. The caller
 * then treats the response as a non-blocker failure (rpc-error or
 * not-live) rather than misclassifying it as `blocked` with no name.
 */
function extractBlocker(logs: readonly string[]): string | null {
  for (const line of logs) {
    const named = line.match(/Error Code: (\w+)\b/);
    if (named !== null) return named[1] ?? null;
    const numeric = line.match(/Custom error code:?\s*0x([0-9a-fA-F]+)/);
    if (numeric !== null) {
      const code = parseInt(numeric[1] ?? "", 16) - 6000;
      const name = parseBuybackBlockerName(code);
      if (name !== null) return name;
    }
  }
  return null;
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
  const blocker = extractBlocker(sim.logs ?? []);
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
 * Run the eligibility probe for a single slab. Builds a stub-encoded
 * `stake_trigger_buyback` transaction, asks the RPC to simulate it,
 * and emits one structured log line for the outcome. Always returns
 * an `EligibilityResult` — never throws (RPC faults become
 * `rpc-error` results so the caller can decide on retry vs. skip
 * without a try/catch wrapper at every probe site).
 */
export async function probeEligibility(
  connection: Connection,
  slab: PublicKey,
  payer: PublicKey,
): Promise<EligibilityResult> {
  const slabStr = slab.toBase58();

  let sim: SimulatedTransactionResponse;
  try {
    const ix = buildStakeTriggerBuybackIxStub(payer);
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
