/**
 * Verification-only test suite for `events/buyback.ts`. **Does NOT
 * transfer** — proves the staged code is correct at the moment of
 * transfer; the destination writes its own tests against its own
 * fixture infrastructure (see `dcccrypto/percolator-sdk/test/`,
 * which is `tsx` + hand-rolled asserts, not vitest). Mirrors the
 * math-crate precedent: staging tests verify the staged source, then
 * stay home. See `INTEGRATION.md` `## dcccrypto/percolator-sdk`.
 */
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  BUYBACK_TRIGGERED_BYTE_LENGTH,
  LIQUIDITY_LOCKED_BYTE_LENGTH,
  decodeBuybackTriggered,
  decodeLiquidityLocked,
} from "./buyback.js";

// ═══════════════════════════════════════════════════════════════
// Test fixture builders — packed-LE encoders mirroring the spec
// ═══════════════════════════════════════════════════════════════

function u64LE(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

function i64LE(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, v, true);
  return b;
}

function u128LE(v: bigint): Uint8Array {
  const b = new Uint8Array(16);
  const lo = v & 0xffff_ffff_ffff_ffffn;
  const hi = v >> 64n;
  const view = new DataView(b.buffer);
  view.setBigUint64(0, lo, true);
  view.setBigUint64(8, hi, true);
  return b;
}

