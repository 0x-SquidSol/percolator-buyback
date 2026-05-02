import { describe, it, expect, vi } from "vitest";
import { log, type Logger, type BuybackLogFields } from "../../src/lib/log.js";

describe("log", () => {
  it("exposes the Logger interface (info/warn/error)", () => {
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  it("forwards info to the underlying console", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      log.info("hello", { outcome: "would-fire" });
      expect(spy).toHaveBeenCalledWith("hello", {
        outcome: "would-fire",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("forwards warn to the underlying console", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      log.warn("careful", { outcome: "rpc-error" });
      expect(spy).toHaveBeenCalledWith("careful", {
        outcome: "rpc-error",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("forwards error to the underlying console", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      log.error("boom", { slab: "ExamplePubkey" });
      expect(spy).toHaveBeenCalledWith("boom", { slab: "ExamplePubkey" });
    } finally {
      spy.mockRestore();
    }
  });

  it("forwards a bare message with no fields", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      log.info("starting");
      expect(spy).toHaveBeenCalledWith("starting");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("BuybackLogFields type contract", () => {
  it("accepts the documented outcome values without a type error", () => {
    // Compile-time pin: each outcome string the service will emit must be
    // a member of the BuybackLogFields union. Adding a new outcome here
    // forces a corresponding spec update in src/lib/log.ts.
    const wouldFire: BuybackLogFields = { outcome: "would-fire" };
    const blocked: BuybackLogFields = { outcome: "blocked" };
    const rpcError: BuybackLogFields = { outcome: "rpc-error" };
    const notLive: BuybackLogFields = { outcome: "not-live" };
    expect([wouldFire, blocked, rpcError, notLive]).toHaveLength(4);
  });

  it("Logger interface is structurally satisfied by console", () => {
    // Compile-time pin: console must remain assignable to Logger so the
    // staging-time `export const log: Logger = console` keeps working.
    const asLogger: Logger = console;
    expect(asLogger).toBe(console);
  });
});
