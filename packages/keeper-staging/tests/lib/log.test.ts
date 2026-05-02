import { describe, it, expect, vi } from "vitest";
import { log } from "../../src/lib/log.js";

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
  it("accepts the four documented outcome values via contextual typing", () => {
    // Compile-time pin: each outcome string the service will emit must
    // be a member of the BuybackLogFields union. The test exercises the
    // union via log.info's contextual type rather than a named import,
    // matching the un-exported BuybackLogFields convention. Adding a
    // new outcome here forces a corresponding spec update in
    // src/lib/log.ts; passing an unknown string would fail tsc on the
    // staging-time `pnpm lint` pass.
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      log.info("test", { outcome: "would-fire" });
      log.info("test", { outcome: "blocked" });
      log.info("test", { outcome: "rpc-error" });
      log.info("test", { outcome: "not-live" });
      expect(spy).toHaveBeenCalledTimes(4);
    } finally {
      spy.mockRestore();
    }
  });
});
