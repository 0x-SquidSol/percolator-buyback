/**
 * @module lib/round-trip
 *
 * Idempotent state machine for the buyback cranker round-trip.
 *
 * After `trigger_buyback` reserves a slice in the `BuybackTreasury` on-chain,
 * the keeper executes an off-chain sequence — convert → buy → add-liquidity →
 * burn-LP → settle (PROPOSAL.md §5.2). A crash mid-sequence must RESUME from
 * the last completed leg, never restart: re-running a completed leg would
 * double-spend the slice (a second buy) or the bought tokens (a second
 * add-liquidity).
 *
 * This module is the pure, persistence-agnostic core — it models the stages,
 * the single legal forward transition out of each, and the resume point. The
 * leg execution (Jupiter / AMM / Token-2022) and the durable store (file / kv
 * / sqlite) plug in at the call site.
 *
 * **At-most-once contract (call-site responsibility).** This module sequences
 * the legs; it cannot by itself guarantee each leg runs at most once. The
 * caller must (a) persist the advanced stage only AFTER the leg's on-chain
 * effect is confirmed, and (b) on resume, before re-running {@link pendingLeg},
 * check on-chain state for a leg whose effect may have landed before the crash
 * (e.g. a `round_trip_id` already in `BuybackState`'s settled ring buffer).
 *
 * **Transfer destination:** `dcccrypto/percolator-keeper/src/lib/` (or wherever
 * the destination keeps cranker-internal helpers). Pure TS, no Solana or RPC
 * dependency — carries over as-is.
 */

/** The ordered stages a buyback round-trip passes through. */
export const ROUND_TRIP_STAGES = [
  "triggered", // on-chain trigger landed; slice reserved in the treasury
  "converted", // slice -> pair asset (this stage is skipped when pair == collateral)
  "bought", // pair -> buyback token on the bound pool
  "liquidity_added", // token + pair deposited; LP receipt held
  "lp_burned", // LP receipt destroyed via Token-2022 Burn
  "settled", // settle_buyback landed; round-trip complete (terminal)
] as const;

/** A single stage of the round-trip. */
export type RoundTripStage = (typeof ROUND_TRIP_STAGES)[number];

/**
 * A leg of the off-chain round-trip. Completing a leg advances the stage by
 * exactly one transition (see {@link completeLeg}).
 */
export type RoundTripLeg =
  | "convert"
  | "buy"
  | "add_liquidity"
  | "burn_lp"
  | "settle";

/** Persisted state of one round-trip. Identity is `roundTripId`. */
export interface RoundTripState {
  /** Cranker-generated id (a u64 as a decimal string); the settle ring-buffer key. */
  readonly roundTripId: string;
  /** The market (slab) pubkey this round-trip belongs to. */
  readonly market: string;
  /** The current stage. */
  readonly stage: RoundTripStage;
  /**
   * Whether a convert leg applies (the bound pair asset differs from the
   * collateral). Pinned at creation from the market's `BuybackConfig`; a
   * collateral-paired pool skips the convert stage entirely.
   */
  readonly needsConvert: boolean;
}

/** Construct a fresh round-trip at the `triggered` stage. */
export function newRoundTrip(
  roundTripId: string,
  market: string,
  needsConvert: boolean,
): RoundTripState {
  return { roundTripId, market, stage: "triggered", needsConvert };
}

/** True when the round-trip has settled — no further legs to run. */
export function isComplete(state: RoundTripState): boolean {
  return state.stage === "settled";
}

/**
 * The leg that must run next from the current stage, or `null` when the
 * round-trip is settled. The `triggered` stage dispatches to `convert` or
 * directly to `buy` depending on {@link RoundTripState.needsConvert}.
 */
export function pendingLeg(state: RoundTripState): RoundTripLeg | null {
  switch (state.stage) {
    case "triggered":
      return state.needsConvert ? "convert" : "buy";
    case "converted":
      return "buy";
    case "bought":
      return "add_liquidity";
    case "liquidity_added":
      return "burn_lp";
    case "lp_burned":
      return "settle";
    case "settled":
      return null;
  }
}

/** The stage reached after a leg completes. */
function stageAfterLeg(leg: RoundTripLeg): RoundTripStage {
  switch (leg) {
    case "convert":
      return "converted";
    case "buy":
      return "bought";
    case "add_liquidity":
      return "liquidity_added";
    case "burn_lp":
      return "lp_burned";
    case "settle":
      return "settled";
  }
}

/**
 * Record that `leg` completed and advance the stage. Returns a NEW state;
 * never mutates the input.
 *
 * Throws if `leg` is not the {@link pendingLeg} for the current stage — the
 * idempotency guard. This rejects both an out-of-order completion AND a
 * re-completion of an already-done leg (the resume-after-crash hazard), so a
 * buggy or double-fired call site fails loudly instead of silently
 * double-spending.
 */
export function completeLeg(
  state: RoundTripState,
  leg: RoundTripLeg,
): RoundTripState {
  const expected = pendingLeg(state);
  if (expected === null) {
    throw new Error(
      `round-trip ${state.roundTripId} is already settled; cannot complete leg "${leg}"`,
    );
  }
  if (leg !== expected) {
    throw new Error(
      `round-trip ${state.roundTripId} at stage "${state.stage}" expects leg "${expected}", got "${leg}"`,
    );
  }
  return { ...state, stage: stageAfterLeg(leg) };
}
