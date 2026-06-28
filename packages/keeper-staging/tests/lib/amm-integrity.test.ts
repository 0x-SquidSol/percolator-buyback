/**
 * Verification-only test suite for `lib/amm-integrity.ts`. Proves the
 * ProgramData-address derivation and the hash-drift classification
 * (intact / drifted / missing / rpc-error) against a mocked Connection.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  BPF_UPGRADEABLE_LOADER_ID,
  deriveProgramDataAddress,
  checkAmmIntegrity,
} from "../../src/lib/amm-integrity.js";

const AMM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** Minimal Connection stub exposing only `getAccountInfo`. */
function mockConn(
  getAccountInfo: (addr: PublicKey) => unknown,
): Connection {
  return {
    getAccountInfo: async (addr: PublicKey) => getAccountInfo(addr),
  } as unknown as Connection;
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(Buffer.from(data)).digest();
}

// A stand-in ProgramData account: the leading 3 is the upgradeable-loader
// ProgramData enum discriminant, then arbitrary "ELF" bytes.
const PROGRAM_DATA = Buffer.from([3, 0, 0, 0, 1, 2, 3, 4, 5]);
const PIN = new Uint8Array(sha256(PROGRAM_DATA));

describe("deriveProgramDataAddress", () => {
  it("is the BPF upgradeable loader PDA `[program_id]`", () => {
    const expected = PublicKey.findProgramAddressSync(
      [AMM.toBytes()],
      BPF_UPGRADEABLE_LOADER_ID,
    )[0];
    expect(deriveProgramDataAddress(AMM).toBase58()).toBe(expected.toBase58());
  });

  it("is deterministic", () => {
    expect(deriveProgramDataAddress(AMM).toBase58()).toBe(
      deriveProgramDataAddress(AMM).toBase58(),
    );
  });
});

describe("checkAmmIntegrity", () => {
  it("returns intact when the live hash matches the pin", async () => {
    const conn = mockConn(() => ({ data: PROGRAM_DATA }));
    expect(await checkAmmIntegrity(conn, AMM, PIN)).toEqual({ status: "intact" });
  });

  it("returns drifted with hex observed/pinned when the binary changed", async () => {
    const upgraded = Buffer.from([3, 0, 0, 0, 9, 9, 9]);
    const conn = mockConn(() => ({ data: upgraded }));
    const result = await checkAmmIntegrity(conn, AMM, PIN);
    expect(result.status).toBe("drifted");
    if (result.status === "drifted") {
      expect(result.observed).toBe(sha256(upgraded).toString("hex"));
      expect(result.pinned).toBe(Buffer.from(PIN).toString("hex"));
    }
  });

  it("returns missing when the ProgramData account is absent", async () => {
    const conn = mockConn(() => null);
    expect(await checkAmmIntegrity(conn, AMM, PIN)).toEqual({ status: "missing" });
  });

  it("returns rpc-error when the fetch throws", async () => {
    const conn = mockConn(() => {
      throw new Error("connection reset");
    });
    const result = await checkAmmIntegrity(conn, AMM, PIN);
    expect(result.status).toBe("rpc-error");
    if (result.status === "rpc-error") {
      expect(result.error).toMatch(/connection reset/);
    }
  });

  it("queries the derived ProgramData address, not the program id", async () => {
    const seen: string[] = [];
    const conn = mockConn((addr) => {
      seen.push(addr.toBase58());
      return { data: PROGRAM_DATA };
    });
    await checkAmmIntegrity(conn, AMM, PIN);
    expect(seen).toEqual([deriveProgramDataAddress(AMM).toBase58()]);
  });

  it("throws on a pin that is not 32 bytes (API misuse)", async () => {
    const conn = mockConn(() => ({ data: PROGRAM_DATA }));
    await expect(
      checkAmmIntegrity(conn, AMM, new Uint8Array(31)),
    ).rejects.toThrow(/32 bytes/);
  });
});
