//! Buyback parameters, gate-failure types, and cross-market exposure
//! aggregator.
//!
//! Constants, gate-failure types, and the pure exposure helper. The
//! eligibility predicate that consumes them lands in a follow-up commit.
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
/// Each variant maps to a distinct on-chain failure mode, returned by the
/// eligibility predicate added in a follow-up commit. Keeping these as an
/// enum (vs. string errors) lets callers distinguish steady-state cooldown
/// from anomalous gate failures without parsing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuybackBlocker {
    /// `fund × DEN` < `exposure × NUM`. The insurance fund is not
    /// over-collateralized enough relative to current protocol exposure.
    RatioBelowThreshold,
    /// Less than [`BUYBACK_COOLDOWN_SECS`] since the previous successful
    /// trigger.
    CooldownActive,
    /// Insurance fund balance is at or below the admin-set
    /// `insurance_floor`.
    BelowInsuranceFloor,
    /// One or more markets are currently paying haircut on positive PnL,
    /// indicating the protocol is in a stressed regime.
    HaircutsActive,
    /// Live market count exceeds [`MAX_MARKETS_FOR_PER_SLAB`]. The
    /// per-slab implementation's premise no longer holds; a program
    /// upgrade must migrate to global aggregation before buybacks can
    /// resume.
    MultiMarketRequiresGlobalAggregation,
    /// A `checked_*` arithmetic operation returned `None` — either while
    /// aggregating per-market exposure or while running the cross-multiply
    /// ratio comparison. Treated as a fail-closed condition; should be
    /// unreachable in practice but defends against pathological input.
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
/// saturating. This is fail-closed: the eligibility predicate that
/// consumes this value treats `MathOverflow` as a gate failure, so the
/// buyback does not fire when an aggregation step lost precision.
///
/// Returns `Ok(0)` for an empty market list.
#[inline]
pub fn total_protocol_exposure(markets: &[MarketView]) -> Result<u128, BuybackBlocker> {
    let mut total: u128 = 0;
    for m in markets {
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
        total = total
            .checked_add(market_exposure)
            .ok_or(BuybackBlocker::MathOverflow)?;
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Locks the cross-multiplication convention against accidental future
    /// edits. If this test ever fails, the gate's comparison direction may
    /// have silently inverted.
    #[test]
    fn ratio_threshold_constants_lock() {
        assert_eq!(BUYBACK_RATIO_THRESHOLD_NUM, 15);
        assert_eq!(BUYBACK_RATIO_THRESHOLD_DEN, 10);
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
    }
}
