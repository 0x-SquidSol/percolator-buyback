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
  it("exposes the five current variants in declaration order", () => {
    // Order MUST match the BuybackBlocker enum in
    // crates/buyback-staging/src/buyback.rs. A diff here means the Rust
    // enum was reordered or extended without a corresponding TS update —
    // break the build until reconciled.
    expect(Object.entries(BUYBACK_BLOCKER)).toEqual([
      ["CooldownActive", 0],
      ["BelowInsuranceFloor", 1],
      ["HaircutsActive", 2],
      ["RatioBelowThreshold", 3],
      ["MathOverflow", 4],
    ]);
  });

  it("freezes the enum to prevent runtime mutation", () => {
    expect(Object.isFrozen(BUYBACK_BLOCKER)).toBe(true);
  });
});

describe("parseBuybackBlockerName", () => {
  it("returns the variant name for each in-range code", () => {
    expect(parseBuybackBlockerName(0)).toBe("CooldownActive");
    expect(parseBuybackBlockerName(1)).toBe("BelowInsuranceFloor");
    expect(parseBuybackBlockerName(2)).toBe("HaircutsActive");
    expect(parseBuybackBlockerName(3)).toBe("RatioBelowThreshold");
    expect(parseBuybackBlockerName(4)).toBe("MathOverflow");
  });

  it("returns null for codes outside the known range", () => {
    expect(parseBuybackBlockerName(5)).toBeNull();
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
    expect(buybackBlockerCode("BelowInsuranceFloor")).toBe(1);
    expect(buybackBlockerCode("HaircutsActive")).toBe(2);
    expect(buybackBlockerCode("RatioBelowThreshold")).toBe(3);
    expect(buybackBlockerCode("MathOverflow")).toBe(4);
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
