import { describe, it, expect } from "vitest";
import {
  BUYBACK_BLOCKER,
  parseBuybackBlockerName,
  buybackBlockerCode,
} from "./buyback.js";

describe("BUYBACK_BLOCKER", () => {
  it("exposes the six current variants in declaration order", () => {
    // Order MUST match crates/buyback-staging/src/buyback.rs:88-114.
    // A diff here means the Rust enum was reordered or extended without
    // a corresponding TS update — break the build until reconciled.
    expect(Object.entries(BUYBACK_BLOCKER)).toEqual([
      ["MultiMarketRequiresGlobalAggregation", 0],
      ["CooldownActive", 1],
      ["BelowInsuranceFloor", 2],
      ["HaircutsActive", 3],
      ["RatioBelowThreshold", 4],
      ["MathOverflow", 5],
    ]);
  });

  it("freezes the enum to prevent runtime mutation", () => {
    expect(Object.isFrozen(BUYBACK_BLOCKER)).toBe(true);
  });
});

describe("parseBuybackBlockerName", () => {
  it("returns the variant name for each in-range code", () => {
    expect(parseBuybackBlockerName(0)).toBe(
      "MultiMarketRequiresGlobalAggregation",
    );
    expect(parseBuybackBlockerName(1)).toBe("CooldownActive");
    expect(parseBuybackBlockerName(2)).toBe("BelowInsuranceFloor");
    expect(parseBuybackBlockerName(3)).toBe("HaircutsActive");
    expect(parseBuybackBlockerName(4)).toBe("RatioBelowThreshold");
    expect(parseBuybackBlockerName(5)).toBe("MathOverflow");
  });

  it("returns null for codes outside the known range", () => {
    expect(parseBuybackBlockerName(6)).toBeNull();
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
    expect(buybackBlockerCode("MultiMarketRequiresGlobalAggregation")).toBe(0);
    expect(buybackBlockerCode("CooldownActive")).toBe(1);
    expect(buybackBlockerCode("BelowInsuranceFloor")).toBe(2);
    expect(buybackBlockerCode("HaircutsActive")).toBe(3);
    expect(buybackBlockerCode("RatioBelowThreshold")).toBe(4);
    expect(buybackBlockerCode("MathOverflow")).toBe(5);
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
