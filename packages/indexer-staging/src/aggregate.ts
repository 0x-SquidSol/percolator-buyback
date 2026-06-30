/**
 * @module aggregate
 *
 * Headline buyback metrics for the indexer dashboard, folded from the two
 * on-chain events (PROPOSAL.md §6.4 "indexer, required at T+0"):
 *
 *   - **Cumulative LP burned** — `Σ LiquidityLocked.lpTokensBurned`. The
 *     permanent-liquidity proxy: every burned LP receipt is liquidity that can
 *     never be withdrawn, so this only ever grows.
 *   - **Locked liquidity (base units)** — `Σ tokenBought` (token side) and
 *     `Σ pairPaired` (pair side) deposited into the burned LP. A USD figure is a
 *     downstream multiply by each asset's price; we keep the exact base-unit
 *     amounts here so the price layer stays out of the indexer core.
 *   - **Reserve top-ups** — `Σ BuybackTriggered.reserveTopup`, the running total
 *     the reserve-first step has credited to stakers (the A-plus backstop).
 *   - Trigger / settle counts and the latest realized price per market.
 *
 * This module is the pure aggregation core — a mutable reducer over already
 * **decoded** events ({@link applyTriggered} / {@link applyLocked} mutate the
 * accumulator in place, the standard indexer pattern). The raw-log → decode step
 * (`decodeBuybackTriggered` / `decodeLiquidityLocked`) and the durable store
 * (Supabase) plug in at the call site.
 *
 * `realizedTokenPerPair` is deliberately NOT summed — it is a per-event Q12
 * ratio, and its divide-by-zero sentinel (`u128::MAX`) would dominate any total.
 * Only the latest *real* value is retained per market, via the SDK's
 * {@link isRealizedTokenPerPairSentinel} guard.
 *
 * **Transfer destination:** `dcccrypto/percolator-indexer/src/` — merges into
 * the event-processing pipeline that feeds the Supabase tables. Pure TS; no
 * Hono / Supabase / RPC dependency.
 */

import {
  isRealizedTokenPerPairSentinel,
  type BuybackTriggered,
  type LiquidityLocked,
  type BuybackEvent,
} from "@percolatorct/sdk";

// Re-exported so the decoded-event shape has a single source of truth: the
// SDK's `decodeBuybackEvent` produces exactly this, and the indexer's
// log->event router feeds it straight into `aggregate`.
export type { BuybackEvent };

/** Per-market rollup. All `bigint` sums are exact (no Number coercion). */
export interface MarketMetrics {
  /** Bound buyback token mint, base58. */
  readonly tokenMint: string;
  /** `BuybackTriggered` events seen. */
  triggers: number;
  /** `LiquidityLocked` (settle) events seen. */
  settles: number;
  /** Σ settled slice (collateral base units). */
  cumulativeSlice: bigint;
  /** Σ reserve-first credit to stakers (collateral base units). */
  cumulativeReserveTopup: bigint;
  /** Σ buyback token deposited into the burned LP (token side). */
  cumulativeTokenBought: bigint;
  /** Σ pair asset deposited into the burned LP (pair side). */
  cumulativePairPaired: bigint;
  /** Σ Token-2022 LP receipts destroyed — the permanent-liquidity proxy. */
  cumulativeLpBurned: bigint;
  /** Max trigger timestamp seen, or null if no trigger yet. */
  lastTriggerTs: bigint | null;
  /** Most recent settle's pool, base58, or null. */
  lastPool: string | null;
  /** Most recent NON-sentinel `realizedTokenPerPair` (Q12), or null. */
  lastRealizedTokenPerPair: bigint | null;
}

/** Protocol-wide rollup plus the per-market breakdown. */
export interface BuybackMetrics {
  triggers: number;
  settles: number;
  cumulativeSlice: bigint;
  cumulativeReserveTopup: bigint;
  cumulativeTokenBought: bigint;
  cumulativePairPaired: bigint;
  cumulativeLpBurned: bigint;
  lastTriggerTs: bigint | null;
  /** Keyed by `tokenMint` base58. */
  perMarket: Map<string, MarketMetrics>;
}

/** A fresh, zeroed accumulator. */
export function createMetrics(): BuybackMetrics {
  return {
    triggers: 0,
    settles: 0,
    cumulativeSlice: 0n,
    cumulativeReserveTopup: 0n,
    cumulativeTokenBought: 0n,
    cumulativePairPaired: 0n,
    cumulativeLpBurned: 0n,
    lastTriggerTs: null,
    perMarket: new Map(),
  };
}

function marketEntry(m: BuybackMetrics, tokenMint: string): MarketMetrics {
  let mm = m.perMarket.get(tokenMint);
  if (mm === undefined) {
    mm = {
      tokenMint,
      triggers: 0,
      settles: 0,
      cumulativeSlice: 0n,
      cumulativeReserveTopup: 0n,
      cumulativeTokenBought: 0n,
      cumulativePairPaired: 0n,
      cumulativeLpBurned: 0n,
      lastTriggerTs: null,
      lastPool: null,
      lastRealizedTokenPerPair: null,
    };
    m.perMarket.set(tokenMint, mm);
  }
  return mm;
}

function maxTs(prev: bigint | null, next: bigint): bigint {
  return prev === null || next > prev ? next : prev;
}

/** Fold one `BuybackTriggered` into the accumulator (mutates in place). */
export function applyTriggered(m: BuybackMetrics, e: BuybackTriggered): void {
  const mm = marketEntry(m, e.tokenMint.toBase58());
  m.triggers += 1;
  mm.triggers += 1;
  m.cumulativeReserveTopup += e.reserveTopup;
  mm.cumulativeReserveTopup += e.reserveTopup;
  m.lastTriggerTs = maxTs(m.lastTriggerTs, e.timestamp);
  mm.lastTriggerTs = maxTs(mm.lastTriggerTs, e.timestamp);
}

/** Fold one `LiquidityLocked` (settle) into the accumulator (mutates in place). */
export function applyLocked(m: BuybackMetrics, e: LiquidityLocked): void {
  const mm = marketEntry(m, e.tokenMint.toBase58());
  m.settles += 1;
  mm.settles += 1;
  m.cumulativeSlice += e.slice;
  mm.cumulativeSlice += e.slice;
  m.cumulativeTokenBought += e.tokenBought;
  mm.cumulativeTokenBought += e.tokenBought;
  m.cumulativePairPaired += e.pairPaired;
  mm.cumulativePairPaired += e.pairPaired;
  m.cumulativeLpBurned += e.lpTokensBurned;
  mm.cumulativeLpBurned += e.lpTokensBurned;
  mm.lastPool = e.poolPubkey.toBase58();
  // Skip the divide-by-zero sentinel so the dashboard never shows ~3.4e38.
  if (!isRealizedTokenPerPairSentinel(e.realizedTokenPerPair)) {
    mm.lastRealizedTokenPerPair = e.realizedTokenPerPair;
  }
}

/** Reduce a mixed event stream into a fresh {@link BuybackMetrics}. */
export function aggregate(events: Iterable<BuybackEvent>): BuybackMetrics {
  const m = createMetrics();
  for (const e of events) {
    if (e.kind === "triggered") applyTriggered(m, e.event);
    else applyLocked(m, e.event);
  }
  return m;
}