function pubkeyBytes(pk: PublicKey): Uint8Array {
  return pk.toBytes();
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

const FIXED_PUBKEY = new PublicKey(
  "DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F",
);
const ANOTHER_PUBKEY = new PublicKey(
  "11111111111111111111111111111111",
);

// ═══════════════════════════════════════════════════════════════
// BuybackTriggered
// ═══════════════════════════════════════════════════════════════

describe("BUYBACK_TRIGGERED_BYTE_LENGTH", () => {
  it("is 80 bytes (i64 + u64×3 + u128 + Pubkey)", () => {
    expect(BUYBACK_TRIGGERED_BYTE_LENGTH).toBe(80);
  });
});

describe("decodeBuybackTriggered", () => {
  it("decodes a fully-populated event byte-for-byte", () => {
    const data = concat(
      i64LE(1_700_000_000n),                  // timestamp
      u64LE(1_000_000_000n),                  // fundBalanceBefore
      u64LE(1_000_000n),                      // slice (0.1% of fund)
      u128LE(500_000_000n),                   // totalProtocolExposure
      u64LE(20_000n),                         // ratioBps (2.0×)
      pubkeyBytes(FIXED_PUBKEY),              // buybackPool
    );

    const evt = decodeBuybackTriggered(data);
    expect(evt.timestamp).toBe(1_700_000_000n);
    expect(evt.fundBalanceBefore).toBe(1_000_000_000n);
    expect(evt.slice).toBe(1_000_000n);
    expect(evt.totalProtocolExposure).toBe(500_000_000n);
    expect(evt.ratioBps).toBe(20_000n);
    expect(evt.buybackPool.toBase58()).toBe(FIXED_PUBKEY.toBase58());
  });

  it("decodes negative timestamp (defensive — Solana clock is non-negative but type allows)", () => {
    const data = concat(
      i64LE(-1n),
      u64LE(0n),
      u64LE(0n),
      u128LE(0n),
      u64LE(0n),
      pubkeyBytes(FIXED_PUBKEY),
    );
    expect(decodeBuybackTriggered(data).timestamp).toBe(-1n);
  });

  it("decodes u128 exposure at the high end", () => {
    const data = concat(
      i64LE(0n),
      u64LE(0n),
      u64LE(0n),
      u128LE((1n << 128n) - 1n),
      u64LE(0n),
      pubkeyBytes(FIXED_PUBKEY),
    );
    expect(decodeBuybackTriggered(data).totalProtocolExposure).toBe(
      (1n << 128n) - 1n,
    );
  });

  it("decodes ratioBps at u64::MAX (the divide-by-zero saturation value)", () => {
    const data = concat(
      i64LE(0n),
      u64LE(0n),
      u64LE(0n),
      u128LE(0n),
      u64LE(0xffff_ffff_ffff_ffffn),
      pubkeyBytes(FIXED_PUBKEY),
    );
    expect(decodeBuybackTriggered(data).ratioBps).toBe(
      0xffff_ffff_ffff_ffffn,
    );
  });

  it("rejects data shorter than the wire size", () => {
    const data = new Uint8Array(BUYBACK_TRIGGERED_BYTE_LENGTH - 1);
    expect(() => decodeBuybackTriggered(data)).toThrow(/exactly 80 bytes/);
  });

  it("rejects data longer than the wire size", () => {
    const data = new Uint8Array(BUYBACK_TRIGGERED_BYTE_LENGTH + 1);
    expect(() => decodeBuybackTriggered(data)).toThrow(/exactly 80 bytes/);
  });

  it("rejects empty data", () => {
    expect(() => decodeBuybackTriggered(new Uint8Array(0))).toThrow(
      /exactly 80 bytes/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// LiquidityLocked
// ═══════════════════════════════════════════════════════════════

describe("LIQUIDITY_LOCKED_BYTE_LENGTH", () => {
  it("is 88 bytes (u64×5 + Pubkey + u128)", () => {
    expect(LIQUIDITY_LOCKED_BYTE_LENGTH).toBe(88);
  });
});

describe("decodeLiquidityLocked", () => {
  it("decodes a fully-populated event byte-for-byte", () => {
    const data = concat(
      u64LE(1_000_000n),                      // sliceUsdc
      u64LE(50_000_000_000n),                 // solAcquired (50 SOL in lamports)
      u64LE(1_500_000_000_000n),              // percBought
      u64LE(25_000_000_000n),                 // solPaired
      u64LE(193_649_167_310n),                // lpTokensBurned (sqrt of perc × sol)
      pubkeyBytes(ANOTHER_PUBKEY),            // poolPubkey
      u128LE(60_000_000_000_000_000n),        // realizedPercPerSol (60 perc/sol × 1e12)
    );

    const evt = decodeLiquidityLocked(data);
    expect(evt.sliceUsdc).toBe(1_000_000n);
    expect(evt.solAcquired).toBe(50_000_000_000n);
    expect(evt.percBought).toBe(1_500_000_000_000n);
    expect(evt.solPaired).toBe(25_000_000_000n);
    expect(evt.lpTokensBurned).toBe(193_649_167_310n);
    expect(evt.poolPubkey.toBase58()).toBe(ANOTHER_PUBKEY.toBase58());
    expect(evt.realizedPercPerSol).toBe(60_000_000_000_000_000n);
  });

  it("decodes realizedPercPerSol at u128::MAX (the divide-by-zero saturation value)", () => {
    const data = concat(
      u64LE(0n),
      u64LE(0n),
      u64LE(0n),
      u64LE(0n),
      u64LE(0n),
      pubkeyBytes(FIXED_PUBKEY),
      u128LE((1n << 128n) - 1n),
    );
    expect(decodeLiquidityLocked(data).realizedPercPerSol).toBe(
      (1n << 128n) - 1n,
    );
  });

  it("rejects data shorter than the wire size", () => {
    const data = new Uint8Array(LIQUIDITY_LOCKED_BYTE_LENGTH - 1);
    expect(() => decodeLiquidityLocked(data)).toThrow(/exactly 88 bytes/);
  });

  it("rejects data longer than the wire size", () => {
    const data = new Uint8Array(LIQUIDITY_LOCKED_BYTE_LENGTH + 1);
    expect(() => decodeLiquidityLocked(data)).toThrow(/exactly 88 bytes/);
  });
});

// ═══════════════════════════════════════════════════════════════
// Field-order regression — the locker rule's TS counterpart
// ═══════════════════════════════════════════════════════════════

describe("field-order regression", () => {
  it("BuybackTriggered: changing field order shifts the decoded values", () => {
    // Sentinel: if a future edit accidentally swaps `slice` and `fundBalanceBefore`,
    // this test fails because the spec'd values land in wrong slots.
    const data = concat(
      i64LE(0n),
      u64LE(111n),                     // fundBalanceBefore
      u64LE(222n),                     // slice
      u128LE(333n),                    // totalProtocolExposure
      u64LE(444n),                     // ratioBps
      pubkeyBytes(FIXED_PUBKEY),
    );
    const evt = decodeBuybackTriggered(data);
    expect(evt.fundBalanceBefore).toBe(111n);
    expect(evt.slice).toBe(222n);
    expect(evt.totalProtocolExposure).toBe(333n);
    expect(evt.ratioBps).toBe(444n);
  });

  it("LiquidityLocked: changing field order shifts the decoded values", () => {
    const data = concat(
      u64LE(11n),                      // sliceUsdc
      u64LE(22n),                      // solAcquired
      u64LE(33n),                      // percBought
      u64LE(44n),                      // solPaired
      u64LE(55n),                      // lpTokensBurned
      pubkeyBytes(FIXED_PUBKEY),
      u128LE(66n),                     // realizedPercPerSol
    );
    const evt = decodeLiquidityLocked(data);
    expect(evt.sliceUsdc).toBe(11n);
    expect(evt.solAcquired).toBe(22n);
    expect(evt.percBought).toBe(33n);
    expect(evt.solPaired).toBe(44n);
    expect(evt.lpTokensBurned).toBe(55n);
    expect(evt.realizedPercPerSol).toBe(66n);
  });
});

// ═══════════════════════════════════════════════════════════════
// byteOffset regression — Cursor must honor non-zero view offsets
// ═══════════════════════════════════════════════════════════════
//
// Two byteOffset-sensitive paths exist in the Cursor:
//   1. DataView construction → readU64 / readI64 / readU128
//   2. data.slice()           → readPubkey
// Each test covers one decoder against both paths. The backing
// buffer is padded with 0xff sentinel bytes so any offset-ignoring
// read produces visibly-wrong values rather than silent zero
// pass-through. Prefix sizes are odd primes (7, 11) to defeat any
// accidental alignment assumption.

describe("byteOffset regression", () => {
  it("decodeBuybackTriggered: decodes correctly from a non-zero-byteOffset Uint8Array view", () => {
    const PREFIX = 7;
    const payload = concat(
      i64LE(1_700_000_000n),
      u64LE(1_000_000_000n),
      u64LE(1_000_000n),
      u128LE(500_000_000n),
      u64LE(20_000n),
      pubkeyBytes(FIXED_PUBKEY),
    );
    const backing = new Uint8Array(PREFIX + payload.length + PREFIX);
    backing.fill(0xff);
    backing.set(payload, PREFIX);
    const view = backing.subarray(PREFIX, PREFIX + payload.length);
    expect(view.byteOffset).toBe(PREFIX);

    const evt = decodeBuybackTriggered(view);
    expect(evt.timestamp).toBe(1_700_000_000n); // DataView path
    expect(evt.buybackPool.toBase58()).toBe(FIXED_PUBKEY.toBase58()); // data.slice path
  });

  it("decodeLiquidityLocked: decodes correctly from a non-zero-byteOffset Uint8Array view", () => {
    const PREFIX = 11;
    const payload = concat(
      u64LE(1_000_000n),
      u64LE(50_000_000_000n),
      u64LE(1_500_000_000_000n),
      u64LE(25_000_000_000n),
      u64LE(193_649_167_310n),
      pubkeyBytes(ANOTHER_PUBKEY),
      u128LE(60_000_000_000_000_000n),
    );
    const backing = new Uint8Array(PREFIX + payload.length + PREFIX);
    backing.fill(0xff);
    backing.set(payload, PREFIX);
    const view = backing.subarray(PREFIX, PREFIX + payload.length);
    expect(view.byteOffset).toBe(PREFIX);

    const evt = decodeLiquidityLocked(view);
    expect(evt.poolPubkey.toBase58()).toBe(ANOTHER_PUBKEY.toBase58()); // data.slice path
    expect(evt.sliceUsdc).toBe(1_000_000n); // DataView path
  });
});
