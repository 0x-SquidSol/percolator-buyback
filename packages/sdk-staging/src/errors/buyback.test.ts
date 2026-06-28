/**
 * Verification-only test suite for `errors/buyback.ts`. **Does NOT
 * transfer** — proves the staged code is correct at the moment of
 * transfer; the destination writes its own tests against its own
 * fixture infrastructure (see `dcccrypto/percolator-sdk/test/`,
 * which is `tsx` + hand-rolled asserts, not vitest). Mirrors the
 * math-crate precedent: staging tests verify the staged source, then
 * stay home. See `INTEGRATION.md` `## dcccrypto/percolator-sdk`.
 */
import { describe, it, expect } from "vitest";
import {
  BUYBACK_BLOCKER,
  parseBuybackBlockerName,
  buybackBlockerCode,
} from "./buyback.js";

describe("BUYBACK_BLOCKER", () => {
  it("exposes the seven current variants in canonical declaration order", () => {
    // Order MUST match the BuybackBlocker enum in
    // crates/buyback-staging/src/buyback.rs (canonical order pinned in
    // PROPOSAL.md §6.1 / INTEGRATION.md). A diff here means the Rust enum
    // and this mirror have diverged — break the build until reconciled.
    expect(Object.entries(BUYBACK_BLOCKER)).toEqual([
      ["CooldownActive", 0],
      ["BelowTreasuryFloor", 1],
      ["HaircutsActive", 2],
      ["AutoPausedUnderStress", 3],
      ["ReserveTopUpPending", 4],
      ["ExposureBelowMinimum", 5],
      ["MathOverflow", 6],
    ]);
  });

  it("freezes the enum to prevent runtime mutation", () => {
    expect(Object.isFrozen(BUYBACK_BLOCKER)).toBe(true);
  });
});

describe("parseBuybackBlockerName", () => {
  it("returns the variant name for each in-range code", () => {
    expect(parseBuybackBlockerName(0)).toBe("CooldownActive");
    expect(parseBuybackBlockerName(1)).toBe("BelowTreasuryFloor");
    expect(parseBuybackBlockerName(2)).toBe("HaircutsActive");
    expect(parseBuybackBlockerName(3)).toBe("AutoPausedUnderStress");
    expect(parseBuybackBlockerName(4)).toBe("ReserveTopUpPending");
    expect(parseBuybackBlockerName(5)).toBe("ExposureBelowMinimum");
    expect(parseBuybackBlockerName(6)).toBe("MathOverflow");
  });

  it("returns null for codes outside the known range", () => {
    expect(parseBuybackBlockerName(7)).toBeNull();
    expect(parseBuybackBlockerName(255)).toBeNull();
    expect(parseBuybackBlockerName(-1)).toBeNull();
  });

  it("returns null for non-integer inputs", () => {
    expect(parseBuybackBlockerName(1.5)).toBeNull();
    expect(parseBuybackBlockerName(NaN)).toBeNull();
    expect(parseBuybackBlockerName(Infinity)).toBeNull();
  });
});

describe("buybackBlockerCode", () => {
  it("returns the discriminant for each known name", () => {
    expect(buybackBlockerCode("CooldownActive")).toBe(0);
    expect(buybackBlockerCode("BelowTreasuryFloor")).toBe(1);
    expect(buybackBlockerCode("HaircutsActive")).toBe(2);
    expect(buybackBlockerCode("AutoPausedUnderStress")).toBe(3);
    expect(buybackBlockerCode("ReserveTopUpPending")).toBe(4);
    expect(buybackBlockerCode("ExposureBelowMinimum")).toBe(5);
    expect(buybackBlockerCode("MathOverflow")).toBe(6);
  });

  it("returns null for unknown names", () => {
    expect(buybackBlockerCode("NotAVariant")).toBeNull();
    expect(buybackBlockerCode("")).toBeNull();
    expect(buybackBlockerCode("cooldownactive")).toBeNull(); // case-sensitive
  });

  it("round-trips through parseBuybackBlockerName", () => {
    for (const [name, code] of Object.entries(BUYBACK_BLOCKER)) {
      expect(buybackBlockerCode(name)).toBe(code);
      expect(parseBuybackBlockerName(code as number)).toBe(name);
    }
  });
});
