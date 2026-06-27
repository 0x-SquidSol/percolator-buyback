/**
 * Verification-only test suite for `solana/constants.ts`. **Does NOT
 * transfer** — proves each hardcoded pubkey (a) parses as valid
 * base58, (b) round-trips through `PublicKey` to its canonical
 * string, and (c) matches the source the constants module's header
 * cites (PROPOSAL §11 for the pool, Solana mainnet well-known
 * registry for the mints). Mirrors the `errors/buyback.test.ts`
 * precedent.
 *
 * The point of pinning the strings here rather than just importing
 * the `PublicKey` instances: a typo introduced when someone edits
 * `constants.ts` would still produce a valid `PublicKey` instance
 * (anything 32 bytes parses), so a string equality check is the
 * load-bearing assertion. The expected strings below MUST match the
 * citations in the source file's header comment one-to-one.
 */
import { describe, it, expect } from "vitest";
import {
  CANONICAL_POOL,
  WSOL_MINT,
  USDC_MINT,
} from "./constants.js";

describe("CANONICAL_POOL", () => {
  it("matches PROPOSAL §11 — re-verified 2026-04-30", () => {
    expect(CANONICAL_POOL.toBase58()).toBe(
      "Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW",
    );
  });
});

describe("WSOL_MINT", () => {
  it("matches the Solana mainnet wrapped-SOL mint", () => {
    expect(WSOL_MINT.toBase58()).toBe(
      "So11111111111111111111111111111111111111112",
    );
  });
});

describe("USDC_MINT", () => {
  it("matches the Solana mainnet USDC mint", () => {
    expect(USDC_MINT.toBase58()).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
  });
});

describe("constants are distinct", () => {
  // Sanity check: a typo that copy-pasted one constant into another
  // slot would fail this check before string-equality asserts above
  // notice anything wrong.
  it("are all unique", () => {
    const all = [
      CANONICAL_POOL.toBase58(),
      WSOL_MINT.toBase58(),
      USDC_MINT.toBase58(),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});
