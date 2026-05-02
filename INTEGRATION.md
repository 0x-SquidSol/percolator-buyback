# Integration Tracker

This document tracks where each piece of the buyback design lands in the live Percolator codebase. This proposal repo is the design home; actual code lands in the implementing repos via the steps below.

Entries are appended as each piece of work is identified during the design conversation; the list is complete only when all implementing repos have landed their work. Entries are ordered to match the rollout sequence in [PROPOSAL.md §11](PROPOSAL.md#11-design-decisions) — earlier entries land in the implementing repos before later ones, and later entries may reference earlier ones by repo name when work in one repo blocks another.

Each entry carries a Status line — one of **staged** (built and tested in this repo, awaiting transfer), **spec-ready** (described here in detail but not yet implemented anywhere), or **merged** (transferred to the destination repo, with the merge SHA recorded). When an entry transitions to merged, the Transfer record line is updated to follow the format `Transfer record: merged as <owner>/<repo>@<sha> on YYYY-MM-DD.` so divergence between the staging copy and the merged copy stays visible.

The choice between **staged** and **spec-ready** also tracks who writes the production code. **Staged** entries — pure libraries (math primitives) and off-chain services (TypeScript SDKs, keepers, indexers) — are written and tested here in this repo end-to-end; the integrator's job is to copy the files into the destination repo, wire up exports, and adapt to the destination's lint, formatting, and naming conventions (minor cleanup is expected per each entry's transfer instructions, the same caveat the math-crate entry already records). **Spec-ready** entries — on-chain Rust programs (the wrapper, the stake program) — are intrinsically tied to the destination crate's instruction enum, processor scaffolding, error types, and account-validation conventions; reproducing those scaffolds here would amount to forking the destination crate, so the integrator writes the production code in the destination repo with the prose entry as the blueprint. The presence or absence of a `crates/<name>-staging/` (or `packages/<name>-staging/`) path under the entry signals which side that entry sits on.

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

The wrapper hosts the per-slab insurance fund. Buyback adds one new permissionless instruction tag here so the stake program can withdraw a slice from the slab's insurance fund into the buyback pool ATA via CPI. The wrapper carries no economic logic — the four-condition gate from PROPOSAL.md §2 lives in the stake program, and the wrapper's new tag is a bare withdrawal under the `vault_auth` PDA's signature. This entry depends on the math crate above being merged first, since the stake program that calls into this tag pulls its gate logic from the math crate.

Steps:

1. Add a new permissionless instruction tag to the wrapper's instruction enum and dispatcher. The tag is appended at the end of the existing instruction set — never inserted between existing tags, and existing tags' dispatch numbers are unchanged. It accepts a CPI signed by the stake program's `vault_auth` PDA, takes a `slice: u64` argument, and forwards funds. The permissionless pattern follows the existing `handle_keeper_crank` precedent (`caller_idx == u16::MAX`) — copy that scaffolding rather than inventing a new signer model.
2. Validate at runtime: the signer is the stake program's `vault_auth` PDA (`[b"vault_auth", pool_pda]` where `pool_pda = [b"stake_pool", slab_pubkey]`); the destination ATA is the stake-program-owned buyback pool (per PROPOSAL.md §11 "Buyback pool custody — fresh PDA owned by the buyback-hosting program") holding the slab's collateral mint; the requested `slice` does not exceed the slab's `insurance_fund.balance`. Reject any CPI that fails these checks. Note that slab canonicity is the stake program's responsibility — the wrapper does not re-check the slab pubkey here.
3. Transfer the slice from the slab's insurance fund to the buyback pool ATA. The stake program has already computed and clamped the slice per PROPOSAL.md §5.1 before CPI'ing in; the wrapper does not re-compute or re-saturate. No gate logic — the stake program enforces the four-condition gate upstream.
4. Add integration tests against a mock stake-program PDA: positive path (CPI succeeds and the slice moves correctly), spoofed-signer rejection (CPI from a non-`vault_auth` PDA fails), wrong-mint rejection (destination ATA's mint differs from the slab's collateral mint), oversize-slice rejection (`slice > insurance_fund.balance`).

Relationship to `trigger_buyback`: the stake program's `trigger_buyback` instruction is the sole caller of this tag. When the wrapper rejects a CPI, the rejection bubbles up and aborts the stake-program instruction atomically — partial state changes do not land.

Verification: `cargo build`, `cargo test`, `cargo clippy -- -D warnings`, and `cargo fmt --check` against the wrapper crate, following whatever scaffolding `dcccrypto/percolator-prog` already uses for its existing instruction tests.

Transfer record: not yet merged.

## `dcccrypto/percolator-stake`

**Status:** spec-ready — not yet implemented.

The stake program hosts the buyback's gate logic, the persistent buyback state, the buyback pool ATA, and the two events that downstream services index. The stake program's `stake_pool` PDA is already the wrapper's admin (existing top-up / withdraw flows via `vault_auth` signing into `TopUpInsurance` / `WithdrawInsuranceLimited`), so adding the buyback CPI is the same architectural seam. This entry depends on the math crate (for `assert_per_slab_invariant`, `total_protocol_exposure`, `buyback_eligible`) and the wrapper (for `WithdrawForBuyback`) both being merged first.

Steps:

1. Add a `BuybackState` PDA at seeds `[b"buyback_state", pool_pda]` (where `pool_pda = [b"stake_pool", slab_pubkey]`), holding `bump: u8`, `last_buyback_ts: i64`, `buyback_count: u64`, `drain_this_year: u64`, `last_year_reset_ts: i64`, plus the `settle_disabled` kill-switch flag (covered in step 6). The `bump: u8` field follows the destination's existing `StakePool` / `StakeDeposit` convention (`src/state.rs`). Locker rule: fields are append-only forever after this commit — never reorder, never resize, never repurpose reserved bytes.
2. Add a buyback pool ATA at seeds `[b"buyback_pool", pool_pda]`, owned by the stake program, holding the slab's collateral mint. Per PROPOSAL.md §11 ("Buyback pool custody — fresh PDA owned by the buyback-hosting program") this is one ATA per pool, never shared. The pool-keyed seeding matches the destination's existing subsidiary-PDA convention (`vault_auth`, `stake_deposit` are also pool-keyed, not slab-keyed).
3. Add a constants module with `PUMPSWAP_PROGRAM_ID`, `CANONICAL_POOL`, `CANONICAL_LP_MINT`, `CANONICAL_SLAB`, and `PUMPSWAP_PROGRAM_DATA_SHA256`. The sha pin is captured from PumpSwap's program-data account at deploy time — its job is to fail-close `settle_buyback` if PumpSwap ships an upgraded binary (per PROPOSAL.md §11 "PumpSwap upgrade authority — single key, not renounced"). Recovery from a stuck slice goes through `emergency_drain_buyback_pool` (step 6).
4. Add `trigger_buyback`: permissionless instruction. Handler order is **canonical-slab check → lazy-init `BuybackState` → math-crate gates → CPI to wrapper → stamp state**. The lazy-init replaces a separate `InitBuyback` admin instruction — the first successful trigger pays rent for the PDA, so no admin step precedes the first event. Caller-side adapters from the math-crate entry above apply (`U128.get()` for `insurance_fund.balance` and `insurance_floor`; `RiskParams::maintenance_margin_bps` populates `MarketView::maintenance_bps`).
5. Add `settle_buyback`: permissionless instruction the cranker calls after burning the LP receipt. Validates the round-trip claim against on-chain state and the canonical PumpSwap pool (validation list below). Emits `LiquidityLocked` on success.
6. Add `emergency_drain_buyback_pool`: returns the buyback pool's contents to the slab insurance fund. Callable only when `BuybackState.settle_disabled == 1`. The flag is **set only by program upgrade** — not by any runtime instruction — preserving PROPOSAL.md §1's "no admin tunable that turns buybacks off." It is a code-level kill switch flipped exactly when PumpSwap drift or another externality strands a slice and operator rescue is required.
7. Emit `BuybackTriggered` (after `trigger_buyback`'s state stamps) and `LiquidityLocked` (after `settle_buyback`'s validation). On-the-wire serialization follows the destination's existing event-emission convention (the destination decides any tag-byte prefix, length framing, or program-data discriminator); the field layouts below are the data-section content. Event field layouts are append-only from this commit forward — fields can be added at the tail in later commits but never reordered or removed.

   **`BuybackTriggered`** (in declaration order): `timestamp: i64` (Solana Clock unix_timestamp at trigger landing), `fund_balance_before: u64` (slab insurance fund balance pre-withdrawal), `slice: u64` (amount withdrawn into the buyback pool), `total_protocol_exposure: u128` (Q-format exposure used in the ratio gate), `ratio_bps: u64` (`fund × 10_000 / exposure`, saturating to `u64::MAX` if `exposure == 0`), `buyback_pool: Pubkey` (32 bytes; destination ATA receiving the slice).

   **`LiquidityLocked`** (in declaration order): `slice_usdc: u64` (original slice in collateral base units), `sol_acquired: u64` (lamports bought via Jupiter), `perc_bought: u64` ($PERCOLATOR purchased on PumpSwap, base units), `sol_paired: u64` (lamports paired with $PERCOLATOR for add-LP), `lp_tokens_burned: u64` (Token-2022 LP tokens destroyed), `pool_pubkey: Pubkey` (32 bytes; must equal `CANONICAL_POOL`), `realized_perc_per_sol: u128` (`perc_bought × 10^12 / sol_paired`, Q12 ratio for downstream analytics; `u128::MAX` if `sol_paired == 0`).

Trigger-side contracts (in addition to the math crate's gate logic):

- **Canonical-slab check, not account counting.** The N=1 invariant is enforced via `slab.key() == CANONICAL_SLAB` (byte equality on the pubkey constant). Counting cranker-supplied accounts is spoofable; the pubkey check is not. When a second slab launches, the stake program MUST be upgraded — there is no on-chain path that re-enables buyback under multi-market without a binary upgrade.
- **Clock from syscall, not account.** Use `Clock::get()` inside the handler. Do NOT accept a clock account in the instruction account list — a forgeable timestamp would bypass the cooldown gate.
- **CPI signing seeds.** The CPI to the wrapper's `WithdrawForBuyback` is signed with `[b"vault_auth", pool_pda, &[vault_authority_bump]]` — the existing `vault_auth` PDA seeds and the existing `StakePool.vault_authority_bump` field, byte-for-byte the same as `FlushToInsurance`'s CPI to `TopUpInsurance` (per `dcccrypto/percolator-stake/src/cpi.rs`). The bump comes from `StakePool`, not from `BuybackState` — the buyback ix should not store its own copy. Mixing seeds (e.g., `b"vault"` + `slab` is the wrapper's INTERNAL seed, not the stake program's) breaks the CPI signature.
- **Zero-slice no-stamp rule.** When `buyback_eligible` returns `Ok(0)` (fund just above floor, proportional truncates), the handler returns early WITHOUT stamping `last_buyback_ts`, `buyback_count`, or `drain_this_year`. PROPOSAL.md §5.1.1 requires this — there is no point burning a 24-hour cooldown slot on a zero-byte event.
- **Annual drain hard cap (50%).** Before withdrawal, assert `drain_this_year + slice <= prior_year_fund_balance / 2`. On breach, return `BuybackError::AnnualDrainCapped` WITHOUT stamping cooldown (the next eligible slot retries). Reset `drain_this_year = 0` when `now - last_year_reset_ts >= 31_536_000` (365 days). This cap is NOT in PROPOSAL.md §11 — it is an implementation-side defense in depth that the stake program adds on top of the proposal's per-event cap.

Settle-side validation list (each item is a hard reject; settle is the trust boundary for the entire round-trip):

1. `supplied_lp_mint_pubkey == CANONICAL_LP_MINT` (byte equality).
2. `lp_mint_account.owner == &spl_token_2022::ID` (program ownership).
3. `lp_mint_account.mint_authority == derived_pumpswap_pool_pda` — defends against a substituted mint with the same pubkey shape.
4. `lp_mint_account` extension list ⊆ allowed set (currently empty; runtime check, not deploy-time-only).
5. `lp_token_account.owner == &spl_token_2022::ID`.
6. `lp_token_account.mint == CANONICAL_LP_MINT`.
7. `lp_token_account.amount == 0` (the cranker's post-burn balance).
8. `buyback_pool.amount == 0` (the slice has fully cycled out).
9. `cranker.signed && lp_token_account.owner_field == cranker.key()`.
10. The cranker-supplied `round_trip_id: u64` is appended to BuybackState's ring buffer of recently-settled IDs (attribution only, not authentication).
11. **PumpSwap binary sha pin.** The instruction account list takes one extra read-only account (`pumpswap_program_data`, owned by `BPFLoaderUpgradeable`, derived from `PUMPSWAP_PROGRAM_ID`). The handler sha256s its bytes and asserts equality with `PUMPSWAP_PROGRAM_DATA_SHA256`. **Cost: ~270k CU** — the program-data account is ~200KB and sha256 over it is non-trivial; settle's CU budget must accommodate this leg. The owner check on the account is mandatory: without it, a cranker could supply a cranker-controlled account whose bytes happen to hash to the pinned value.

Relationship to math + wrapper: math crate's `buyback_eligible` is called inside `trigger_buyback`'s gate sequence; wrapper's `WithdrawForBuyback` is CPI'd into immediately after the gates pass, signed by the `vault_auth` PDA. Both must be merged before any of the stake program's buyback commits are useful — until then, this entry stays at `spec-ready`.

Verification: `cargo build`, `cargo test`, `cargo clippy -- -D warnings`, and `cargo fmt --check` against `dcccrypto/percolator-stake`, plus a devnet integration test that walks a slab through trigger → cranker LP burn (mocked) → settle, asserting both events and `BuybackState` transitions at each boundary.

Transfer record: not yet merged.

## `dcccrypto/percolator-sdk`

**Status:** staged — awaiting transfer.

The SDK additions cover the TypeScript surface every off-chain consumer (keeper, indexer, ops scripts) needs once the stake-program buyback ix lands: instruction encoders for the three new ix variants, PDA derivations for the two new pool-keyed addresses, decoders for the two emitted events, and a TS mirror of the math crate's `BuybackBlocker` enum so structured logs surface gate-failure variants by name. Pure TypeScript; no Solana on-chain dependency. The destination conventions (ESM, Node ≥ 20, TS ^5.7.2 strict, `bigint | string` numeric inputs, `Uint8Array` outputs, single-byte instruction discriminator, pool-keyed subsidiary PDAs, `<Name>Args` interface + `encode<Name>(args)` function pairs) are mirrored exactly so the merge is copy-and-paste, not translation.

Steps:

1. Append three encoders to `src/solana/stake.ts`: `encodeStakeTriggerBuyback`, `encodeStakeSettleBuyback`, `encodeStakeEmergencyDrainBuybackPool`. Add three new keys to the existing `STAKE_IX` enum at the next available tag numbers (currently 19+); the staged values 19 / 20 / 21 are placeholders the destination assigns. `WithdrawForBuyback` is intentionally NOT exported — it is a wrapper-internal CPI target the stake program constructs via `invoke_signed`; a public TS encoder would let a cranker submit it directly and bypass the gate sequence.
2. Append two PDA derivations to `src/solana/stake.ts`: `deriveBuybackState(pool, programId)` and `deriveBuybackPool(pool, programId)`. Both pool-keyed (`[seed_string, pool.toBytes()]`), matching destination's existing `deriveStakeVaultAuth` and `deriveDepositPda` conventions. At transfer, make `programId` optional with default `getStakeProgramId()` to match destination's existing PDA-helper signatures.
3. Add `src/events/buyback.ts` (or the destination's preferred event-parser path) with `decodeBuybackTriggered` and `decodeLiquidityLocked`. Field layouts are pinned in the stake-program entry above (step 7); the parsers consume the already-extracted event data section, no envelope.
4. Add `src/abi/errors/buyback.ts` (or append to `src/abi/errors.ts`) with the `BUYBACK_BLOCKER` const enum, `parseBuybackBlockerName(code)`, and `buybackBlockerCode(name)`. Variant order MUST match the math crate's `BuybackBlocker` declaration order — the test in `buyback.test.ts` enforces this against `crates/buyback-staging/src/buyback.rs:88-114`.

A reference implementation of all four steps is staged in this repo at [`packages/sdk-staging/`](packages/sdk-staging/). The four production files under `src/` (`src/solana/stake-buyback.ts`, `src/events/buyback.ts`, `src/errors/buyback.ts`, plus `src/index.ts`) are what lands in the destination — see each file's header comment for its specific destination path. Everything else is verification-only scaffolding marked with header comments and does NOT cross over: `package.json`, `tsconfig.json`, `pnpm-lock.yaml`, `README.md`, the vendored `src/abi/encode.ts`, and the three `src/**/*.test.ts` vitest suites. The vendored `encode.ts` mirrors the destination's existing helper module so the staged source files can typecheck against the same primitives the destination uses; at transfer time the integrator's imports resolve to destination's own `encode.ts` and the staging copy is discarded. The vitest suites stay behind for the same reason the math-crate's `cargo test` suite stays behind: they prove the staged source is correct at the moment of transfer, then the destination writes its own tests against its own fixture infrastructure (destination's `test/` directory uses `tsx` + hand-rolled asserts, not vitest).

Caller-side notes (handler concern, not file content):

- **`programId` parameter shape.** Staged PDA helpers take `programId` as a required positional argument. Destination convention makes it optional with default `getStakeProgramId()` — match that pattern at transfer (single-line edit per helper).
- **Event-emission envelope.** The staged decoders take the data section already stripped of any tag-byte prefix or program-data discriminator the destination's event-emission helper applies. Whatever wrapping the destination uses, the keeper/indexer caller unwraps before invoking the parser. If the destination doesn't yet have an event-emission helper, this entry's transfer waits for one.
- **`STAKE_IX` numbering.** The placeholder tags 19 / 20 / 21 are not load-bearing. The destination assigns the next-available tags during merge; the encoder bodies need only the resolved discriminator value.

Verification: `npx tsc --noEmit` (lint via the destination's `tsc --noEmit` script) and `npx vitest run` (40 tests across encoders, PDAs, error map, event parsers) pass in `packages/sdk-staging/`. Tests cover byte layout determinism, encoder boundaries (negative roundTripId, u64::MAX), PDA seed-string sentinels, event field-order regressions, and divide-by-zero saturation values for `ratioBps` (`u64::MAX`) and `realizedPercPerSol` (`u128::MAX`).

Transfer record: not yet merged.
