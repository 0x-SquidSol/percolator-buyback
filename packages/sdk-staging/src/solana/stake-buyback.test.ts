/**
 * Verification-only test suite for `stake-buyback.ts`. **Does NOT
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
  STAKE_IX_BUYBACK,
  deriveBuybackState,
  deriveBuybackTreasury,
  deriveBuybackConfig,
  encodeStakeBindBuybackConfig,
  encodeStakeTriggerBuyback,
  encodeStakeSettleBuyback,
  encodeStakeEmergencyDrainTreasury,
  decodeBuybackConfig,
  decodeBuybackConfigAccount,
  BUYBACK_CONFIG_BYTE_LENGTH,
  BUYBACK_CONFIG_ACCOUNT_SIZE,
  BUYBACK_CONFIG_HEADER_LEN,
  BUYBACK_CONFIG_DISCRIMINATOR,
} from "./stake-buyback.js";

// Fixed pubkeys for reproducible PDA derivation tests. Programmatically
// generated via `Keypair.generate().publicKey.toBase58()` once and
// pinned here as base58 strings — using a real keypair would inject
// non-determinism into the suite.
const FIXED_POOL = new PublicKey(
  "11111111111111111111111111111111",
);
const FIXED_PROGRAM_ID = new PublicKey(
  "DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F", // percolator-stake mainnet from src/solana/stake.ts STAKE_PROGRAM_IDS
);

describe("STAKE_IX_BUYBACK", () => {
  it("freezes the placeholder tag values", () => {
    expect(STAKE_IX_BUYBACK.BindBuybackConfig).toBe(24);
    expect(STAKE_IX_BUYBACK.TriggerBuyback).toBe(25);
    expect(STAKE_IX_BUYBACK.SettleBuyback).toBe(26);
    expect(STAKE_IX_BUYBACK.EmergencyDrainTreasury).toBe(27);
    expect(Object.isFrozen(STAKE_IX_BUYBACK)).toBe(true);
  });
});

describe("encodeStakeBindBuybackConfig", () => {
  const TOKEN = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const POOL = new PublicKey("So11111111111111111111111111111111111111112");
  const LP_MINT = new PublicKey("DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F");
  const PAIR = new PublicKey("11111111111111111111111111111111");
  const AMM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  const SHA = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

  function bind(sha: Uint8Array = SHA): Uint8Array {
    return encodeStakeBindBuybackConfig({
      tokenMint: TOKEN,
      pool: POOL,
      lpMint: LP_MINT,
      pairMint: PAIR,
      ammProgramId: AMM,
      ammProgramDataSha256: sha,
    });
  }

  it("emits tag(1) + 5 pubkeys(32) + sha256(32) = 193 bytes", () => {
    const bytes = bind();
    expect(bytes.length).toBe(193);
    expect(bytes[0]).toBe(STAKE_IX_BUYBACK.BindBuybackConfig);
  });

  it("lays the five pubkeys out in declaration order", () => {
    const bytes = bind();
    expect(Array.from(bytes.slice(1, 33))).toEqual(Array.from(TOKEN.toBytes()));
    expect(Array.from(bytes.slice(33, 65))).toEqual(Array.from(POOL.toBytes()));
    expect(Array.from(bytes.slice(65, 97))).toEqual(Array.from(LP_MINT.toBytes()));
    expect(Array.from(bytes.slice(97, 129))).toEqual(Array.from(PAIR.toBytes()));
    expect(Array.from(bytes.slice(129, 161))).toEqual(Array.from(AMM.toBytes()));
  });

  it("appends the 32-byte sha256 last", () => {
    const bytes = bind();
    expect(Array.from(bytes.slice(161, 193))).toEqual(Array.from(SHA));
  });

  it("accepts base58-string pubkeys identically to PublicKey instances", () => {
    const fromStrings = encodeStakeBindBuybackConfig({
      tokenMint: TOKEN.toBase58(),
      pool: POOL.toBase58(),
      lpMint: LP_MINT.toBase58(),
      pairMint: PAIR.toBase58(),
      ammProgramId: AMM.toBase58(),
      ammProgramDataSha256: SHA,
    });
    expect(Array.from(fromStrings)).toEqual(Array.from(bind()));
  });

  it("rejects a sha256 that is not exactly 32 bytes", () => {
    expect(() => bind(new Uint8Array(31))).toThrow(/must be 32 bytes/);
    expect(() => bind(new Uint8Array(33))).toThrow(/must be 32 bytes/);
  });
});

describe("encodeStakeTriggerBuyback", () => {
  it("emits a single-byte tag with no payload", () => {
    const bytes = encodeStakeTriggerBuyback();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(1);
    expect(bytes[0]).toBe(STAKE_IX_BUYBACK.TriggerBuyback);
  });

  it("ignores any args object passed in", () => {
    const bytes = encodeStakeTriggerBuyback({});
    expect(bytes.length).toBe(1);
    expect(bytes[0]).toBe(STAKE_IX_BUYBACK.TriggerBuyback);
  });
});

describe("encodeStakeSettleBuyback", () => {
  it("emits tag(1) + roundTripId u64 LE(8) = 9 bytes total", () => {
    const bytes = encodeStakeSettleBuyback({ roundTripId: 0n });
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(STAKE_IX_BUYBACK.SettleBuyback);
  });

  it("encodes roundTripId 0 as 8 zero bytes after the tag", () => {
    const bytes = encodeStakeSettleBuyback({ roundTripId: 0n });
    expect(Array.from(bytes.slice(1))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("encodes roundTripId 1 as 0x01 0x00 0x00 0x00 0x00 0x00 0x00 0x00 (LE)", () => {
    const bytes = encodeStakeSettleBuyback({ roundTripId: 1n });
    expect(Array.from(bytes.slice(1))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("encodes roundTripId u64::MAX as 8 0xFF bytes", () => {
    const bytes = encodeStakeSettleBuyback({
      roundTripId: 0xffff_ffff_ffff_ffffn,
    });
    expect(Array.from(bytes.slice(1))).toEqual([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it("accepts decimal-string input identically to bigint", () => {
    const fromBigint = encodeStakeSettleBuyback({
      roundTripId: 12345n,
    });
    const fromString = encodeStakeSettleBuyback({
      roundTripId: "12345",
    });
    expect(Array.from(fromString)).toEqual(Array.from(fromBigint));
  });

  it("rejects negative roundTripId via the encU64 contract", () => {
    expect(() =>
      encodeStakeSettleBuyback({ roundTripId: -1n }),
    ).toThrow(/non-negative/);
  });

  it("rejects values exceeding u64::MAX via the encU64 contract", () => {
    expect(() =>
      encodeStakeSettleBuyback({
        roundTripId: 0x1_0000_0000_0000_0000n,
      }),
    ).toThrow(/u64 max/);
  });
});

describe("encodeStakeEmergencyDrainTreasury", () => {
  it("emits a single-byte tag with no payload", () => {
    const bytes = encodeStakeEmergencyDrainTreasury();
    expect(bytes.length).toBe(1);
    expect(bytes[0]).toBe(STAKE_IX_BUYBACK.EmergencyDrainTreasury);
  });
});

describe("deriveBuybackState", () => {
  it("returns a [PublicKey, bump] pair", () => {
    const [pda, bump] = deriveBuybackState(FIXED_POOL, FIXED_PROGRAM_ID);
    expect(pda).toBeInstanceOf(PublicKey);
    expect(typeof bump).toBe("number");
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  it("is deterministic for fixed inputs", () => {
    const a = deriveBuybackState(FIXED_POOL, FIXED_PROGRAM_ID);
    const b = deriveBuybackState(FIXED_POOL, FIXED_PROGRAM_ID);
    expect(a[0].toBase58()).toBe(b[0].toBase58());
    expect(a[1]).toBe(b[1]);
  });

  it("uses the literal seed string 'buyback_state'", () => {
    // Cross-check by re-deriving manually with the same seeds we
    // expect the destination Rust to use. Any divergence would mean
    // the staged TS produces a different PDA than the on-chain Rust.
    const TEXT = new TextEncoder();
    const expected = PublicKey.findProgramAddressSync(
      [TEXT.encode("buyback_state"), FIXED_POOL.toBytes()],
      FIXED_PROGRAM_ID,
    );
    const actual = deriveBuybackState(FIXED_POOL, FIXED_PROGRAM_ID);
    expect(actual[0].toBase58()).toBe(expected[0].toBase58());
    expect(actual[1]).toBe(expected[1]);
  });

  it("differs from deriveBuybackTreasury for the same pool — distinct seed strings", () => {
    const stateAddr = deriveBuybackState(FIXED_POOL, FIXED_PROGRAM_ID);
    const treasuryAddr = deriveBuybackTreasury(FIXED_POOL, FIXED_PROGRAM_ID);
    expect(stateAddr[0].toBase58()).not.toBe(treasuryAddr[0].toBase58());
  });
});

describe("deriveBuybackTreasury", () => {
  it("returns a [PublicKey, bump] pair", () => {
    const [pda, bump] = deriveBuybackTreasury(FIXED_POOL, FIXED_PROGRAM_ID);
    expect(pda).toBeInstanceOf(PublicKey);
    expect(typeof bump).toBe("number");
  });

  it("uses the literal seed string 'buyback_treasury'", () => {
    const TEXT = new TextEncoder();
    const expected = PublicKey.findProgramAddressSync(
      [TEXT.encode("buyback_treasury"), FIXED_POOL.toBytes()],
      FIXED_PROGRAM_ID,
    );
    const actual = deriveBuybackTreasury(FIXED_POOL, FIXED_PROGRAM_ID);
    expect(actual[0].toBase58()).toBe(expected[0].toBase58());
    expect(actual[1]).toBe(expected[1]);
  });
});

describe("deriveBuybackConfig", () => {
  it("returns a [PublicKey, bump] pair", () => {
    const [pda, bump] = deriveBuybackConfig(FIXED_POOL, FIXED_PROGRAM_ID);
    expect(pda).toBeInstanceOf(PublicKey);
    expect(typeof bump).toBe("number");
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  it("uses the literal seed string 'buyback_config'", () => {
    const TEXT = new TextEncoder();
    const expected = PublicKey.findProgramAddressSync(
      [TEXT.encode("buyback_config"), FIXED_POOL.toBytes()],
      FIXED_PROGRAM_ID,
    );
    const actual = deriveBuybackConfig(FIXED_POOL, FIXED_PROGRAM_ID);
    expect(actual[0].toBase58()).toBe(expected[0].toBase58());
    expect(actual[1]).toBe(expected[1]);
  });

  it("differs from the state and pool PDAs for the same pool", () => {
    const cfg = deriveBuybackConfig(FIXED_POOL, FIXED_PROGRAM_ID)[0].toBase58();
    const state = deriveBuybackState(FIXED_POOL, FIXED_PROGRAM_ID)[0].toBase58();
    const treasury = deriveBuybackTreasury(FIXED_POOL, FIXED_PROGRAM_ID)[0].toBase58();
    expect(cfg).not.toBe(state);
    expect(cfg).not.toBe(treasury);
  });
});

describe("decodeBuybackConfig", () => {
  const TOKEN = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const POOL = new PublicKey("So11111111111111111111111111111111111111112");
  const LP_MINT = new PublicKey("DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F");
  const PAIR = new PublicKey("11111111111111111111111111111111");
  const AMM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  const SHA = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

  // Build a config data section independently of the encoder.
  function configData(): Uint8Array {
    const out = new Uint8Array(BUYBACK_CONFIG_BYTE_LENGTH);
    out.set(TOKEN.toBytes(), 0);
    out.set(POOL.toBytes(), 32);
    out.set(LP_MINT.toBytes(), 64);
    out.set(PAIR.toBytes(), 96);
    out.set(AMM.toBytes(), 128);
    out.set(SHA, 160);
    return out;
  }

  it("is 192 bytes (six 32-byte fields)", () => {
    expect(BUYBACK_CONFIG_BYTE_LENGTH).toBe(192);
  });

  it("round-trips all six binding fields in declaration order", () => {
    const cfg = decodeBuybackConfig(configData());
    expect(cfg.tokenMint.toBase58()).toBe(TOKEN.toBase58());
    expect(cfg.pool.toBase58()).toBe(POOL.toBase58());
    expect(cfg.lpMint.toBase58()).toBe(LP_MINT.toBase58());
    expect(cfg.pairMint.toBase58()).toBe(PAIR.toBase58());
    expect(cfg.ammProgramId.toBase58()).toBe(AMM.toBase58());
    expect(Array.from(cfg.ammProgramDataSha256)).toEqual(Array.from(SHA));
  });

  it("rejects data that is not exactly 192 bytes", () => {
    expect(() => decodeBuybackConfig(new Uint8Array(191))).toThrow(/exactly 192 bytes/);
    expect(() => decodeBuybackConfig(new Uint8Array(193))).toThrow(/exactly 192 bytes/);
  });

  it("decodes correctly from a non-zero-byteOffset view", () => {
    const PREFIX = 7;
    const payload = configData();
    const backing = new Uint8Array(PREFIX + payload.length + PREFIX);
    backing.fill(0xff);
    backing.set(payload, PREFIX);
    const view = backing.subarray(PREFIX, PREFIX + payload.length);
    expect(view.byteOffset).toBe(PREFIX);

    const cfg = decodeBuybackConfig(view);
    expect(cfg.tokenMint.toBase58()).toBe(TOKEN.toBase58());
    expect(cfg.ammProgramId.toBase58()).toBe(AMM.toBase58());
    expect(Array.from(cfg.ammProgramDataSha256)).toEqual(Array.from(SHA));
  });
});

describe("decodeBuybackConfigAccount (full 264-byte account)", () => {
  const TOKEN = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const POOL = new PublicKey("So11111111111111111111111111111111111111112");
  const LP_MINT = new PublicKey("DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F");
  const PAIR = new PublicKey("11111111111111111111111111111111");
  const AMM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  const SHA = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

  // Build a full account: 8-byte header, binding [8..200], _reserved [200..264]
  // with the discriminator at [200..208] and version at [208].
  function accountData(
    opts: { initialized?: boolean; goodDisc?: boolean } = {},
  ): Uint8Array {
    const { initialized = true, goodDisc = true } = opts;
    const out = new Uint8Array(BUYBACK_CONFIG_ACCOUNT_SIZE);
    if (initialized) out[0] = 1; // is_initialized
    out[1] = 254; // bump
    out.set(TOKEN.toBytes(), BUYBACK_CONFIG_HEADER_LEN + 0);
    out.set(POOL.toBytes(), BUYBACK_CONFIG_HEADER_LEN + 32);
    out.set(LP_MINT.toBytes(), BUYBACK_CONFIG_HEADER_LEN + 64);
    out.set(PAIR.toBytes(), BUYBACK_CONFIG_HEADER_LEN + 96);
    out.set(AMM.toBytes(), BUYBACK_CONFIG_HEADER_LEN + 128);
    out.set(SHA, BUYBACK_CONFIG_HEADER_LEN + 160);
    if (goodDisc) out.set(BUYBACK_CONFIG_DISCRIMINATOR, 200);
    out[208] = 1; // version
    return out;
  }

  it("decodes the binding from a valid full account", () => {
    const cfg = decodeBuybackConfigAccount(accountData());
    if (cfg === null) throw new Error("expected a decoded config");
    expect(cfg.tokenMint.toBase58()).toBe(TOKEN.toBase58());
    expect(cfg.pool.toBase58()).toBe(POOL.toBase58());
    expect(cfg.lpMint.toBase58()).toBe(LP_MINT.toBase58());
    expect(cfg.pairMint.toBase58()).toBe(PAIR.toBase58());
    expect(cfg.ammProgramId.toBase58()).toBe(AMM.toBase58());
    expect(Array.from(cfg.ammProgramDataSha256)).toEqual(Array.from(SHA));
  });

  it("returns null for a zeroed (unbound) account", () => {
    expect(
      decodeBuybackConfigAccount(new Uint8Array(BUYBACK_CONFIG_ACCOUNT_SIZE)),
    ).toBeNull();
  });

  it("returns null when is_initialized != 1", () => {
    expect(decodeBuybackConfigAccount(accountData({ initialized: false }))).toBeNull();
  });

  it("returns null on a discriminator mismatch (wrong-type hardening)", () => {
    expect(decodeBuybackConfigAccount(accountData({ goodDisc: false }))).toBeNull();
  });

  it("returns null on the wrong account size", () => {
    expect(decodeBuybackConfigAccount(new Uint8Array(263))).toBeNull();
    expect(decodeBuybackConfigAccount(new Uint8Array(265))).toBeNull();
  });

  it("pins the documented header length and account size", () => {
    expect(BUYBACK_CONFIG_HEADER_LEN).toBe(8);
    expect(BUYBACK_CONFIG_ACCOUNT_SIZE).toBe(264);
  });
});
