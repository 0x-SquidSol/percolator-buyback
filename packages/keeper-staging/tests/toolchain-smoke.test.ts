import { describe, it, expect } from "vitest";

// Toolchain smoke test — confirms vitest finds the tests/ directory,
// tsc typechecks against the strict config, and the staging package
// installs cleanly. Replace or remove once the first real service
// test lands.
describe("keeper-staging toolchain", () => {
  it("compiles and runs a vitest test", () => {
    expect(1n + 1n).toBe(2n);
  });
});
