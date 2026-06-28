/**
 * @module errors/buyback
 *
 * TypeScript mirror of the math crate's `BuybackBlocker` enum and
 * helpers for parsing it out of on-chain error/log surfaces.
 *
 * **Transfer destination:** append the exported items to
 * `dcccrypto/percolator-sdk/src/abi/errors.ts` (or, if the destination
 * prefers per-feature error files, drop the file at
 * `src/abi/errors/buyback.ts` and re-export from `src/abi/errors.ts`).
 *
 * **Source of truth — canonical order.** The variant order below is the
 * canonical declaration order pinned in `PROPOSAL.md` §6.1 /
 * `INTEGRATION.md` for the protocol-fee-funded design (gate-evaluation
 * sequence, `MathOverflow` last). It MUST match the math crate's
 * `BuybackBlocker` enum in `dcccrypto/percolator/src/buyback.rs`
 * byte-for-byte — that enum is being retargeted to the same order. The
 * append-only locker rule (variants added only at the tail, never
 * reordered) takes effect once the enum lands on-chain and downstream
 * services begin pinning the numeric codes; until transfer the order is
 * finalized here against the pinned canonical order.
 *
 * **Why this is in the SDK and not keeper-private:** the
 * `BuybackBlocker` discriminant is the public failure-mode contract
 * returned by `simulateTransaction` on a `trigger_buyback` ix. Per
 * Phase 4's C17 keeper plan, the eligibility-probe loop tags each
 * gate-failure variant in structured logs (Sentry tag the variant
 * name). Centralizing the variant-to-name mapping here means every
 * downstream consumer (keeper, indexer, any future ops tooling) reads
 * the same canonical names rather than re-deriving them.
 */

/**
 * Variants of `BuybackBlocker` from the math crate, mapped to their
 * declaration index. The index is the discriminant value the Rust
 * enum serializes to under `#[repr(u8)]` or via Borsh / numeric cast.
 *
 * **Canonical declaration order** (see the module header): the
 * gate-evaluation sequence with `MathOverflow` last. Must match the math
 * crate's `BuybackBlocker` enum byte-for-byte.
 */
export const BUYBACK_BLOCKER = {
  /** Less than `BUYBACK_COOLDOWN_SECS` since the previous successful trigger. */
  CooldownActive: 0,
  /** The `BuybackTreasury` balance is at or below the hardcoded treasury floor. */
  BelowTreasuryFloor: 1,
  /** The market is paying a haircut on positive PnL — under stress, no buyback. */
  HaircutsActive: 2,
  /** The market is otherwise distressed and the buyback is auto-paused. */
  AutoPausedUnderStress: 3,
  /** A reserve-first staker top-up is owed / in flight; the buyback yields to it. */
  ReserveTopUpPending: 4,
  /** `market_exposure_q` is zero — the market has no live open interest. */
  ExposureBelowMinimum: 5,
  /** A `checked_*` arithmetic op returned `None`; cross-cutting fail-closed bucket. */
  MathOverflow: 6,
} as const;
Object.freeze(BUYBACK_BLOCKER);

/** TS type covering the literal numeric discriminants. */
export type BuybackBlockerCode =
  (typeof BUYBACK_BLOCKER)[keyof typeof BUYBACK_BLOCKER];

/** TS type covering the variant name strings. */
export type BuybackBlockerName = keyof typeof BUYBACK_BLOCKER;

const NAME_BY_CODE: Readonly<Record<number, BuybackBlockerName>> = (() => {
  const m: Record<number, BuybackBlockerName> = {};
  for (const [name, code] of Object.entries(BUYBACK_BLOCKER) as Array<
    [BuybackBlockerName, BuybackBlockerCode]
  >) {
    m[code] = name;
  }
  return Object.freeze(m);
})();

/**
 * Translate a `BuybackBlocker` discriminant code (0..=6 at this
 * staging snapshot) to its variant name. Returns `null` for any code
 * outside the known range — caller decides whether to treat that as
 * an unrecognized future variant or a parser bug.
 *
 * @example
 *   parseBuybackBlockerName(0)  // "CooldownActive"
 *   parseBuybackBlockerName(99) // null
 */
export function parseBuybackBlockerName(
  code: number,
): BuybackBlockerName | null {
  if (!Number.isInteger(code)) return null;
  return (NAME_BY_CODE as Record<number, BuybackBlockerName | undefined>)[code]
    ?? null;
}

/**
 * Inverse of `parseBuybackBlockerName`: variant name → discriminant.
 * Useful for keepers that filter on variant strings (e.g. "ignore all
 * `CooldownActive`/`BelowTreasuryFloor` failures, alert on the rest").
 *
 * Returns `null` for any unrecognized name — the keys in
 * `BUYBACK_BLOCKER` are the exhaustive set.
 */
export function buybackBlockerCode(
  name: string,
): BuybackBlockerCode | null {
  return (BUYBACK_BLOCKER as Record<string, BuybackBlockerCode | undefined>)[
    name
  ] ?? null;
}
