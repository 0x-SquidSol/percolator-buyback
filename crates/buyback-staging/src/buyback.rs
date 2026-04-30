//! Buyback parameters and gate-failure types.
//!
//! Constants and gate-failure types, no executable logic. Subsequent
//! commits add the cross-market exposure aggregator and the eligibility
//! predicate that consume these definitions.
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
    /// `checked_mul` returned `None` during the cross-multiply ratio
    /// comparison. Treated as a fail-closed condition; should be
    /// unreachable in practice but defends against pathological input.
    MathOverflow,
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
}
