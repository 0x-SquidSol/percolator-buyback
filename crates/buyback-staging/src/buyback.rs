//! Buyback parameters, gate-failure types, exposure aggregator, and the
//! eligibility predicate.
//!
//! The handler's call sequence is:
//!
//! 1. Verify the slab pubkey matches the canonical mainnet slab (handler
//!    crate concern; not in this module).
//! 2. [`assert_per_slab_invariant`] — confirms the per-slab math premise
//!    (`live_market_count <= MAX_MARKETS_FOR_PER_SLAB`).
//! 3. [`total_protocol_exposure`] — aggregates per-market exposure.
//! 4. [`buyback_eligible`] — runs the four economic gates and returns the
//!    slice on success.
//!
//! All four buyback parameters are compile-time constants by design (see
//! PROPOSAL.md §4 and §7.5). Changing any of them requires a program
//! upgrade — there is no admin-tunable path.

/// Numerator of the insurance-fund-to-exposure ratio threshold (1.5×).
///
/// Paired with [`BUYBACK_RATIO_THRESHOLD_DEN`]. The eligibility gate
/// compares `fund_balance × DEN` against `total_exposure × NUM` via
/// integer cross-multiplication; no fixed-point representation needed.
/// Equality passes (PROPOSAL.md §2.1: `≥`).
pub const BUYBACK_RATIO_THRESHOLD_NUM: u128 = 15;

/// Denominator of the insurance-fund-to-exposure ratio threshold (1.5×).
pub const BUYBACK_RATIO_THRESHOLD_DEN: u128 = 10;

/// Per-event withdrawal cap in basis points of insurance-fund balance
/// (0.1% per event — PROPOSAL.md §4 / §7.2).
pub const BUYBACK_PER_EVENT_BPS: u64 = 10;

/// Minimum spacing between buyback events, in seconds (24 hours).
pub const BUYBACK_COOLDOWN_SECS: i64 = 86_400;

/// Basis-points denominator. `value × bps / BPS_DENOMINATOR` converts a
/// bps fraction back into a value. Used by the per-market exposure formula
/// in PROPOSAL.md §3.1 (`maintenance_bps / 10_000`).
pub const BPS_DENOMINATOR: u128 = 10_000;

// Compile-time invariant: the ratio threshold must always exceed 1×.
// A misedit that produced NUM <= DEN would silently allow buybacks at
// any solvency ratio, including under-collateralized states. This
// const assertion fails the build rather than the tests.
const _: () = assert!(BUYBACK_RATIO_THRESHOLD_NUM > BUYBACK_RATIO_THRESHOLD_DEN);

/// Hard fail-closed assertion on the per-slab buyback implementation.
///
/// At launch the protocol has one live market, making per-slab semantically
/// equivalent to global aggregation. Once a second market launches, the
/// gate must migrate to a global formulation (or the shared-vault concept
/// under PERC-628 ships, whichever first). Until then, this constant pins
/// the assumption: the trigger handler compares the live market count
/// against this value and fails closed if exceeded.
pub const MAX_MARKETS_FOR_PER_SLAB: usize = 1;

