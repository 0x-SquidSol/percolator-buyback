/**
 * Verification-only test suite for `lib/amm-integrity.ts`. Proves the
 * ProgramData-address derivation and the account classification
 * (intact / drifted / wrong-owner / malformed / missing / rpc-error) against a
 * mocked Connection, plus the default read commitment.
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
const OTHER_OWNER = PublicKey.default; // System Program — not the loader

/** A loader ProgramData account: discriminant 3 (u32 LE) + 41-byte metadata + "ELF". */
function programData(elf: number[]): Buffer {
  return Buffer.concat([
    Buffer.from([3, 0, 0, 0]), // ProgramData discriminant
    Buffer.alloc(41, 0), // slot(8) + option(1) + authority(32)
    Buffer.from(elf),
  ]);
}

/** Build a fetched-account stub; owner defaults to the upgradeable loader. */
function loaderAccount(
  data: Buffer,
  owner: PublicKey = BPF_UPGRADEABLE_LOADER_ID,
): unknown {
  return { data, owner, lamports: 1, executable: false, rentEpoch: 0 };
}

/** Minimal Connection stub exposing only `getAccountInfo`, capturing its args. */
function mockConn(
  get: (addr: PublicKey, commitment?: unknown) => unknown,
): Connection {
  return {
    getAccountInfo: async (addr: PublicKey, commitment?: unknown) =>
      get(addr, commitment),
  } as unknown as Connection;
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(Buffer.from(data)).digest();
}

const PROGRAM_DATA = programData([1, 2, 3, 4, 5]);
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
    const conn = mockConn(() => loaderAccount(PROGRAM_DATA));
    expect(await checkAmmIntegrity(conn, AMM, PIN)).toEqual({ status: "intact" });
  });

  it("returns drifted with hex observed/pinned when the binary changed", async () => {
    const upgraded = programData([9, 9, 9]);
    const conn = mockConn(() => loaderAccount(upgraded));
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

  it("returns wrong-owner when the account is not loader-owned", async () => {
    const conn = mockConn(() => loaderAccount(PROGRAM_DATA, OTHER_OWNER));
    const result = await checkAmmIntegrity(conn, AMM, PIN);
    expect(result.status).toBe("wrong-owner");
    if (result.status === "wrong-owner") {
      expect(result.owner).toBe(OTHER_OWNER.toBase58());
    }
  });

  it("returns malformed for a loader account too short to classify", async () => {
    const conn = mockConn(() => loaderAccount(Buffer.alloc(0)));
    const result = await checkAmmIntegrity(conn, AMM, PIN);
    expect(result.status).toBe("malformed");
    if (result.status === "malformed") {
      expect(result.detail).toMatch(/0 bytes/);
    }
  });

  it("returns malformed for a loader account of the wrong variant", async () => {
    // Discriminant 1 = Buffer variant (a write buffer), not ProgramData.
    const bufferVariant = Buffer.concat([
      Buffer.from([1, 0, 0, 0]),
      Buffer.alloc(40, 0),
    ]);
    const conn = mockConn(() => loaderAccount(bufferVariant));
    const result = await checkAmmIntegrity(conn, AMM, PIN);
    expect(result.status).toBe("malformed");
    if (result.status === "malformed") {
      expect(result.detail).toMatch(/variant 1/);
    }
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
      return loaderAccount(PROGRAM_DATA);
    });
    await checkAmmIntegrity(conn, AMM, PIN);
    expect(seen).toEqual([deriveProgramDataAddress(AMM).toBase58()]);
  });

  it("reads at confirmed by default and forwards an explicit commitment", async () => {
    const seen: unknown[] = [];
    const conn = mockConn((_addr, commitment) => {
      seen.push(commitment);
      return loaderAccount(PROGRAM_DATA);
    });
    await checkAmmIntegrity(conn, AMM, PIN);
    await checkAmmIntegrity(conn, AMM, PIN, "finalized");
    expect(seen).toEqual(["confirmed", "finalized"]);
  });

  it("throws on a pin that is not 32 bytes (API misuse)", async () => {
    const conn = mockConn(() => loaderAccount(PROGRAM_DATA));
    await expect(
      checkAmmIntegrity(conn, AMM, new Uint8Array(31)),
    ).rejects.toThrow(/32 bytes/);
  });
});
