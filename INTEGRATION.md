# Integration Tracker

This document tracks where each piece of the buyback design lands in the live Percolator codebase. This proposal repo is the design home; actual code lands in the implementing repos via the steps below.

Entries are appended as each piece of work is identified during the design conversation; the list is complete only when all implementing repos have landed their work. Entries are ordered to match the rollout sequence in [PROPOSAL.md §11](PROPOSAL.md#11-design-decisions) — earlier entries land in the implementing repos before later ones, and later entries may reference earlier ones by repo name when work in one repo blocks another.

Each entry carries a Status line — one of **staged** (built and tested in this repo, awaiting transfer), **spec-ready** (described here in detail but not yet implemented anywhere), or **merged** (transferred to the destination repo, with the merge SHA recorded). When an entry transitions to merged, the Transfer record line is updated to follow the format `Transfer record: merged as <owner>/<repo>@<sha> on YYYY-MM-DD.` so divergence between the staging copy and the merged copy stays visible.

Each entry also has a free-form steps list and a verification block; the verification format is whatever is idiomatic for the target repo (`cargo` for Rust crates, devnet smoke-tests for services, fixture-decode tests for indexers). If the design changes after an entry is committed, the entry is updated in the same commit that touches PROPOSAL.md — entries must reflect the current design, not historical intent.

## `dcccrypto/percolator` (math crate)

**Status:** staged — awaiting transfer.

The buyback math primitives — constants, gate-failure types, exposure aggregator, and the eligibility predicate — land here as a new `buyback` module under `src/`. Pure Rust, no Solana dependencies, consumed downstream.

Steps:

1. Add the `buyback` module with the four hardcoded parameters from PROPOSAL.md §4 plus the launch-time `MAX_MARKETS_FOR_PER_SLAB = 1` invariant, and the `BuybackBlocker` enum covering the gate-failure modes.
2. Add a `total_protocol_exposure` helper that sums per-market exposure under the formula in PROPOSAL.md §3.
3. Add a `buyback_eligible` predicate that runs the four gates from PROPOSAL.md §2 (ratio, cooldown, insurance floor, no active haircut), plus a sibling `assert_per_slab_invariant` that the handler calls before the predicate to enforce the per-slab N=1 premise.
4. Add Kani harnesses for the boundary properties (no overflow, slice never breaches the insurance floor, monotonicity in fund balance and time, fail-closed on pathological input). Deferred to integration time: `dcccrypto/percolator` already hosts the `kani-proofs/` infrastructure, so harnesses land alongside the file in the destination repo rather than here.

A reference implementation of steps 1–3 is staged in this repo at [`crates/buyback-staging/src/buyback.rs`](crates/buyback-staging/src/buyback.rs). The file is stdlib-only, with no Solana or crate-internal dependencies. To transfer, copy the file into `dcccrypto/percolator/src/buyback.rs` and add `pub mod buyback;` to that crate's lib root (`src/percolator.rs`, per its `Cargo.toml [lib] path`), alongside the existing `pub mod i128;` and `pub mod wide_math;` declarations. Adapt to the receiving crate's lint, formatting, and error-prelude conventions before merging — minor cleanup is expected. Once merged, the staging copy is no longer authoritative; subsequent edits in either repo are mirrored to the other in a follow-up PR.

Caller-side adapter (handler concern, not file content): the handler that wires `buyback_eligible` reads the insurance fund balance as `InsuranceFund::balance: U128` — a BPF-alignment wrapper, not `u128`. Adapt with `insurance_fund.balance.get()` to obtain `u128`, then narrow to `u64` via `u64::try_from(...)` (not `as u64`); the `try_from` failure is a fail-closed `MathOverflow` path. Same treatment for `insurance_floor` if it carries `U128`.

Field-name mapping: when constructing `MarketView`, the staged field `maintenance_bps` is populated from the destination's `RiskParams::maintenance_margin_bps` (defined in `dcccrypto/percolator/src/percolator.rs`). The staged field is `u64` to match the destination width directly, so the assignment is a plain field-init (`MarketView { maintenance_bps: risk.maintenance_margin_bps, ... }`) with no width adapter. The shorter staged name follows the surrounding `oi_eff_long_q` brevity convention.

Verification: steps 1–3 pass `cargo build`, `cargo test`, `cargo clippy -- -D warnings`, `cargo fmt -- --check`, and `cargo doc --no-deps` in the staging crate. Step 4's Kani harnesses are verified via `cargo kani --lib` once integrated upstream.

Transfer record: not yet merged.

## `dcccrypto/percolator-prog` (wrapper)

**Status:** spec-ready — not yet implemented.

The wrapper hosts the per-slab insurance fund. Buyback adds one new permissionless instruction tag here so the vault can withdraw a slice from the slab's insurance fund into the buyback pool ATA via CPI. The wrapper carries no economic logic — the four-condition gate from PROPOSAL.md §2 lives in the vault, and the wrapper's new tag is a bare withdrawal under the vault PDA's signature. This entry depends on the math crate above being merged first, since the vault that calls into this tag pulls its gate logic from the math crate.

Steps:

1. Add a new permissionless instruction tag to the wrapper's instruction enum and dispatcher. The tag is appended at the end of the existing instruction set — never inserted between existing tags, and existing tags' dispatch numbers are unchanged. It accepts a CPI from the vault PDA, takes a `slice: u64` argument, and forwards funds. The permissionless pattern follows the existing `handle_keeper_crank` precedent (`caller_idx == u16::MAX`) — copy that scaffolding rather than inventing a new signer model.
2. Validate at runtime: the signer is the vault authority PDA derived from the slab; the destination ATA is the vault-derived buyback pool (per PROPOSAL.md §11 "Buyback pool custody — fresh PDA owned by the vault program") holding the slab's collateral mint; the requested `slice` does not exceed the slab's `insurance_fund.balance`. Reject any CPI that fails these checks. Note that slab canonicity is the vault's responsibility — the wrapper does not re-check the slab pubkey here.
3. Transfer the slice from the slab's insurance fund to the buyback pool ATA. The vault has already computed and clamped the slice per PROPOSAL.md §5.1 before CPI'ing in; the wrapper does not re-compute or re-saturate. No gate logic — the vault enforces the four-condition gate upstream.
4. Add integration tests against a mock vault PDA: positive path (CPI succeeds and the slice moves correctly), spoofed-signer rejection (CPI from a non-vault PDA fails), wrong-mint rejection (destination ATA's mint differs from the slab's collateral mint), oversize-slice rejection (`slice > insurance_fund.balance`).

Relationship to `trigger_buyback`: the vault's `trigger_buyback` instruction is the sole caller of this tag. When the wrapper rejects a CPI, the rejection bubbles up and aborts the vault instruction atomically — partial state changes do not land.

Verification: `cargo build`, `cargo test`, `cargo clippy -- -D warnings`, and `cargo fmt --check` against the wrapper crate, following whatever scaffolding `dcccrypto/percolator-prog` already uses for its existing instruction tests.

Transfer record: not yet merged.
