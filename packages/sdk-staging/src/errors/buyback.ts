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
 * **Source of truth:** the variant order MUST match the math crate's
 * `BuybackBlocker` enum in `dcccrypto/percolator/src/buyback.rs`. That
 * enum is locker-rule append-only — variants can be added at the tail
 * but never reordered or removed. If the destination ever appends a
 * variant, append it here at the same index so the discriminant
 * mapping stays correct.
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
 * **Order frozen against `crates/buyback-staging/src/buyback.rs`** —
 * variants are listed in declaration order. New variants append at
 * the tail; existing variants never move.
 */
export const BUYBACK_BLOCKER = {
  /** Less than `BUYBACK_COOLDOWN_SECS` since the previous successful trigger. */
  CooldownActive: 0,
  /** Insurance fund balance is at or below the admin-set floor. */
  BelowInsuranceFloor: 1,
  /** One or more markets are paying haircut on positive PnL. */
  HaircutsActive: 2,
  /** `market_exposure_q` is zero; no measurable risk for the ratio gate to weigh. */
  ExposureBelowMinimum: 3,
  /** `fund × DEN` < `exposure × NUM`; insurance under-collateralized for buyback. */
  RatioBelowThreshold: 4,
  /** A `checked_*` arithmetic op returned `None`; cross-cutting fail-closed bucket. */
  MathOverflow: 5,
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
 * Translate a `BuybackBlocker` discriminant code (0..=5 at this
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
 * `CooldownActive`/`BelowInsuranceFloor` failures, alert on the rest").
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
