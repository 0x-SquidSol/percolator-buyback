/**
 * Verification-only test suite for `src/aggregate.ts`. Proves the buyback
 * metrics reducer folds the two events correctly, keeps per-market and
 * protocol-wide totals in agreement, preserves bigint precision past
 * Number.MAX_SAFE_INTEGER, and never lets the realized-ratio sentinel into a
 * total.
 */
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  REALIZED_TOKEN_PER_PAIR_SENTINEL,
  type BuybackTriggered,
  type LiquidityLocked,
} from "@percolatorct/sdk";
import {
  createMetrics,
  applyTriggered,
  applyLocked,
  aggregate,
  type BuybackEvent,
} from "../src/aggregate.js";

const MINT_A = new PublicKey(new Uint8Array(32).fill(1));
const MINT_B = new PublicKey(new Uint8Array(32).fill(2));
const POOL = new PublicKey(new Uint8Array(32).fill(7));

function triggered(
  mint: PublicKey,
  o: Partial<BuybackTriggered> = {},
): BuybackTriggered {
  return {
    timestamp: 1000n,
    tokenMint: mint,
    treasuryBalanceBefore: 0n,
    reserveTopup: 0n,
    slice: 0n,
    marketExposure: 0n,
    buybackTreasury: PublicKey.default,
    ...o,
  };
}

function locked(
  mint: PublicKey,
  o: Partial<LiquidityLocked> = {},
): LiquidityLocked {
  return {
    tokenMint: mint,
    slice: 0n,
    pairAcquired: 0n,
    tokenBought: 0n,
    pairPaired: 0n,
    lpTokensBurned: 0n,
    poolPubkey: POOL,
    realizedTokenPerPair: 0n,
    ...o,
  };
}

describe("createMetrics", () => {
  it("is fully zeroed with no markets", () => {
    const m = createMetrics();
    expect(m.triggers).toBe(0);
    expect(m.settles).toBe(0);
    expect(m.cumulativeLpBurned).toBe(0n);
    expect(m.cumulativeReserveTopup).toBe(0n);
    expect(m.lastTriggerTs).toBeNull();
    expect(m.perMarket.size).toBe(0);
  });
});

describe("applyTriggered", () => {
  it("counts the trigger, sums reserve top-ups, and tracks the market", () => {
    const m = createMetrics();
    applyTriggered(m, triggered(MINT_A, { reserveTopup: 250n, timestamp: 1000n }));
    applyTriggered(m, triggered(MINT_A, { reserveTopup: 750n, timestamp: 2000n }));

    expect(m.triggers).toBe(2);
    expect(m.cumulativeReserveTopup).toBe(1000n);
    expect(m.lastTriggerTs).toBe(2000n);

    const a = m.perMarket.get(MINT_A.toBase58());
    expect(a?.triggers).toBe(2);
    expect(a?.cumulativeReserveTopup).toBe(1000n);
    expect(a?.lastTriggerTs).toBe(2000n);
  });

  it("keeps lastTriggerTs as the max regardless of arrival order", () => {
    const m = createMetrics();
    applyTriggered(m, triggered(MINT_A, { timestamp: 5000n }));
    applyTriggered(m, triggered(MINT_A, { timestamp: 3000n })); // older, out of order
    expect(m.lastTriggerTs).toBe(5000n);
    expect(m.perMarket.get(MINT_A.toBase58())?.lastTriggerTs).toBe(5000n);
  });
});

describe("applyLocked", () => {
  it("sums the locked-liquidity legs, burned LP, and records the pool", () => {
    const m = createMetrics();
    applyLocked(
      m,
      locked(MINT_A, {
        slice: 100n,
        tokenBought: 40n,
        pairPaired: 60n,
        lpTokensBurned: 48n,
        realizedTokenPerPair: 666n,
      }),
    );

    expect(m.settles).toBe(1);
    expect(m.cumulativeSlice).toBe(100n);
    expect(m.cumulativeTokenBought).toBe(40n);
    expect(m.cumulativePairPaired).toBe(60n);
    expect(m.cumulativeLpBurned).toBe(48n);

    const a = m.perMarket.get(MINT_A.toBase58());
    expect(a?.settles).toBe(1);
    expect(a?.cumulativeLpBurned).toBe(48n);
    expect(a?.lastPool).toBe(POOL.toBase58());
    expect(a?.lastRealizedTokenPerPair).toBe(666n);
  });

  it("retains the latest REAL realized ratio and ignores the sentinel", () => {
    const m = createMetrics();
    applyLocked(m, locked(MINT_A, { realizedTokenPerPair: 500n }));
    applyLocked(m, locked(MINT_A, { realizedTokenPerPair: REALIZED_TOKEN_PER_PAIR_SENTINEL }));
    // The sentinel settle still counts toward totals...
    expect(m.settles).toBe(2);
    // ...but must NOT overwrite the last real ratio.
    expect(m.perMarket.get(MINT_A.toBase58())?.lastRealizedTokenPerPair).toBe(500n);
  });

  it("leaves lastRealizedTokenPerPair null when only sentinels are seen", () => {
    const m = createMetrics();
    applyLocked(m, locked(MINT_A, { realizedTokenPerPair: REALIZED_TOKEN_PER_PAIR_SENTINEL }));
    expect(m.perMarket.get(MINT_A.toBase58())?.lastRealizedTokenPerPair).toBeNull();
  });

  it("preserves bigint precision past Number.MAX_SAFE_INTEGER", () => {
    const big = 9_000_000_000_000_000_000n; // > 2^53, near u64 max
    const m = createMetrics();
    applyLocked(m, locked(MINT_A, { lpTokensBurned: big }));
    applyLocked(m, locked(MINT_A, { lpTokensBurned: big }));
    expect(m.cumulativeLpBurned).toBe(18_000_000_000_000_000_000n);
  });
});

describe("multi-market + aggregate", () => {
  it("tracks markets separately while totals sum across them", () => {
    const events: BuybackEvent[] = [
      { kind: "triggered", event: triggered(MINT_A, { reserveTopup: 10n, timestamp: 100n }) },
      { kind: "locked", event: locked(MINT_A, { slice: 100n, lpTokensBurned: 5n }) },
      { kind: "triggered", event: triggered(MINT_B, { reserveTopup: 20n, timestamp: 200n }) },
      { kind: "locked", event: locked(MINT_B, { slice: 300n, lpTokensBurned: 7n }) },
    ];
    const m = aggregate(events);

    expect(m.triggers).toBe(2);
    expect(m.settles).toBe(2);
    expect(m.cumulativeReserveTopup).toBe(30n);
    expect(m.cumulativeSlice).toBe(400n);
    expect(m.cumulativeLpBurned).toBe(12n);
    expect(m.lastTriggerTs).toBe(200n);
    expect(m.perMarket.size).toBe(2);

    expect(m.perMarket.get(MINT_A.toBase58())?.cumulativeLpBurned).toBe(5n);
    expect(m.perMarket.get(MINT_B.toBase58())?.cumulativeSlice).toBe(300n);
    // Per-market totals reconcile with the protocol total.
    const sumLp = [...m.perMarket.values()].reduce((s, mm) => s + mm.cumulativeLpBurned, 0n);
    expect(sumLp).toBe(m.cumulativeLpBurned);
  });

  it("aggregate() of an empty stream equals a fresh accumulator", () => {
    const m = aggregate([]);
    expect(m.triggers).toBe(0);
    expect(m.settles).toBe(0);
    expect(m.perMarket.size).toBe(0);
  });
});