/// Reasons a buyback trigger may be blocked.
///
/// Each variant maps to a distinct failure mode returned by
/// [`assert_per_slab_invariant`], [`total_protocol_exposure`], or
/// [`buyback_eligible`]. Keeping these as an enum (vs. string errors)
/// lets callers distinguish steady-state cooldown from anomalous gate
/// failures without parsing.
///
/// Variants are ordered to match the runtime evaluation sequence:
/// the per-slab premise check fires first (in the sibling
/// [`assert_per_slab_invariant`]), then the four economic gates run
/// cheap-to-expensive inside [`buyback_eligible`]. `MathOverflow` sits
/// last by convention because it is a cross-cutting fail-closed bucket
/// that any `checked_*` site can fire from, not a sequenced gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuybackBlocker {
    /// Live market count exceeds [`MAX_MARKETS_FOR_PER_SLAB`]. The
    /// per-slab implementation's premise no longer holds; a program
    /// upgrade must migrate to global aggregation before buybacks can
    /// resume.
    MultiMarketRequiresGlobalAggregation,
    /// Less than [`BUYBACK_COOLDOWN_SECS`] since the previous successful
    /// trigger.
    CooldownActive,
    /// Insurance fund balance is at or below the admin-set
    /// `insurance_floor`.
    BelowInsuranceFloor,
    /// One or more markets are currently paying haircut on positive PnL,
    /// indicating the protocol is in a stressed regime.
    HaircutsActive,
    /// `fund × DEN` < `exposure × NUM`. The insurance fund is not
    /// over-collateralized enough relative to current protocol exposure.
    RatioBelowThreshold,
    /// A `checked_*` arithmetic operation returned `None` — either while
    /// aggregating per-market exposure or while running the cross-multiply
    /// ratio comparison. Treated as a fail-closed condition; should be
    /// unreachable in practice but defends against pathological input.
    /// Conventionally placed last as a cross-cutting bucket; do not
    /// re-sort alphabetically.
    MathOverflow,
}

/// Per-market inputs to [`total_protocol_exposure`].
///
/// Each field mirrors a name documented in PROPOSAL.md §3.1. Callers
/// resolve every field upstream — the math crate does not import oracle
/// or risk-engine code. The struct is `Copy` so callers can pass slices
/// of values without lifetime gymnastics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarketView {
    /// Effective long open interest (Q-format), per PROPOSAL.md §3.1
    /// (`oi_eff_long_q`).
    pub oi_eff_long_q: u128,
    /// Effective short open interest (Q-format), per PROPOSAL.md §3.1
    /// (`oi_eff_short_q`).
    pub oi_eff_short_q: u128,
    /// Oracle price scaled by 1e6, pre-resolved by the caller via the
    /// matcher's per-market dispatch (Hyperp / Pyth — PROPOSAL.md §11
    /// "Oracle source"). The math crate is oracle-agnostic.
    pub oracle_price_e6: u128,
    /// Maintenance margin requirement in basis points, read directly
    /// from the slab's risk parameters (PROPOSAL.md §11
    /// "Maintenance bps source": per-market and immutable post-init).
    /// Range fits in `u16` since the maximum representable value is
    /// 10 000 — see [`BPS_DENOMINATOR`].
    pub maintenance_bps: u16,
}

/// Sums per-market exposure across all live markets.
///
/// Implements the formula in PROPOSAL.md §3.1: for each market,
/// `(oi_eff_long_q + oi_eff_short_q) × oracle_price_e6 × maintenance_bps
/// / BPS_DENOMINATOR`; the per-market values are then summed to produce
/// the total. Long and short open interest are summed (not netted) — a
/// balanced book still represents real risk against the insurance fund.
///
/// All arithmetic is checked. Any overflow at any step short-circuits
/// with [`BuybackBlocker::MathOverflow`] rather than wrapping or
/// saturating. The same variant is also returned for two precondition
/// violations on `MarketView`: (a) `maintenance_bps` exceeds
/// [`BPS_DENOMINATOR`] (10 000) — an out-of-range bps could silently
/// inflate exposure; and (b) `oracle_price_e6 == 0` — a missing or
/// stuck oracle reading could silently zero out the market's
/// contribution to total exposure, masking real risk. Both
/// preconditions are folded into the same fail-closed bucket. The
/// eligibility predicate that consumes this value treats
/// `MathOverflow` as a gate failure, so the buyback does not fire when
/// an aggregation step lost precision or an upstream caller supplied
/// an invalid `MarketView`.
///
/// Returns `Ok(0)` for an empty market list.
pub fn total_protocol_exposure(markets: &[MarketView]) -> Result<u128, BuybackBlocker> {
    let mut total: u128 = 0;
    for m in markets {
        if m.maintenance_bps as u128 > BPS_DENOMINATOR {
            return Err(BuybackBlocker::MathOverflow);
        }
        if m.oracle_price_e6 == 0 {
            return Err(BuybackBlocker::MathOverflow);
        }
        let oi_sum = m
            .oi_eff_long_q
            .checked_add(m.oi_eff_short_q)
            .ok_or(BuybackBlocker::MathOverflow)?;
        let notional = oi_sum
            .checked_mul(m.oracle_price_e6)
            .ok_or(BuybackBlocker::MathOverflow)?;
        let weighted = notional
            .checked_mul(m.maintenance_bps as u128)
            .ok_or(BuybackBlocker::MathOverflow)?;
        let market_exposure = weighted / BPS_DENOMINATOR;
        // Cross-market accumulator. Under maintenance_bps ≤ BPS_DENOMINATOR
        // and MAX_MARKETS_FOR_PER_SLAB = 1, summing in-bounds market_exposures
        // cannot overflow u128 — this checked_add is defense-in-depth against
        // pathological input (also unreachable for a wrapping_add mutation).
        total = total
            .checked_add(market_exposure)
            .ok_or(BuybackBlocker::MathOverflow)?;
    }
    Ok(total)
}

