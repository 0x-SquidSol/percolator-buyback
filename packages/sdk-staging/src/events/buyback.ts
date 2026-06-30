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
  /** The market's bound buyback token mint. */
  tokenMint: PublicKey;
  /** `BuybackTreasury` balance before this event (collateral base units). */
  treasuryBalanceBefore: bigint;
  /** Amount credited to stakers by the reserve-first step (collateral base units). */
  reserveTopup: bigint;
  /** Amount reserved for the round-trip (collateral base units). */
  slice: bigint;
  /** Q-format exposure at trigger (this market's exposure; observability only). */
  marketExposure: bigint;
  /** The `BuybackTreasury` account holding the reserved slice. */
  buybackTreasury: PublicKey;
}

/** Wire size of `BuybackTriggered`'s data section (no envelope). */
export const BUYBACK_TRIGGERED_BYTE_LENGTH = 8 + 32 + 8 + 8 + 8 + 16 + 32;

/**
 * Decode a `BuybackTriggered` event from its already-extracted data
 * section (no tag prefix or length framing — caller pre-strips those).
 * Throws if the input is the wrong length.
 */
export function decodeBuybackTriggered(data: Uint8Array): BuybackTriggered {
  assertExactLength(data, BUYBACK_TRIGGERED_BYTE_LENGTH, "BuybackTriggered");
  const c = new Cursor(data);
  const timestamp = c.readI64();
  const tokenMint = c.readPubkey();
  const treasuryBalanceBefore = c.readU64();
  const reserveTopup = c.readU64();
  const slice = c.readU64();
  const marketExposure = c.readU128();
  const buybackTreasury = c.readPubkey();
  return {
    timestamp,
    tokenMint,
    treasuryBalanceBefore,
    reserveTopup,
    slice,
    marketExposure,
    buybackTreasury,
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
  /** The market's bound buyback token mint. */
  tokenMint: PublicKey;
  /** Original slice in collateral base units. */
  slice: bigint;
  /** Pair-asset base units from the convert leg (the slice itself when no conversion). */
  pairAcquired: bigint;
  /** Buyback token purchased on the bound pool (base units). */
  tokenBought: bigint;
  /** Pair-asset base units paired with the bought token for add-LP. */
  pairPaired: bigint;
  /** Token-2022 LP tokens destroyed. */
  lpTokensBurned: bigint;
  /** The market's bound pool — equals `BuybackConfig.pool` post-validation. */
  poolPubkey: PublicKey;
  /**
   * `token_bought × 10^12 / pair_paired` (Q12 ratio); `u128::MAX`
   * (`340282366920938463463374607431768211455n`) when pair_paired was 0.
   * Use {@link isRealizedTokenPerPairSentinel} to test for the
   * sentinel — naive arithmetic on the raw value will silently
   * dominate any aggregate.
   */
  realizedTokenPerPair: bigint;
}

/** Wire size of `LiquidityLocked`'s data section (no envelope). */
export const LIQUIDITY_LOCKED_BYTE_LENGTH = 32 + 8 + 8 + 8 + 8 + 8 + 32 + 16;

/**
 * Decode a `LiquidityLocked` event from its already-extracted data
 * section. Throws if the input is the wrong length.
 */
export function decodeLiquidityLocked(data: Uint8Array): LiquidityLocked {
  assertExactLength(data, LIQUIDITY_LOCKED_BYTE_LENGTH, "LiquidityLocked");
  const c = new Cursor(data);
  const tokenMint = c.readPubkey();
  const slice = c.readU64();
  const pairAcquired = c.readU64();
  const tokenBought = c.readU64();
  const pairPaired = c.readU64();
  const lpTokensBurned = c.readU64();
  const poolPubkey = c.readPubkey();
  const realizedTokenPerPair = c.readU128();
  return {
    tokenMint,
    slice,
    pairAcquired,
    tokenBought,
    pairPaired,
    lpTokensBurned,
    poolPubkey,
    realizedTokenPerPair,
  };
}

// ═══════════════════════════════════════════════════════════════
// Sentinel predicates
// ═══════════════════════════════════════════════════════════════
//
// On-chain `settle_buyback` saturates `LiquidityLocked.realizedTokenPerPair`
// to `u128::MAX` when `pair_paired` is 0, rather than emitting a
// divide-by-zero. Consumers that aggregate or display the field must treat
// the sentinel as "no meaningful ratio for this event", not as a real
// measurement — `Number(b)` on the sentinel produces ~3.4e38 and silently
// corrupts averages and dashboards. Use the predicate below to branch.

/** Sentinel value emitted in `LiquidityLocked.realizedTokenPerPair` when pair_paired was 0. */
export const REALIZED_TOKEN_PER_PAIR_SENTINEL: bigint = (1n << 128n) - 1n;

/**
 * True when `realizedTokenPerPair` carries the divide-by-zero sentinel
 * ({@link REALIZED_TOKEN_PER_PAIR_SENTINEL}, i.e. on-chain `pair_paired`
 * was 0). Returns false for any real value.
 */
export function isRealizedTokenPerPairSentinel(realizedTokenPerPair: bigint): boolean {
  return realizedTokenPerPair === REALIZED_TOKEN_PER_PAIR_SENTINEL;
}

// ═══════════════════════════════════════════════════════════════
// Event discriminators + framed-chunk router
// ═══════════════════════════════════════════════════════════════
//
// percolator-stake emits each buyback event as ONE `sol_log_data` chunk of
// `[8-byte discriminator][field section]`. The decoders above consume the field
// section only; `decodeBuybackEvent` matches the leading discriminator, strips
// it, and routes to the right decoder — the off-chain mirror of `event.rs`.

/** Length of the leading event discriminator on each emitted log chunk. */
export const EVENT_DISCRIMINATOR_LEN = 8;

/** Discriminator prefix of a `BuybackTriggered` log chunk ("BBTRIGv1"). */
export const BUYBACK_TRIGGERED_DISCRIMINATOR: Uint8Array =
  new TextEncoder().encode("BBTRIGv1");

/** Discriminator prefix of a `LiquidityLocked` log chunk ("BBLOCKv1"). */
export const LIQUIDITY_LOCKED_DISCRIMINATOR: Uint8Array =
  new TextEncoder().encode("BBLOCKv1");

/**
 * A decoded buyback event tagged by kind. The shape an event-stream consumer
 * (e.g. the indexer aggregator) folds over.
 */
export type BuybackEvent =
  | { kind: "triggered"; event: BuybackTriggered }
  | { kind: "locked"; event: LiquidityLocked };

/**
 * Decode a full on-chain event chunk — `[8-byte discriminator][field bytes]`,
 * the single `sol_log_data` chunk percolator-stake emits (already base64-decoded
 * from the `Program data:` log line) — into a tagged {@link BuybackEvent}.
 *
 * Returns `null` when the discriminator matches neither buyback event (any other
 * program-data log), so a consumer can scan a mixed log stream and skip
 * unrelated chunks. A chunk whose discriminator DOES match but whose field
 * section is the wrong length throws (via the underlying decoder) — a corrupt
 * event is loud, not silently dropped.
 */
export function decodeBuybackEvent(data: Uint8Array): BuybackEvent | null {
  if (data.length < EVENT_DISCRIMINATOR_LEN) return null;
  const disc = data.subarray(0, EVENT_DISCRIMINATOR_LEN);
  const fields = data.subarray(EVENT_DISCRIMINATOR_LEN);
  if (bytesEqual(disc, BUYBACK_TRIGGERED_DISCRIMINATOR)) {
    return { kind: "triggered", event: decodeBuybackTriggered(fields) };
  }
  if (bytesEqual(disc, LIQUIDITY_LOCKED_DISCRIMINATOR)) {
    return { kind: "locked", event: decodeLiquidityLocked(fields) };
  }
  return null;
}

/** Byte-array equality (length + content). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
