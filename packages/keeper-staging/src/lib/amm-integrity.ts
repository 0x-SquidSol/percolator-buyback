/**
 * @module lib/amm-integrity
 *
 * AMM-upgrade early-warning for the buyback cranker.
 *
 * The on-chain `settle_buyback` pins the bound AMM's program-data sha256
 * (`BuybackConfig.amm_program_data_sha256`) and fail-closes if it drifts
 * (INTEGRATION.md settle-validation item 11). This helper gives the keeper the
 * SAME signal off-chain so it can disable itself BEFORE a round-trip strands a
 * slice on a settle that is going to reject — a third-party AMM whose upgrade
 * authority is a live key is the design's only unbounded risk surface
 * (PROPOSAL.md §11 "AMM upgrade authority").
 *
 * Mechanism: derive the program's ProgramData account (the BPF upgradeable
 * loader PDA `[program_id]`), fetch it, sha256 its bytes, and compare to the
 * pinned hash. A mismatch means the AMM was redeployed → disable the cranker
 * for that market (fail-closed). An in-house AMM with renounced / multisig
 * upgrade authority removes the surface and this check can be skipped.
 *
 * **Assumption to reconcile with O-S8 (the on-chain sha-pin leg).** The pinned
 * hash is taken to be sha256 over the FULL ProgramData account data (header +
 * ELF), matching what the on-chain settle hashes. If the stake program frames
 * its pin differently (e.g. ELF only, or skipping the deploy-slot header),
 * align the bytes hashed here to match — otherwise the off-chain and on-chain
 * checks can disagree.
 *
 * **Transfer destination:** `dcccrypto/percolator-keeper/src/lib/`. Uses
 * `node:crypto`; the destination may swap to its preferred sha256 util.
 */

import { createHash } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";

/** BPF Upgradeable Loader — owner of every upgradeable program's ProgramData account. */
export const BPF_UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

/**
 * Derive the ProgramData account address for an upgradeable program — the PDA
 * `[program_id]` under the BPF Upgradeable Loader. This is the account whose
 * bytes the sha-pin covers.
 */
export function deriveProgramDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [programId.toBytes()],
    BPF_UPGRADEABLE_LOADER_ID,
  )[0];
}

/**
 * Result of an AMM integrity check.
 *
 *   - `intact`: the live ProgramData hash matches the pin — safe to crank.
 *   - `drifted`: the AMM was redeployed (hash changed) — **disable the cranker
 *     for this market**. `observed` / `pinned` are hex for the operator log.
 *   - `missing`: the ProgramData account is gone — suspicious; disable.
 *   - `rpc-error`: the fetch itself failed; a probe-side fault, not a verdict —
 *     the caller decides retry vs. skip.
 */
export type AmmIntegrity =
  | { status: "intact" }
  | { status: "drifted"; observed: string; pinned: string }
  | { status: "missing" }
  | { status: "rpc-error"; error: string };

/**
 * Compare a bound AMM's live ProgramData hash against the pinned sha256.
 *
 * Never throws on a runtime/RPC fault — those become `rpc-error` so the caller
 * can decide retry vs. skip without a try/catch at every site. Throws only on
 * API misuse (a `pinnedSha256` that is not 32 bytes), which is a caller bug,
 * not a runtime condition.
 */
export async function checkAmmIntegrity(
  connection: Connection,
  ammProgramId: PublicKey,
  pinnedSha256: Uint8Array,
): Promise<AmmIntegrity> {
  if (pinnedSha256.length !== 32) {
    throw new Error(
      `checkAmmIntegrity: pinnedSha256 must be 32 bytes, got ${pinnedSha256.length}`,
    );
  }

  let data: Uint8Array | null;
  try {
    const info = await connection.getAccountInfo(
      deriveProgramDataAddress(ammProgramId),
    );
    data = info ? info.data : null;
  } catch (err) {
    return {
      status: "rpc-error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (data === null) return { status: "missing" };

  const observed = createHash("sha256").update(data).digest();
  const pinned = Buffer.from(pinnedSha256);
  if (observed.equals(pinned)) return { status: "intact" };
  return {
    status: "drifted",
    observed: observed.toString("hex"),
    pinned: pinned.toString("hex"),
  };
}
