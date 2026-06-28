/**
 * @module lib/amm-integrity
 *
 * AMM-upgrade early-warning for the buyback cranker.
 *
 * The on-chain `settle_buyback` pins the bound AMM's program-data sha256
 * (`BuybackConfig.amm_program_data_sha256`) and fail-closes if it drifts
 * (INTEGRATION.md settle-validation item 11, which also asserts the account is
 * a loader-owned ProgramData account). This helper gives the keeper the SAME
 * signal off-chain so it can disable itself BEFORE a round-trip strands a slice
 * on a settle that is going to reject — or, worse, before it interacts with
 * freshly-upgraded (possibly hostile) AMM code. A third-party AMM whose upgrade
 * authority is a live key is the design's only unbounded risk surface
 * (PROPOSAL.md §11 "AMM upgrade authority").
 *
 * Mechanism: derive the program's ProgramData account (the BPF upgradeable
 * loader PDA `[program_id]`), fetch it, and ONLY THEN — having confirmed it is
 * a loader-owned account of the ProgramData variant — sha256 its bytes and
 * compare to the pinned hash. Anything that is not a well-formed loader
 * ProgramData account (wrong owner, wrong account variant, truncated) is its
 * own fail-closed verdict, never silently hashed-and-guessed. A hash mismatch
 * means the AMM was redeployed → disable the cranker for that market. An
 * in-house AMM with renounced / multisig upgrade authority removes the surface
 * and this check can be skipped.
 *
 * **Read commitment.** Defaults to `confirmed`, NOT the connection default:
 * this is a watch that gates fund-moving cranks, so catching an upgrade ~one
 * finality window sooner is worth more than waiting for finality. A false
 * `drifted` from an upgrade that later reorgs away is transient — the next poll
 * re-reads `intact` and re-enables — whereas a stale `intact` could let the
 * keeper interact with already-upgraded code. Pass `finalized` to gate strictly
 * on final state. (The on-chain settle is the ultimate fund guard either way.)
 *
 * **Hashed byte range — reconcile with O-S8 (the on-chain sha-pin leg).** This
 * hashes the FULL ProgramData account data: the `UpgradeableLoaderState::
 * ProgramData` metadata header (deploy slot + Option<upgrade_authority>) plus
 * the ELF. Because the header carries the deploy slot and the authority pubkey,
 * an authority rotation or an identical-bytes redeploy changes the hash and
 * trips a (fail-safe) `drifted`. To avoid that false positive O-S8 may instead
 * hash only the ELF region from the loader's fixed metadata offset. Whatever
 * O-S8 pins, THIS check must hash the exact same range — the on-chain side,
 * which can read the loader metadata size authoritatively in Rust, owns that
 * decision; mirror it here once pinned.
 *
 * **Transfer destination:** `dcccrypto/percolator-keeper/src/lib/`. Uses
 * `node:crypto`; the destination may swap to its preferred sha256 util.
 */

import { createHash } from "node:crypto";
import {
  Connection,
  PublicKey,
  type AccountInfo,
  type Commitment,
} from "@solana/web3.js";

/** BPF Upgradeable Loader — owner of every upgradeable program's ProgramData account. */
export const BPF_UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

/**
 * `UpgradeableLoaderState::ProgramData` enum discriminant. Bincode serializes
 * the loader-state variant index as a little-endian u32, and ProgramData is
 * variant 3. A real ProgramData account's first four bytes equal this; an
 * Uninitialized (0), Buffer (1), or Program (2) account — or non-loader
 * garbage — does not.
 */
const PROGRAMDATA_DISCRIMINATOR = 3;

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
 *   - `wrong-owner`: an account exists at the derived address but is not owned
 *     by the upgradeable loader — not a ProgramData account; **disable**.
 *     `owner` is the actual owner, base58.
 *   - `malformed`: loader-owned but not a well-formed ProgramData account
 *     (wrong variant or too short to classify) — **disable**. `detail` for the
 *     operator log.
 *   - `missing`: no account at the derived address — suspicious; **disable**.
 *   - `rpc-error`: the fetch itself failed; a probe-side fault, not a verdict —
 *     the caller decides retry vs. skip.
 *
 * Every verdict except `intact` and `rpc-error` is fail-closed: stop cranking
 * this market until it reads `intact` again.
 */
export type AmmIntegrity =
  | { status: "intact" }
  | { status: "drifted"; observed: string; pinned: string }
  | { status: "wrong-owner"; owner: string }
  | { status: "malformed"; detail: string }
  | { status: "missing" }
  | { status: "rpc-error"; error: string };

/**
 * Compare a bound AMM's live ProgramData hash against the pinned sha256.
 *
 * Validates the fetched account IS a loader-owned ProgramData account before
 * hashing — `wrong-owner` / `malformed` / `missing` cover anything that is not,
 * so the helper never sha256s arbitrary bytes and guesses a verdict.
 *
 * Never throws on a runtime/RPC fault — those become `rpc-error` so the caller
 * can decide retry vs. skip without a try/catch at every site. Throws only on
 * API misuse (a `pinnedSha256` that is not 32 bytes), which is a caller bug,
 * not a runtime condition.
 *
 * @param commitment read commitment for the account fetch (default `confirmed`
 *   — see the module note on commitment).
 */
export async function checkAmmIntegrity(
  connection: Connection,
  ammProgramId: PublicKey,
  pinnedSha256: Uint8Array,
  commitment: Commitment = "confirmed",
): Promise<AmmIntegrity> {
  if (pinnedSha256.length !== 32) {
    throw new Error(
      `checkAmmIntegrity: pinnedSha256 must be 32 bytes, got ${pinnedSha256.length}`,
    );
  }

  // Keep the whole AccountInfo: owner and data both gate the verdict.
  let info: AccountInfo<Buffer> | null;
  try {
    info = await connection.getAccountInfo(
      deriveProgramDataAddress(ammProgramId),
      commitment,
    );
  } catch (err) {
    return {
      status: "rpc-error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (info === null) return { status: "missing" };
  if (!info.owner.equals(BPF_UPGRADEABLE_LOADER_ID)) {
    return { status: "wrong-owner", owner: info.owner.toBase58() };
  }
  if (info.data.length < 4) {
    return {
      status: "malformed",
      detail: `account ${info.data.length} bytes, need >= 4 for the loader-state variant tag`,
    };
  }
  const variant = info.data.readUInt32LE(0);
  if (variant !== PROGRAMDATA_DISCRIMINATOR) {
    return {
      status: "malformed",
      detail: `loader-state variant ${variant}, expected ${PROGRAMDATA_DISCRIMINATOR} (ProgramData)`,
    };
  }

  const observed = createHash("sha256").update(info.data).digest();
  const pinned = Buffer.from(pinnedSha256);
  if (observed.equals(pinned)) return { status: "intact" };
  return {
    status: "drifted",
    observed: observed.toString("hex"),
    pinned: pinned.toString("hex"),
  };
}
