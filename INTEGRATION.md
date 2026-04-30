# Integration Tracker

This document tracks where each piece of the buyback design lands in the live Percolator codebase. This proposal repo is the design home; actual code lands in the implementing repos via the steps below.

Entries are appended as each piece of work is identified during the design conversation; the list is complete only when all implementing repos have landed their work. Entries are ordered to match the rollout sequence in [PROPOSAL.md §11](PROPOSAL.md#11-design-decisions) — earlier entries land in the implementing repos before later ones, and later entries may reference earlier ones by repo name when work in one repo blocks another.

Each entry has a free-form steps list and a verification block; the verification format is whatever is idiomatic for the target repo (`cargo` for Rust crates, devnet smoke-tests for services, fixture-decode tests for indexers). If the design changes after an entry is committed, the entry is updated in the same commit that touches PROPOSAL.md — entries must reflect the current design, not historical intent.

## `dcccrypto/percolator` (math crate)

The buyback math primitives — constants, gate-failure types, exposure aggregator, and the eligibility predicate — land here as a new `buyback` module under `src/`. Pure Rust, no Solana dependencies, consumed downstream.

Steps:

1. Add the `buyback` module with the four hardcoded parameters from PROPOSAL.md §4 plus the launch-time `MAX_MARKETS_FOR_PER_SLAB = 1` invariant, and the `BuybackBlocker` enum covering the gate-failure modes.
2. Add a `total_protocol_exposure` helper that sums per-market exposure under the formula in PROPOSAL.md §3.
3. Add a `buyback_eligible` predicate that runs the four gates from PROPOSAL.md §2 (ratio, cooldown, insurance floor, no active haircut) plus the per-slab invariant check.
4. Add Kani harnesses for the boundary properties (no overflow, slice never breaches the insurance floor, monotonicity in fund balance and time, fail-closed on pathological input).

Verification: `cargo build`, `cargo clippy -- -D warnings`, `cargo test`, and `cargo fmt --all -- --check` all clean. Kani harnesses verified via `cargo kani --lib`.
