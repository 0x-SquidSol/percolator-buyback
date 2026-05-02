/**
 * @module events/buyback
 *
 * Decoders for the two events the percolator-stake program emits as
 * part of the buyback round-trip: `BuybackTriggered` (after each
 * successful trigger) and `LiquidityLocked` (after each settle).
 *
 * **Transfer destination:** drop this file at
 * `dcccrypto/percolator-sdk/src/events/buyback.ts` (or the destination's
 * preferred event-parser path; `slab.ts`-equivalents live under
 * `src/solana/` in the destination, and the destination may already
 * have an `src/events/` directory or expect parsers elsewhere). The
 * inline `dec*` byte-reader helpers in this file are self-contained;
 * if the destination has an equivalent decode prelude, the integrator
 * may extract them at transfer time.
 *
 * **Field layouts pinned at:** `INTEGRATION.md` `## dcccrypto/percolator-stake`
 * step 7 (locker-rule append-only). Every name, type, and declaration
 * order in this file must match that spec byte-for-byte. Adding a new
 * field at the tail is allowed; reordering or removing is not.
 *
 * **Wire-format assumption:** the input `data` argument is the
 * already-extracted data section of the event log, with no tag prefix
 * or length framing. Whatever wrapping the destination's event-emission
 * helper applies (tag byte, program-data discriminator, base64
 * envelope) is unwrapped by the caller before invoking these parsers.
 * The keeper and indexer typically receive event payloads pre-decoded
 * from `sol_log_data` lines.
 */

import { PublicKey } from "@solana/web3.js";

// ═══════════════════════════════════════════════════════════════
// Inline decode helpers (LE byte readers)
// ═══════════════════════════════════════════════════════════════

class Cursor {
  private offset: number;
  private readonly view: DataView;