/// Asserts the per-slab implementation's premise: at most one live market.
///
/// Per PROPOSAL.md §11 "Slab vs market aggregation — per-slab", the
/// per-slab buyback math is mathematically equivalent to the global
/// formulation only while the live market count does not exceed
/// [`MAX_MARKETS_FOR_PER_SLAB`]. Once a second market launches, the gate
/// must migrate to a global aggregation; this function fails closed in
/// that scenario so the caller can route to the upgrade path.
///
/// Trust model: callers must derive `live_market_count` from an
/// authoritative on-chain source (e.g., comparing the slab pubkey
/// against a hardcoded `CANONICAL_SLAB` constant in the handler crate)
/// rather than from a cranker-supplied value. The math crate cannot
/// verify the count itself.
pub fn assert_per_slab_invariant(live_market_count: usize) -> Result<(), BuybackBlocker> {
    if live_market_count > MAX_MARKETS_FOR_PER_SLAB {
        return Err(BuybackBlocker::MultiMarketRequiresGlobalAggregation);
    }
    Ok(())
}

/// Eligibility gate for a buyback trigger.
///
/// Runs the four economic gates from PROPOSAL.md §2 in cheap-to-expensive
/// order — cooldown, insurance floor, protocol stress, exposure ratio —
/// then computes and returns the slice size. The per-slab N=1 invariant
/// is checked separately by [`assert_per_slab_invariant`]; the handler
/// must call that first.
///
/// On success, the returned slice has two regimes:
///
/// - **Proportional**: [`BUYBACK_PER_EVENT_BPS`] (10 bps) of `fund_balance`.
/// - **Clamped**: `fund_balance - insurance_floor` when the proportional
///   value would breach the floor.
///
/// Note the floor's strict-inequality asymmetry: `fund_balance ==
/// insurance_floor` fails the floor gate (PROPOSAL.md §2.3 specifies
/// `fund_balance > insurance_floor`), while `fund_balance ==
/// insurance_floor + 1` passes and may produce a slice of 0 or 1
/// depending on the proportional arm's integer rounding.
///
/// **`Ok(0)` IS A CALLER CORRECTNESS CONTRACT.** When the slice rounds
/// to zero (fund just above floor, proportional truncates), the caller
/// MUST short-circuit without stamping the cooldown timestamp.
/// PROPOSAL.md §5.1 mandates this: "no point burning a 24h slot on a
/// zero-byte event." A handler that forgets this contract will burn a
/// 24h cooldown for no economic effect.
///
/// Returns `Err(BuybackBlocker::MathOverflow)` from any `checked_*`
/// arithmetic failure. At realistic input scales this is defense-in-depth
/// — practical inputs do not approach the u128 boundary — but the
/// explicit channel keeps pathological input observable in operator logs
/// alongside the existing overflow handling in [`total_protocol_exposure`].
///
/// Trust assumptions on parameters:
///
/// - `haircut_active`: caller has aggregated this across all live
///   markets. The math crate trusts the boolean as a global stress
///   signal (per the prereq A resolution: stress is protocol-wide, not
///   slab-local).
/// - `now`, `last_buyback_ts`: caller supplies via Solana `Clock`. No
///   defensive sign checks; Solana timestamps post-genesis are
///   non-negative by construction.
/// - `total_exposure_q`: pre-aggregated by [`total_protocol_exposure`].
///   The Q-format suffix matches the field naming in [`MarketView`].
pub fn buyback_eligible(
    fund_balance: u64,
    total_exposure_q: u128,
    last_buyback_ts: i64,
    now: i64,
    haircut_active: bool,
    insurance_floor: u64,
) -> Result<u64, BuybackBlocker> {
    // Gate 1: Cooldown — `now >= last_buyback_ts + BUYBACK_COOLDOWN_SECS`.
    let next_eligible_ts = last_buyback_ts
        .checked_add(BUYBACK_COOLDOWN_SECS)
        .ok_or(BuybackBlocker::MathOverflow)?;
    if now < next_eligible_ts {
        return Err(BuybackBlocker::CooldownActive);
    }

    // Gate 2: Floor — strict `fund_balance > insurance_floor`.
    if fund_balance <= insurance_floor {
        return Err(BuybackBlocker::BelowInsuranceFloor);
    }

    // Gate 3: Stress — no haircut active anywhere in the protocol.
    if haircut_active {
        return Err(BuybackBlocker::HaircutsActive);
    }

    // Gate 4: Ratio — cross-multiplied form of `fund / exposure >= 1.5`.
    // Equality passes (PROPOSAL.md §2.1: `>=`).
    //
    // Note: the lhs `checked_mul` is defense-in-depth; with `fund_balance:
    // u64` widened to u128 and multiplied by 10, the result cannot exceed
    // ~1.84e20, far below `u128::MAX`. The check is retained against any
    // future signature change. The rhs `checked_mul` IS reachable — a
    // pathologically large `total_exposure_q` near `u128::MAX` overflows
    // when multiplied by 15.
    let lhs = (fund_balance as u128)
        .checked_mul(BUYBACK_RATIO_THRESHOLD_DEN)
        .ok_or(BuybackBlocker::MathOverflow)?;
    let rhs = total_exposure_q
        .checked_mul(BUYBACK_RATIO_THRESHOLD_NUM)
        .ok_or(BuybackBlocker::MathOverflow)?;
    if lhs < rhs {
        return Err(BuybackBlocker::RatioBelowThreshold);
    }

    // Slice computation. The proportional arm uses `checked_mul` to bound
    // u64 overflow at the source; the clamped arm uses `saturating_sub`
    // safely because the floor gate has already established
    // `fund_balance > insurance_floor`.
    let slice_proportional = fund_balance
        .checked_mul(BUYBACK_PER_EVENT_BPS)
        .ok_or(BuybackBlocker::MathOverflow)?
        / (BPS_DENOMINATOR as u64);
    let slice_clamped = fund_balance.saturating_sub(insurance_floor);
    Ok(slice_proportional.min(slice_clamped))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Locks the cross-multiplication convention against accidental future
    /// edits. If this test ever fails, the gate's comparison direction may
    /// have silently inverted. The `NUM > DEN` invariant is locked
    /// separately by a compile-time `const _: () = assert!(...)` above.
    #[test]
    fn ratio_threshold_constants_lock() {
        assert_eq!(BUYBACK_RATIO_THRESHOLD_NUM, 15);
        assert_eq!(BUYBACK_RATIO_THRESHOLD_DEN, 10);
    }

    /// Locks the basis-points denominator at exactly 10 000. A misedit
    /// would silently scale every exposure and slice computation by
    /// orders of magnitude.
    #[test]
    fn bps_denominator_lock() {
        assert_eq!(BPS_DENOMINATOR, 10_000);
    }

    #[test]
    fn cooldown_is_24h() {
        assert_eq!(BUYBACK_COOLDOWN_SECS, 86_400);
        assert_eq!(BUYBACK_COOLDOWN_SECS / 3600, 24);
    }

    #[test]
    fn per_event_bps_is_10() {
        assert_eq!(BUYBACK_PER_EVENT_BPS, 10);
    }

    #[test]
    fn max_markets_invariant_at_launch() {
        // PROPOSAL.md §11 "Slab vs market aggregation — per-slab":
        // launch invariant is one live market.
        assert_eq!(MAX_MARKETS_FOR_PER_SLAB, 1);
    }

    fn sample_market(long: u128, short: u128, price: u128, bps: u16) -> MarketView {
        MarketView {
            oi_eff_long_q: long,
            oi_eff_short_q: short,
            oracle_price_e6: price,
            maintenance_bps: bps,
        }
    }

    #[test]
    fn exposure_empty_market_list_returns_zero() {
        assert_eq!(total_protocol_exposure(&[]), Ok(0));
    }

    #[test]
    fn exposure_single_market_exact_value() {
        // (1_000 + 500) × 100 × 500 / 10_000 = 7_500
        let m = sample_market(1_000, 500, 100, 500);
        assert_eq!(total_protocol_exposure(&[m]), Ok(7_500));
    }

    #[test]
    fn exposure_multiple_markets_summed() {
        // m1: (1_000 + 0) × 200 × 500 / 10_000 = 10_000
        // m2: (0 + 2_000) × 100 × 1_000 / 10_000 = 20_000
        // m3: (500 + 500) × 50 × 800 / 10_000 = 4_000
        // total = 34_000
        let m1 = sample_market(1_000, 0, 200, 500);
        let m2 = sample_market(0, 2_000, 100, 1_000);
        let m3 = sample_market(500, 500, 50, 800);
        assert_eq!(total_protocol_exposure(&[m1, m2, m3]), Ok(34_000));
    }

    #[test]
    fn exposure_long_only_market_works() {
        // (10_000 + 0) × 1 × 500 / 10_000 = 500
        let m = sample_market(10_000, 0, 1, 500);
        assert_eq!(total_protocol_exposure(&[m]), Ok(500));
    }

    #[test]
    fn exposure_zero_maintenance_bps_market_contributes_zero() {
        // bps = 0 ⇒ this market contributes 0 even with non-zero OI
        // and non-zero price; the rest of the list is unaffected.
        let m_zero_bps = sample_market(1_000_000, 1_000_000, 1_000, 0);
        let m_normal = sample_market(1_000, 0, 100, 500);
        // m_normal: 1_000 × 100 × 500 / 10_000 = 5_000
        assert_eq!(total_protocol_exposure(&[m_zero_bps, m_normal]), Ok(5_000),);
    }

    #[test]
    fn exposure_overflow_returns_math_overflow_err() {
        // Path 1: checked_add overflow on (long + short).
        let m_add_overflow = sample_market(u128::MAX, 1, 1, 1);
        assert_eq!(
            total_protocol_exposure(&[m_add_overflow]),
            Err(BuybackBlocker::MathOverflow),
        );

        // Path 2: checked_mul overflow on (oi_sum × price).
        // oi_sum = (u128::MAX / 2) + 0 = u128::MAX / 2.
        // price = 4 ⇒ oi_sum × 4 overflows.
        let m_mul_overflow = sample_market(u128::MAX / 2, 0, 4, 1);
        assert_eq!(
            total_protocol_exposure(&[m_mul_overflow]),
            Err(BuybackBlocker::MathOverflow),
        );

        // Path 3: checked_mul overflow on (notional × maintenance_bps).
        // long = u128::MAX / 9_999, short = 0, price = 1, bps = 10_000.
        // oi_sum = u128::MAX / 9_999. notional = oi_sum × 1 = oi_sum.
        // notional × 10_000 > u128::MAX since (u128::MAX / 9_999) × 10_000
        // exceeds u128::MAX.
        let m_bps_overflow = sample_market(u128::MAX / 9_999, 0, 1, 10_000);
        assert_eq!(
            total_protocol_exposure(&[m_bps_overflow]),
            Err(BuybackBlocker::MathOverflow),
        );
    }

    #[test]
    fn exposure_out_of_range_maintenance_bps_returns_err() {
        // bps = 10_001 violates the BPS_DENOMINATOR upper bound. The
        // function rejects it before any arithmetic runs, returning
        // MathOverflow as a fail-closed precondition violation.
        let m = sample_market(1_000, 1_000, 100, 10_001);
        assert_eq!(
            total_protocol_exposure(&[m]),
            Err(BuybackBlocker::MathOverflow),
        );

        // Boundary: bps = BPS_DENOMINATOR (10_000) is accepted.
        let m_boundary = sample_market(1_000, 0, 1, 10_000);
        // 1_000 × 1 × 10_000 / 10_000 = 1_000.
        assert_eq!(total_protocol_exposure(&[m_boundary]), Ok(1_000));
    }

    #[test]
    fn exposure_zero_oracle_price_returns_err() {
        // oracle_price_e6 = 0 violates the non-zero precondition. The
        // function rejects it before any arithmetic runs, returning
        // MathOverflow as a fail-closed precondition violation. A
        // missing or stuck oracle would otherwise silently zero out
        // the market's contribution to total exposure.
        let m = sample_market(1_000, 0, 0, 500);
        assert_eq!(
            total_protocol_exposure(&[m]),
            Err(BuybackBlocker::MathOverflow),
        );

        // One bad market poisons the aggregate even when other markets
        // are valid — short-circuiting matches how out-of-range bps and
        // arithmetic overflows are handled.
        let m_bad = sample_market(1_000, 0, 0, 500);
        let m_good = sample_market(1_000, 0, 100, 500);
        assert_eq!(
            total_protocol_exposure(&[m_good, m_bad]),
            Err(BuybackBlocker::MathOverflow),
        );
    }

    // ---------------- assert_per_slab_invariant ----------------

    #[test]
    fn per_slab_zero_markets_passes() {
        // 0 ≤ MAX_MARKETS_FOR_PER_SLAB; degenerate but valid.
        assert_eq!(assert_per_slab_invariant(0), Ok(()));
    }

    #[test]
    fn per_slab_one_market_passes() {
        assert_eq!(assert_per_slab_invariant(1), Ok(()));
    }

    #[test]
    fn per_slab_two_markets_blocked() {
        assert_eq!(
            assert_per_slab_invariant(2),
            Err(BuybackBlocker::MultiMarketRequiresGlobalAggregation),
        );
    }

    // ---------------- buyback_eligible — happy paths ----------------

    #[test]
    fn predicate_all_gates_pass_proportional_slice() {
        // fund=1_000_000, exposure=500_000 → ratio = 2.0 (≥ 1.5).
        // proportional = 1_000_000 × 10 / 10_000 = 1_000.
        // clamped = 1_000_000 - 100_000 = 900_000.
        // min = 1_000.
        assert_eq!(
            buyback_eligible(1_000_000, 500_000, 0, 100_000, false, 100_000),
            Ok(1_000),
        );
    }

    #[test]
    fn predicate_clamped_slice_arm() {
        // fund just above floor; clamped < proportional.
        // fund = 100_005, floor = 100_000.
        // proportional = 100_005 × 10 / 10_000 = 100.
        // clamped = 5.
        // min = 5.
        // exposure = 50_000 → ratio = 2.0001 (≥ 1.5).
        assert_eq!(
            buyback_eligible(100_005, 50_000, 0, 100_000, false, 100_000),
            Ok(5),
        );
    }

    #[test]
    fn predicate_zero_slice_when_proportional_rounds_to_zero() {
        // fund × BPS / DENOM rounds to 0 when fund × BPS < DENOM.
        // fund = 100, floor = 99 → proportional = 0, clamped = 1, min = 0.
        // exposure = 60 → ratio = 1.667 (≥ 1.5).
        assert_eq!(buyback_eligible(100, 60, 0, 100_000, false, 99), Ok(0),);
    }

    // ---------------- buyback_eligible — gate failures ----------------

    #[test]
    fn predicate_cooldown_active() {
        let last_ts: i64 = 1_000_000;
        let now: i64 = last_ts + BUYBACK_COOLDOWN_SECS - 1;
        assert_eq!(
            buyback_eligible(1_000_000, 500_000, last_ts, now, false, 100_000),
            Err(BuybackBlocker::CooldownActive),
        );
    }

    #[test]
    fn predicate_cooldown_at_boundary_passes() {
        // now == last + COOLDOWN_SECS exactly → passes (≥ not >).
        let last_ts: i64 = 1_000_000;
        let now: i64 = last_ts + BUYBACK_COOLDOWN_SECS;
        assert_eq!(
            buyback_eligible(1_000_000, 500_000, last_ts, now, false, 100_000),
            Ok(1_000),
        );
    }

    #[test]
    fn predicate_last_ts_zero_passes_cooldown() {
        // last_ts = 0 means never fired. Cooldown trivially passes since
        // 0 + 86_400 = 86_400, far below realistic Solana clock.
        assert_eq!(
            buyback_eligible(1_000_000, 500_000, 0, 100_000, false, 100_000),
            Ok(1_000),
        );
    }

    #[test]
    fn predicate_floor_equal_blocked() {
        // fund == floor → fails (strict `>` per PROPOSAL.md §2.3).
        assert_eq!(
            buyback_eligible(100_000, 500_000, 0, 100_000, false, 100_000),
            Err(BuybackBlocker::BelowInsuranceFloor),
        );
    }

    #[test]
    fn predicate_floor_plus_one_passes() {
        // fund = floor + 1 → passes; slice clamped to 1.
        // proportional = 100_001 × 10 / 10_000 = 100.
        // clamped = 1.
        // min = 1.
        assert_eq!(
            buyback_eligible(100_001, 50_000, 0, 100_000, false, 100_000),
            Ok(1),
        );
    }

    #[test]
    fn predicate_haircut_active_blocked() {
        assert_eq!(
            buyback_eligible(1_000_000, 500_000, 0, 100_000, true, 100_000),
            Err(BuybackBlocker::HaircutsActive),
        );
    }

    #[test]
    fn predicate_ratio_below_threshold() {
        // fund=1_000_000, exposure=700_000 → ratio ≈ 1.43 (< 1.5).
        // 1_000_000 × 10 = 10_000_000.
        // 700_000 × 15 = 10_500_000.
        // lhs < rhs → fail.
        assert_eq!(
            buyback_eligible(1_000_000, 700_000, 0, 100_000, false, 100_000),
            Err(BuybackBlocker::RatioBelowThreshold),
        );
    }

    #[test]
    fn predicate_ratio_exactly_at_threshold_passes() {
        // fund × 10 == exposure × 15 → ratio = 1.5 exactly. Equality
        // passes (PROPOSAL.md §2.1: `≥`).
        // fund = 15_000, exposure = 10_000.
        // 15_000 × 10 = 150_000 = 10_000 × 15. lhs ≥ rhs.
        // proportional = 15_000 × 10 / 10_000 = 15.
        // clamped = 15_000 - 100 = 14_900.
        // min = 15.
        assert_eq!(
            buyback_eligible(15_000, 10_000, 0, 100_000, false, 100),
            Ok(15),
        );
    }

    #[test]
    fn predicate_zero_exposure_passes() {
        // exposure = 0 → ratio is degenerate ("infinite"). lhs ≥ 0 → passes.
        assert_eq!(
            buyback_eligible(1_000_000, 0, 0, 100_000, false, 100_000),
            Ok(1_000),
        );
    }

    // ---------------- buyback_eligible — overflow paths ----------------

    #[test]
    fn predicate_cooldown_addition_overflow() {
        // last_buyback_ts at i64::MAX → checked_add(COOLDOWN_SECS) overflows.
        // The function returns MathOverflow before any other check.
        assert_eq!(
            buyback_eligible(1, 0, i64::MAX, 0, false, 0),
            Err(BuybackBlocker::MathOverflow),
        );
    }

    #[test]
    fn predicate_rhs_cross_multiply_overflow() {
        // exposure × 15 overflows when exposure > u128::MAX / 15.
        // u128::MAX / 14 × 15 > u128::MAX → overflows on rhs checked_mul.
        // (lhs path is unreachable from u64 fund_balance — see function
        // doc-comment.)
        assert_eq!(
            buyback_eligible(1_000_000, u128::MAX / 14, 0, 100_000, false, 100_000,),
            Err(BuybackBlocker::MathOverflow),
        );
    }

    #[test]
    fn predicate_slice_multiply_overflow() {
        // fund × BPS_PER_EVENT (10) overflows u64 when fund > u64::MAX/10.
        // fund = u64::MAX, exposure small enough that ratio passes.
        // u64::MAX × 10 wraps in u64 → checked_mul returns None.
        assert_eq!(
            buyback_eligible(u64::MAX, 1_000, 0, 100_000, false, 0),
            Err(BuybackBlocker::MathOverflow),
        );
    }

    // ---------------- buyback_eligible — gate ordering ----------------

    #[test]
    fn predicate_gate_ordering_returns_cheapest_failure() {
        // Both cooldown AND ratio fail. Cooldown is checked first
        // (cheap-to-expensive ordering per PROPOSAL.md §2), so the
        // returned error must be CooldownActive, not RatioBelowThreshold.
        let last_ts: i64 = 1_000_000;
        let now: i64 = last_ts + BUYBACK_COOLDOWN_SECS - 1; // cooldown fails
                                                            // exposure high enough that ratio also fails: 1_000_000 / 700_000 ≈ 1.43
        assert_eq!(
            buyback_eligible(1_000_000, 700_000, last_ts, now, false, 100_000),
            Err(BuybackBlocker::CooldownActive),
        );
    }

    #[test]
    fn predicate_negative_last_ts_passes() {
        // Defensive coverage: Solana Clock timestamps are non-negative
        // by construction, but the i64 type allows negatives. Cooldown
        // arithmetic via checked_add handles them without panic.
        // last_ts = -1_000, now = 100_000.
        // -1_000 + 86_400 = 85_400. now > 85_400 → cooldown passes.
        // proportional = 1_000_000 × 10 / 10_000 = 1_000.
        // clamped = 900_000. min = 1_000.
        assert_eq!(
            buyback_eligible(1_000_000, 500_000, -1_000, 100_000, false, 100_000),
            Ok(1_000),
        );
    }

    #[test]
    fn predicate_now_before_last_ts_blocked() {
        // Defensive coverage: caller's "now" is earlier than
        // last_buyback_ts (clock drift / replayed state).
        // last_ts = 100_000, now = 50_000.
        // last + 86_400 = 186_400. 50_000 < 186_400 → CooldownActive.
        assert_eq!(
            buyback_eligible(1_000_000, 500_000, 100_000, 50_000, false, 100_000),
            Err(BuybackBlocker::CooldownActive),
        );
    }

    #[test]
    fn predicate_gate_ordering_floor_before_ratio() {
        // Cheap-to-expensive ordering: floor gate fires before ratio
        // gate. fund == floor → BelowInsuranceFloor (strict > per §2.3).
        // exposure = 700_000 would also fail the ratio check if reached.
        assert_eq!(
            buyback_eligible(100_000, 700_000, 0, 100_000, false, 100_000),
            Err(BuybackBlocker::BelowInsuranceFloor),
        );
    }

    #[test]
    fn predicate_gate_ordering_haircut_before_ratio() {
        // Cheap-to-expensive ordering: haircut gate fires before ratio
        // gate. haircut_active = true → HaircutsActive.
        // exposure = 700_000 would also fail the ratio check if reached.
        assert_eq!(
            buyback_eligible(1_000_000, 700_000, 0, 100_000, true, 100_000),
            Err(BuybackBlocker::HaircutsActive),
        );
    }
}
