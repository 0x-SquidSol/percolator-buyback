/**
 * Verification-only test suite for `src/services/buyback.ts`.
 *
 * **Does NOT transfer.** The destination keeper ships its own tests
 * against its own RPC-mock and env-guard fixtures; staging tests
 * dangle on the `import { probeEligibility } from "../../src/..."`
 * reference once the staged source is dropped at transfer per the
 * source file's own header. Same precedent as `lib/log.test.ts`.
 *
 * The probe's classifier (`classifySim`) is exercised here through
 * the public `probeEligibility` entry point with a mocked
 * `connection.simulateTransaction`. The four outcome paths
 * (`would-fire`, `blocked`, `rpc-error`, `not-live`) match the
 * `BuybackLogFields.outcome` literal union in `src/lib/log.ts`,
 * which is the byte-identical shape the destination's downstream
 * log consumers (Sentry tags, Discord alerts) expect.
 */
import { describe, it, expect, vi } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { probeEligibility } from "../../src/services/buyback.js";

// Any valid base58 pubkey works; SOL native mint is convenient and
// readable in failure output.
const SLAB = new PublicKey("So11111111111111111111111111111111111111112");
const PAYER = PublicKey.default;
// Any valid program id works — the probe's account list is mocked away by the
// simulateTransaction stub, so this only needs to be a valid pubkey. The
// percolator-stake mainnet id keeps the PDA derivations realistic.
const STAKE_PROGRAM_ID = new PublicKey(
  "DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F",
);

/**
 * Build a `Connection`-shaped object whose only used method is
 * `simulateTransaction`. Anything else the probe touches would surface
 * as a runtime TypeError in tests, which is the desired tripwire — if
 * a future probe revision starts calling other RPC methods, the
 * mock-shape mismatch fails the test rather than silently skipping
 * coverage.
 */
function mockConnection(value: unknown): Connection {
  return {
    simulateTransaction: vi.fn().mockResolvedValue({ value }),
  } as unknown as Connection;
}

describe("probeEligibility", () => {
  it("classifies err: null as would-fire and logs at info", async () => {
    const conn = mockConnection({ err: null, logs: [] });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const result = await probeEligibility(conn, SLAB, PAYER, STAKE_PROGRAM_ID);
      expect(result).toEqual({ outcome: "would-fire", slice: "0" });
      expect(spy).toHaveBeenCalledWith(
        "eligibility probe would-fire",
        expect.objectContaining({
          slab: SLAB.toBase58(),
          outcome: "would-fire",
          slice: "0",
        }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies a native Custom(28) error as blocked (base of the buyback block)", async () => {
    // Custom(28) = BUYBACK_ERROR_BASE + 0 → BuybackBlocker discriminant 0 →
    // "CooldownActive". Read from `err`; logs are empty on purpose to prove the
    // blocker is sourced from the structured error, not scraped from logs.
    const conn = mockConnection({
      err: { InstructionError: [0, { Custom: 28 }] },
      logs: [],
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const result = await probeEligibility(conn, SLAB, PAYER, STAKE_PROGRAM_ID);
      expect(result).toEqual({ outcome: "blocked", blocker: "CooldownActive" });
      expect(spy).toHaveBeenCalledWith(
        "eligibility probe blocked",
        expect.objectContaining({
          outcome: "blocked",
          blocker: "CooldownActive",
        }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies a native Custom(29) error as blocked (base + discriminant)", async () => {
    // Custom(29) = BUYBACK_ERROR_BASE + 1 → BuybackBlocker discriminant 1 →
    // "BelowTreasuryFloor".
    const conn = mockConnection({
      err: { InstructionError: [0, { Custom: 29 }] },
      logs: [],
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const result = await probeEligibility(conn, SLAB, PAYER, STAKE_PROGRAM_ID);
      expect(result).toEqual({
        outcome: "blocked",
        blocker: "BelowTreasuryFloor",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("does NOT classify a non-buyback Custom code as blocked", async () => {
    // Custom(24) is an existing StakeError below the 28..34 buyback block:
    // 24 - 28 = -4 → parseBuybackBlockerName(-4) → null, so it is not a
    // blocker. It is a structured Custom error (not a not-live string tag), so
    // it falls through to rpc-error rather than being mislabeled "blocked".
    const conn = mockConnection({
      err: { InstructionError: [0, { Custom: 24 }] },
      logs: [],
    });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await probeEligibility(conn, SLAB, PAYER, STAKE_PROGRAM_ID);
      expect(result.outcome).toBe("rpc-error");
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies a string-form not-live err as not-live and logs at info", async () => {
    const conn = mockConnection({
      err: "ProgramAccountNotFound",
      logs: [],
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const result = await probeEligibility(conn, SLAB, PAYER, STAKE_PROGRAM_ID);
      expect(result).toEqual({ outcome: "not-live" });
      expect(spy).toHaveBeenCalledWith(
        "eligibility probe not-live",
        expect.objectContaining({ outcome: "not-live" }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies an InstructionError carrying AccountNotFound as not-live", async () => {
    const conn = mockConnection({
      err: { InstructionError: [0, "AccountNotFound"] },
      logs: [],
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const result = await probeEligibility(conn, SLAB, PAYER, STAKE_PROGRAM_ID);
      expect(result).toEqual({ outcome: "not-live" });
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies a thrown simulate failure as rpc-error and logs at warn", async () => {
    const conn = {
      simulateTransaction: vi
        .fn()
        .mockRejectedValue(new Error("connection refused")),
    } as unknown as Connection;
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await probeEligibility(conn, SLAB, PAYER, STAKE_PROGRAM_ID);
      expect(result).toEqual({
        outcome: "rpc-error",
        error: "connection refused",
      });
      expect(spy).toHaveBeenCalledWith(
        "eligibility probe rpc error",
        expect.objectContaining({ outcome: "rpc-error" }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies an unrecognized err shape as rpc-error", async () => {
    const conn = mockConnection({
      err: { SomeFutureVariant: { weird: true } },
      logs: ["Program log: nothing recognizable here"],
    });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await probeEligibility(conn, SLAB, PAYER, STAKE_PROGRAM_ID);
      expect(result.outcome).toBe("rpc-error");
      if (result.outcome === "rpc-error") {
        expect(result.error).toContain("SomeFutureVariant");
      }
    } finally {
      spy.mockRestore();
    }
  });
});
