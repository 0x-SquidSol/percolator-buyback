/**
 * Verification-only test suite for `lib/round-trip.ts`. Proves the
 * round-trip state machine sequences the legs correctly and rejects
 * out-of-order / repeated completions (the resume-after-crash guard).
 */
import { describe, it, expect } from "vitest";
import {
  ROUND_TRIP_STAGES,
  newRoundTrip,
  isComplete,
  pendingLeg,
  completeLeg,
  type RoundTripLeg,
  type RoundTripState,
} from "../../src/lib/round-trip.js";

const ID = "42";
const MARKET = "11111111111111111111111111111111";

/** Drive a round-trip to completion through its pending legs, asserting each step. */
function runToSettled(needsConvert: boolean): RoundTripLeg[] {
  let state = newRoundTrip(ID, MARKET, needsConvert);
  const legs: RoundTripLeg[] = [];
  while (!isComplete(state)) {
    const leg = pendingLeg(state);
    expect(leg).not.toBeNull();
    legs.push(leg as RoundTripLeg);
    state = completeLeg(state, leg as RoundTripLeg);
  }
  expect(pendingLeg(state)).toBeNull();
  return legs;
}

describe("newRoundTrip", () => {
  it("starts at the 'triggered' stage with the given identity", () => {
    const s = newRoundTrip(ID, MARKET, true);
    expect(s.stage).toBe("triggered");
    expect(s.roundTripId).toBe(ID);
    expect(s.market).toBe(MARKET);
    expect(s.needsConvert).toBe(true);
    expect(isComplete(s)).toBe(false);
  });
});

describe("ROUND_TRIP_STAGES", () => {
  it("lists the six stages in order", () => {
    expect(ROUND_TRIP_STAGES).toEqual([
      "triggered",
      "converted",
      "bought",
      "liquidity_added",
      "lp_burned",
      "settled",
    ]);
  });
});

describe("pendingLeg", () => {
  it("dispatches 'triggered' to convert or buy by needsConvert", () => {
    expect(pendingLeg(newRoundTrip(ID, MARKET, true))).toBe("convert");
    expect(pendingLeg(newRoundTrip(ID, MARKET, false))).toBe("buy");
  });

  it("maps each non-terminal stage to its single next leg", () => {
    const at = (stage: RoundTripState["stage"]): RoundTripState => ({
      roundTripId: ID,
      market: MARKET,
      stage,
      needsConvert: true,
    });
    expect(pendingLeg(at("converted"))).toBe("buy");
    expect(pendingLeg(at("bought"))).toBe("add_liquidity");
    expect(pendingLeg(at("liquidity_added"))).toBe("burn_lp");
    expect(pendingLeg(at("lp_burned"))).toBe("settle");
  });

  it("returns null at the terminal 'settled' stage", () => {
    const settled: RoundTripState = {
      roundTripId: ID,
      market: MARKET,
      stage: "settled",
      needsConvert: true,
    };
    expect(pendingLeg(settled)).toBeNull();
    expect(isComplete(settled)).toBe(true);
  });
});

describe("completeLeg — forward sequences", () => {
  it("runs the full sequence WITH a convert leg", () => {
    expect(runToSettled(true)).toEqual([
      "convert",
      "buy",
      "add_liquidity",
      "burn_lp",
      "settle",
    ]);
  });

  it("runs the full sequence WITHOUT a convert leg (collateral-paired pool)", () => {
    expect(runToSettled(false)).toEqual([
      "buy",
      "add_liquidity",
      "burn_lp",
      "settle",
    ]);
  });

  it("advances exactly one stage per leg and never mutates the input", () => {
    const triggered = newRoundTrip(ID, MARKET, false);
    const bought = completeLeg(triggered, "buy");
    expect(bought.stage).toBe("bought");
    expect(triggered.stage).toBe("triggered"); // input untouched
    expect(bought).not.toBe(triggered);
  });
});

describe("completeLeg — idempotency guard", () => {
  it("rejects an out-of-order leg (skipping convert when it is required)", () => {
    const triggered = newRoundTrip(ID, MARKET, true); // pending = convert
    expect(() => completeLeg(triggered, "buy")).toThrow(
      /expects leg "convert", got "buy"/,
    );
  });

  it("rejects re-completing an already-done leg (resume-after-crash hazard)", () => {
    const triggered = newRoundTrip(ID, MARKET, false);
    const bought = completeLeg(triggered, "buy");
    // Re-running the buy leg from the persisted 'bought' stage must fail.
    expect(() => completeLeg(bought, "buy")).toThrow(
      /expects leg "add_liquidity", got "buy"/,
    );
  });

  it("rejects any leg once settled (terminal)", () => {
    let state = newRoundTrip(ID, MARKET, false);
    for (const leg of ["buy", "add_liquidity", "burn_lp", "settle"] as const) {
      state = completeLeg(state, leg);
    }
    expect(isComplete(state)).toBe(true);
    expect(() => completeLeg(state, "settle")).toThrow(/already settled/);
  });
});