  constructor(public readonly data: Uint8Array) {
    this.offset = 0;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  readU64(): bigint {
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readI64(): bigint {
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readU128(): bigint {
    const lo = this.view.getBigUint64(this.offset, true);
    const hi = this.view.getBigUint64(this.offset + 8, true);
    this.offset += 16;
    return (hi << 64n) | lo;
  }

  readPubkey(): PublicKey {
    const bytes = this.data.slice(this.offset, this.offset + 32);
    this.offset += 32;
    return new PublicKey(bytes);
  }

  remaining(): number {
    return this.data.length - this.offset;
  }
}

function assertExactLength(
  data: Uint8Array,
  expected: number,
  eventName: string,
): void {
  if (data.length !== expected) {
    throw new Error(
      `${eventName}: data length must be exactly ${expected} bytes, got ${data.length}`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// BuybackTriggered
// ═══════════════════════════════════════════════════════════════

/**
 * Decoded `BuybackTriggered` event. Field shapes match
 * `INTEGRATION.md` `## dcccrypto/percolator-stake` step 7. Numeric
 * fields wider than 32 bits use `bigint` (no precision loss); narrower
 * values stay as `number` only for fields that fit safely in a JS
 * Number — currently none in this event.
 */
export interface BuybackTriggered {
  /** Solana Clock unix_timestamp at trigger landing. */
  timestamp: bigint;
  /** Slab insurance fund balance pre-withdrawal (collateral base units). */
  fundBalanceBefore: bigint;
  /** Amount withdrawn into the buyback pool (collateral base units). */
  slice: bigint;
  /** Q-format exposure used in the ratio gate. */
  totalProtocolExposure: bigint;
  /**
   * `fund × 10_000 / exposure` in basis points; `u64::MAX`
   * (`18446744073709551615n`) when exposure was 0. Use
   * {@link isRatioBpsSentinel} to test for the sentinel — naive
   * arithmetic on the raw value will produce visibly nonsensical
   * results (~1.8e15 bps).
   */
  ratioBps: bigint;
  /** Destination ATA receiving the slice. */
  buybackPool: PublicKey;
}

/** Wire size of `BuybackTriggered`'s data section (no envelope). */
export const BUYBACK_TRIGGERED_BYTE_LENGTH = 8 + 8 + 8 + 16 + 8 + 32;

/**
 * Decode a `BuybackTriggered` event from its already-extracted data
 * section (no tag prefix or length framing — caller pre-strips those).
 * Throws if the input is the wrong length.
 */
export function decodeBuybackTriggered(data: Uint8Array): BuybackTriggered {
  assertExactLength(data, BUYBACK_TRIGGERED_BYTE_LENGTH, "BuybackTriggered");
  const c = new Cursor(data);
  const timestamp = c.readI64();
  const fundBalanceBefore = c.readU64();
  const slice = c.readU64();
  const totalProtocolExposure = c.readU128();
  const ratioBps = c.readU64();
  const buybackPool = c.readPubkey();
  return {
    timestamp,
    fundBalanceBefore,
    slice,
    totalProtocolExposure,
    ratioBps,
    buybackPool,
  };
}

// ═══════════════════════════════════════════════════════════════
// LiquidityLocked
// ═══════════════════════════════════════════════════════════════

/**
 * Decoded `LiquidityLocked` event. Emitted after each successful
 * `settle_buyback` validation; the cumulative-LP-burned aggregator
 * sums `lpTokensBurned` across the feed.
 */
export interface LiquidityLocked {
  /** Original slice in collateral base units. */
  sliceUsdc: bigint;
  /** SOL bought via Jupiter (lamports). */
  solAcquired: bigint;
  /** $PERCOLATOR purchased on PumpSwap (base units). */
  percBought: bigint;
  /** SOL paired with $PERCOLATOR for add-LP (lamports). */
  solPaired: bigint;
  /** Token-2022 LP tokens destroyed. */
  lpTokensBurned: bigint;
  /** Canonical PumpSwap pool — always equals `CANONICAL_POOL` post-validation. */
  poolPubkey: PublicKey;
  /**
   * `perc_bought × 10^12 / sol_paired` (Q12 ratio); `u128::MAX`
   * (`340282366920938463463374607431768211455n`) when sol_paired was 0.
   * Use {@link isRealizedPercPerSolSentinel} to test for the
   * sentinel — naive arithmetic on the raw value will silently
   * dominate any aggregate.
   */
  realizedPercPerSol: bigint;
}

/** Wire size of `LiquidityLocked`'s data section (no envelope). */
export const LIQUIDITY_LOCKED_BYTE_LENGTH = 8 + 8 + 8 + 8 + 8 + 32 + 16;

/**
 * Decode a `LiquidityLocked` event from its already-extracted data
 * section. Throws if the input is the wrong length.
 */
export function decodeLiquidityLocked(data: Uint8Array): LiquidityLocked {
  assertExactLength(data, LIQUIDITY_LOCKED_BYTE_LENGTH, "LiquidityLocked");
  const c = new Cursor(data);
  const sliceUsdc = c.readU64();
  const solAcquired = c.readU64();
  const percBought = c.readU64();
  const solPaired = c.readU64();
  const lpTokensBurned = c.readU64();
  const poolPubkey = c.readPubkey();
  const realizedPercPerSol = c.readU128();
  return {
    sliceUsdc,
    solAcquired,
    percBought,
    solPaired,
    lpTokensBurned,
    poolPubkey,
    realizedPercPerSol,
  };
}

// ═══════════════════════════════════════════════════════════════
// Sentinel predicates
// ═══════════════════════════════════════════════════════════════
//
// On-chain `trigger_buyback` and `settle_buyback` saturate two ratio
// fields when their denominator is 0, rather than emitting a
// divide-by-zero. Consumers that aggregate or display these fields
// must treat the sentinel as "no meaningful ratio for this event",
// not as a real measurement — `Number(b) / 10_000` on the sentinel
// produces ~1.8e15 / 3.4e38 and silently corrupts averages and
// dashboards. Use the predicates below to branch.

/** Sentinel value emitted in `BuybackTriggered.ratioBps` when exposure was 0. */
export const RATIO_BPS_SENTINEL: bigint = 0xffff_ffff_ffff_ffffn;

/** Sentinel value emitted in `LiquidityLocked.realizedPercPerSol` when sol_paired was 0. */
export const REALIZED_PERC_PER_SOL_SENTINEL: bigint = (1n << 128n) - 1n;

/**
 * True when `ratioBps` carries the divide-by-zero sentinel
 * ({@link RATIO_BPS_SENTINEL}, i.e. on-chain `total_protocol_exposure`
 * was 0). Returns false for any real value, including u64::MAX-1.
 */
export function isRatioBpsSentinel(ratioBps: bigint): boolean {
  return ratioBps === RATIO_BPS_SENTINEL;
}

/**
 * True when `realizedPercPerSol` carries the divide-by-zero sentinel
 * ({@link REALIZED_PERC_PER_SOL_SENTINEL}, i.e. on-chain `sol_paired`
 * was 0). Returns false for any real value.
 */
export function isRealizedPercPerSolSentinel(realizedPercPerSol: bigint): boolean {
  return realizedPercPerSol === REALIZED_PERC_PER_SOL_SENTINEL;
}
