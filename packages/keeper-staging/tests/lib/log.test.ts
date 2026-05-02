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

  it("rejects object-shaped values via the tightened index signature", () => {
    // Compile-time pin: the index signature accepts only primitives,
    // so accidental object logging — `{ keypair }`, `{ ...rpcConfig }`,
    // `{ connection }` — fails at staging-time `pnpm lint`. Each
    // ts-expect-error below MUST stay an error; if any starts passing,
    // the index signature has been widened and the secret-leak class
    // is back open.
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      // @ts-expect-error — object value on an ad-hoc field is rejected
      log.info("nope", { keypair: { secret: "leak" } });
      // @ts-expect-error — array value on an ad-hoc field is rejected
      log.info("nope", { signers: ["a", "b"] });
      // @ts-expect-error — Symbol value is rejected
      log.info("nope", { sym: Symbol("x") });
      // Primitives DO pass — these lines must NOT have ts-expect-error.
      log.info("ok", { txid: "5xKj..." });
      log.info("ok", { attempt: 3 });
      log.info("ok", { lamports: 5000n });
      log.info("ok", { dryRun: true });
      log.info("ok", { lastSeen: null });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
