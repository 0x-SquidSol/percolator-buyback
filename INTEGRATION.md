# Integration Tracker

This document tracks where each piece of the buyback design lands in the live Percolator codebase. This proposal repo is the design home; actual code lands in the implementing repos via the steps below.

Entries are appended as each piece of work is identified during the design conversation; the list is complete only when all implementing repos have landed their work. Entries are ordered to match the rollout sequence in [PROPOSAL.md §11](PROPOSAL.md#11-design-decisions) — earlier entries land in the implementing repos before later ones, and later entries may reference earlier ones by repo name when work in one repo blocks another.

Each entry carries a Status line — one of **staged** (built and tested in this repo, awaiting transfer), **spec-ready** (described here in detail but not yet implemented anywhere), or **merged** (transferred to the destination repo, with the merge SHA recorded). When an entry transitions to merged, the Transfer record line is updated to follow the format `Transfer record: merged as <owner>/<repo>@<sha> on YYYY-MM-DD.` so divergence between the staging copy and the merged copy stays visible.

The choice between **staged** and **spec-ready** also tracks who writes the production code. **Staged** entries — pure libraries (math primitives) and off-chain services (TypeScript SDKs, keepers, indexers) — are written and tested here in this repo end-to-end; the integrator's job is to copy the files into the destination repo, wire up exports, and adapt to the destination's lint, formatting, and naming conventions (minor cleanup is expected per each entry's transfer instructions, the same caveat the math-crate entry already records). **Spec-ready** entries — on-chain Rust programs (the wrapper, the stake program) — are intrinsically tied to the destination crate's instruction enum, processor scaffolding, error types, and account-validation conventions; reproducing those scaffolds here would amount to forking the destination crate, so the integrator writes the production code in the destination repo with the prose entry as the blueprint. The presence or absence of a `crates/<name>-staging/` (or `packages/<name>-staging/`) path under the entry signals which side that entry sits on.

Each entry also has a free-form steps list and a verification block; the verification format is whatever is idiomatic for the target repo (`cargo` for Rust crates, devnet smoke-tests for services, fixture-decode tests for indexers). If the design changes after an entry is committed, the entry is updated in the same commit that touches PROPOSAL.md — entries must reflect the current design, not historical intent.

## `dcccrypto/percolator` (math crate)

**Status:** staged — awaiting transfer.

The buyback math primitives — gate parameters, gate-failure types, the market-exposure helper, and the eligibility predicate — land here as a new `buyback` module under `src/`. Pure Rust, no Solana dependencies, consumed downstream.

Steps:

1. Add the `buyback` module with the gate parameters from PROPOSAL.md §4 (`BUYBACK_PER_EVENT_BPS`, `BUYBACK_COOLDOWN_SECS`, `BUYBACK_TREASURY_FLOOR`) and the `BuybackBlocker` enum in canonical declaration order (gate-evaluation sequence, `MathOverflow` last): `CooldownActive`, `BelowTreasuryFloor`, `HaircutsActive`, `AutoPausedUnderStress`, `ReserveTopUpPending`, `ExposureBelowMinimum`, `MathOverflow` — this MUST match the SDK error-map order in the `dcccrypto/percolator-sdk` entry below.
2. Add a `market_exposure` helper that computes a single market's exposure under the formula in PROPOSAL.md §3 (used for the non-zero precondition and observability, not slice sizing or a solvency ratio — the slice is a flat bps of the treasury).
3. Add a `buyback_eligible` predicate that runs the gates from PROPOSAL.md §2 (cooldown, treasury floor, no active haircut, the non-zero-exposure precondition), evaluated per market against that market's own treasury and exposure, returning the bps-of-treasury slice. The 1.5× insurance ratio and the `BelowInsuranceFloor` / `RatioBelowThreshold` variants are dropped.
4. Add Kani harnesses for the boundary properties (no overflow, slice never breaches the treasury floor, monotonicity in treasury balance and time, fail-closed on pathological input). Deferred to integration time: `dcccrypto/percolator` hosts its Kani harnesses under `tests/` (`tests/proofs_v16*.rs`) with `[workspace.metadata.kani]` config in `Cargo.toml`, so the buyback harnesses land there (e.g. a new `tests/proofs_buyback.rs`) in the destination repo rather than here.

A reference implementation of steps 1–3 is staged in this repo at [`crates/buyback-staging/src/buyback.rs`](crates/buyback-staging/src/buyback.rs). The file is stdlib-only, with no Solana or crate-internal dependencies. To transfer, copy the file into `dcccrypto/percolator/src/buyback.rs` and add `pub mod buyback;` to that crate's lib root (`src/lib.rs`, per its `Cargo.toml [lib] path`), alongside the existing `mod v16;` and `mod wide_math;` declarations (the crate is `#![no_std]` and cfg-gates module visibility — match that idiom). Adapt to the receiving crate's lint, formatting, and error-prelude conventions before merging — minor cleanup is expected. Once merged, the staging copy is no longer authoritative; subsequent edits in either repo are mirrored to the other in a follow-up PR.

Caller-side adapter (handler concern, not file content): the handler wires `buyback_eligible` with the `BuybackTreasury` token-account balance (`amount`, a `u64`) as `treasury_balance` — no POD adapter needed. The exposure inputs still come from the engine: see the `maintenance_bps` field-mapping below.

Field-name mapping: when constructing `MarketView`, the staged field `maintenance_bps` is populated from the destination's `V16Config::maintenance_margin_bps` (`u64`, defined in `dcccrypto/percolator/src/v16.rs`). The staged field is `u64` to match the destination width directly, so the assignment is a plain field-init (`MarketView { maintenance_bps: risk.maintenance_margin_bps, ... }`) with no width adapter. The shorter staged name follows the surrounding `oi_eff_long_q` brevity convention.

Verification: steps 1–3 pass `cargo build`, `cargo test`, `cargo clippy -- -D warnings`, `cargo fmt -- --check`, and `cargo doc --no-deps` in the staging crate. Step 4's Kani harnesses are verified via `cargo kani --lib` once integrated upstream.

Transfer record: not yet merged.

## `dcccrypto/percolator-prog` (wrapper) — no change

**Status:** not applicable.

The protocol-fee-funded design removes the wrapper from the buyback's scope entirely. The buyback is funded from a `BuybackTreasury` (swept protocol-fee revenue) and never withdraws from the insurance fund, so the previously-planned permissionless `WithdrawForBuyback` instruction is **dropped** — and with it the `vault_auth`-CPI vault-drain surface. **Net wrapper change: zero.** See the design spec §6 and PROPOSAL.md §11 "Funding". (The funding instead reuses the wrapper's *existing*, audited maintenance-fee cranker path — no new wrapper code.)

## `dcccrypto/percolator-stake`

**Status:** spec-ready — not yet implemented.

The stake program hosts the buyback's funding setup, the `BuybackTreasury`, the gate logic, the persistent buyback state, and the two events that downstream services index. The funding reuses the wrapper's *existing*, audited maintenance-fee cranker path (a protocol-owned cranker portfolio swept into the treasury) — no new wrapper code, no insurance withdrawal. This entry depends only on the math crate (for `market_exposure`, `buyback_eligible`).

Steps:

1. Add a `BuybackState` PDA at seeds `[b"buyback_state", pool_pda]` (where `pool_pda = [b"stake_pool", slab_pubkey]`), holding `bump: u8`, `last_buyback_ts: i64`, `buyback_count: u64`, `drain_this_year: u64`, `last_year_reset_ts: i64`, plus the `settle_disabled` kill-switch flag (covered in step 6). The `bump: u8` field follows the destination's existing `StakePool` / `StakeDeposit` convention (`src/state.rs`). Locker rule: fields are append-only forever after this commit — never reorder, never resize, never repurpose reserved bytes.
2. Add the **funding setup** and the `BuybackTreasury`. Designate a protocol-owned portfolio as the maintenance-fee cranker recipient (the wrapper's existing separate-cranker path), raise the maintenance-fee increment so the protocol slice is strictly additive (design spec §4), and add a `BuybackTreasury` token account at seeds `[b"buyback_treasury", pool_pda]`, owned by the stake program, holding the market's quote/collateral mint. The protocol portfolio's accrued capital is swept into the treasury via the engine's normal `withdraw` path. One treasury per market; the engine's `credit_account_from_insurance_delta` firewall (already Kani-proven) guarantees the reward never touches staker-budgeted insurance.
3. Add a per-market `BuybackConfig` PDA at seeds `[b"buyback_config", pool_pda]` holding `token_mint`, `pool`, `lp_mint`, `pair_mint`, `amm_program_id`, and `amm_program_data_sha256`, written once by an **admin-gated** `BindBuybackConfig` instruction at market launch (the signer is authorized against the pool's stored admin) and immutable thereafter (a set-once pattern; the PDA is created squat-resistantly via the create-or-adopt path). `BindBuybackConfig` rejects a binding where `token_mint` equals the market's collateral mint or the `lp_mint` (the anti-reflexivity guard). The `amm_program_data_sha256` is the **admin-supplied pin** — the admin's client captures it and the bind handler stores it as-is; the handler does **not** read the live program-data account at bind (no ~270k-CU hash at bind time). Its job is to fail-close `settle_buyback`, which recomputes the live AMM program-data hash and rejects on drift (per PROPOSAL.md §11 "AMM upgrade authority"). A wrong pin is therefore a self-inflicted, drain-recoverable misconfiguration, never a fund risk; recovery from a stuck slice goes through `emergency_drain_treasury` (step 6).
4. Add `trigger_buyback`: permissionless instruction. Handler order is **resolve the market's `BuybackConfig` → reserve-first staker top-up (if the market carries an outstanding loss) → lazy-init `BuybackState` → math-crate gates against the treasury balance → reserve the slice inside the `BuybackTreasury` → stamp state**. No CPI to the wrapper; no insurance, vault, or LP account is touched. The lazy-init replaces a separate `InitBuyback` admin instruction — the first successful trigger pays rent for the PDA. The treasury balance feeds `buyback_eligible` as a plain `u64`; `V16Config::maintenance_margin_bps` populates `MarketView::maintenance_bps` per the field-mapping in the math entry.
5. Add `settle_buyback`: permissionless instruction the cranker calls after burning the LP receipt. Validates the round-trip claim against on-chain state and the market's bound pool (validation list below). Emits `LiquidityLocked` on success.
6. Add `emergency_drain_treasury`: returns a stranded reserved slice to the `BuybackTreasury` (a protocol problem, never a staker one — insurance is never involved). Callable only when `BuybackState.settle_disabled == 1`. The flag is **set only by program upgrade** — not by any runtime instruction — preserving PROPOSAL.md §1's "no admin off-switch on the gate." It is a code-level kill switch flipped exactly when AMM drift or another externality strands a slice and operator rescue is required.
7. Emit `BuybackTriggered` (after `trigger_buyback`'s state stamps) and `LiquidityLocked` (after `settle_buyback`'s validation). Each event is a single `sol_log_data` chunk of `[8-byte ASCII discriminator][field section]` — discriminator `BBTRIGv1` for `BuybackTriggered`, `BBLOCKv1` for `LiquidityLocked` (distinct from each other and from the account discriminators `BBST_V1\0` / `BBCF_V1\0`). The field layouts below are the data-section content (the bytes after the 8-byte discriminator); the SDK's `decodeBuybackEvent` matches the leading discriminator, strips it, and routes to the field-section decoder. Event field layouts are append-only from this commit forward — fields can be added at the tail in later commits but never reordered or removed.

   **`BuybackTriggered`** (in declaration order): `timestamp: i64` (Solana Clock unix_timestamp at trigger landing), `token_mint: Pubkey` (32 bytes; the market's bound buyback token), `treasury_balance_before: u64` (`BuybackTreasury` balance pre-event), `reserve_topup: u64` (amount credited to stakers by the reserve-first step), `slice: u64` (amount reserved for the round-trip), `market_exposure: u128` (Q-format exposure), `buyback_treasury: Pubkey` (32 bytes; the treasury account).

   **`LiquidityLocked`** (in declaration order): `token_mint: Pubkey` (32 bytes; the market's bound buyback token), `slice: u64` (original slice in collateral base units), `pair_acquired: u64` (pair-asset base units obtained from the convert leg, or the slice itself when no conversion), `token_bought: u64` (buyback token purchased on the bound pool, base units), `pair_paired: u64` (pair-asset base units paired for add-LP), `lp_tokens_burned: u64` (Token-2022 LP tokens destroyed), `pool_pubkey: Pubkey` (32 bytes; must equal the market's bound pool), `realized_token_per_pair: u128` (`token_bought × 10^12 / pair_paired`, Q12 ratio for downstream analytics; `u128::MAX` if `pair_paired == 0`).

Trigger-side contracts (in addition to the math crate's gate logic):

- **Market binding, not account counting.** The handler resolves the market's `BuybackConfig` PDA and reads the bound token/pool/pair from it; the binding is the trust root (set once at launch, immutable), so there is no cranker-supplied slab/pool to spoof. Each market is independent — launching another market needs only its own `BindBuybackConfig`, no upgrade.
- **Anti-reflexivity, re-checked at trigger.** Even though `BindBuybackConfig` enforces it at bind time, the handler re-asserts `BuybackConfig.token_mint != market_collateral_mint` at trigger, so a market never spends its treasury to buy its own collateral.
- **Clock from syscall, not account.** Use `Clock::get()` inside the handler. Do NOT accept a clock account in the instruction account list — a forgeable timestamp would bypass the cooldown gate.
- **Zero-slice no-stamp rule.** When `buyback_eligible` returns `Ok(0)` (treasury just above floor, slice truncates), the handler returns early WITHOUT stamping `last_buyback_ts` or the counters. PROPOSAL.md §5.1 requires this — there is no point burning a 24-hour cooldown slot on a zero-byte event.
- **Annual draw cap (defense-in-depth).** Optionally cap `drain_this_year + slice` at a fraction of the prior-year treasury inflow and return early on breach (the next eligible slot retries). Reset `drain_this_year = 0` when `now - last_year_reset_ts >= 31_536_000` (365 days). Since the treasury holds only protocol revenue, this is a guardrail to keep the per-event cap honest across a year, not a solvency control.
- **No staker-NAV impact.** The buyback spends only the `BuybackTreasury` (protocol-fee revenue) and never touches the stake pool's `total_pool_value()`, so staker NAV is unaffected by construction — the `total_buyback_spent` NAV surgery planned under the old insurance-skim model is **dropped**. The reserve-first step (step 4) only ever *raises* staker NAV: on a market loss it credits stakers toward a reserve target via a permissionless stake-side credit-to-NAV gated on a real token deposit (mirroring how `ReturnInsurance` / `RecoverFlushedInsurance` gate on actual token movement — `dcccrypto/percolator-stake/src/processor.rs`).

Settle-side validation list (each item is a hard reject; settle is the trust boundary for the entire round-trip):

1. `supplied_lp_mint_pubkey == BuybackConfig.lp_mint` (byte equality).
2. `lp_mint_account.owner == &spl_token_2022::ID` (program ownership).
3. `lp_mint_account.mint_authority == the bound pool's mint-authority PDA` — defends against a substituted mint with the same pubkey shape.
4. `lp_mint_account` extension list ⊆ allowed set (currently empty; runtime check, not deploy-time-only).
5. `lp_token_account.owner == &spl_token_2022::ID`.
6. `lp_token_account.mint == BuybackConfig.lp_mint`.
7. `lp_token_account.amount == 0` (the cranker's post-burn balance).
8. the `BuybackTreasury`'s reserved slice is fully consumed (treasury balance reconciles to the pre-event amount minus the slice).
9. `cranker.signed && lp_token_account.owner_field == cranker.key()`.
10. The cranker-supplied `round_trip_id: u64` is appended to BuybackState's ring buffer of recently-settled IDs (attribution only, not authentication).
11. **AMM binary sha pin.** The instruction account list takes one extra read-only account (`amm_program_data`, owned by `BPFLoaderUpgradeable`, derived from `BuybackConfig.amm_program_id`). The handler sha256s its bytes and asserts equality with `BuybackConfig.amm_program_data_sha256`. **Cost: ~270k CU** — the program-data account is ~200KB and sha256 over it is non-trivial; settle's CU budget must accommodate this leg. The owner check on the account is mandatory: without it, a cranker could supply a cranker-controlled account whose bytes happen to hash to the pinned value. An in-house AMM with renounced/multisig upgrade authority can derive the pool address and skip this leg.

Instruction tags: `BindBuybackConfig`, `TriggerBuyback`, `SettleBuyback`, and `EmergencyDrainTreasury` take the next free `StakeInstruction` discriminants after the current set. The highest in-use tag is no longer `SetMarketResolved = 18` — `BindInsuranceAuthority`/`RotateInsuranceAuthority` and the cooldown/admin instructions now occupy 19–23, so the buyback tags begin at 24. Verify the highest in-use tag has not advanced again before assigning.

Error codes: the math crate's gate-failure `BuybackBlocker` variants surface on-chain as `StakeError::Buyback*` = `ProgramError::Custom(28..34)` — the next-free `StakeError` block after the existing `0..27`, in the canonical `BuybackBlocker` order (`BuybackCooldownActive = 28` … `BuybackMathOverflow = 34`), held by a compile-time assertion. The off-chain keeper decodes them as `Custom(28 + discriminant)` (see the `dcccrypto/percolator-keeper` entry). Verify `28` is still next-free before assigning — the highest existing `StakeError` is `27` (`NoPendingCooldownProposal`).

Relationship to math: the math crate's `buyback_eligible` is called inside `trigger_buyback`'s gate sequence (against the treasury balance). It must be merged before any of the stake program's buyback commits are useful — until then, this entry stays at `spec-ready`. There is no wrapper dependency.

Verification: `cargo build`, `cargo test`, `cargo clippy -- -D warnings`, and `cargo fmt --check` against `dcccrypto/percolator-stake`, plus a devnet integration test that walks a slab through trigger → cranker LP burn (mocked) → settle, asserting both events and `BuybackState` transitions at each boundary.

Transfer record: not yet merged.

## `dcccrypto/percolator-sdk`

**Status:** staged — awaiting transfer.

The SDK additions cover the TypeScript surface every off-chain consumer (keeper, indexer, ops scripts) needs once the stake-program buyback ix lands: instruction encoders for the four new ix variants, PDA derivations for the three new pool-keyed addresses (`BuybackState`, `BuybackTreasury`, `BuybackConfig`), decoders for the two emitted events, and a TS mirror of the math crate's `BuybackBlocker` enum so structured logs surface gate-failure variants by name. Pure TypeScript; no Solana on-chain dependency. The destination conventions (ESM, Node ≥ 20, TS ^5.7.2 strict, `bigint | string` numeric inputs, `Uint8Array` outputs, single-byte instruction discriminator, pool-keyed subsidiary PDAs, `<Name>Args` interface + `encode<Name>(args)` function pairs) are mirrored exactly so the merge is copy-and-paste, not translation.

Steps:

1. Append four encoders to `src/solana/stake.ts`: `encodeStakeBindBuybackConfig`, `encodeStakeTriggerBuyback`, `encodeStakeSettleBuyback`, `encodeStakeEmergencyDrainTreasury`. Add four new keys to the existing `STAKE_IX` enum at the next available tag numbers; the highest in-use stake tag is now 23, so the staged values are `BindBuybackConfig = 24`, `TriggerBuyback = 25`, `SettleBuyback = 26`, `EmergencyDrainTreasury = 27` (the destination confirms before assigning, and the order is load-bearing — it must match the on-chain enum). There is no `WithdrawForBuyback` — the protocol-fee-funded design has no wrapper instruction, so the buyback never CPIs into the wrapper.
2. Append three PDA derivations to `src/solana/stake.ts`: `deriveBuybackState(pool, programId)`, `deriveBuybackTreasury(pool, programId)` (seeds `[b"buyback_treasury", pool]`), and `deriveBuybackConfig(pool, programId)`. All pool-keyed (`[seed_string, pool.toBytes()]`), matching destination's existing `deriveStakeVaultAuth` and `deriveDepositPda` conventions. At transfer, make `programId` optional with default `getStakeProgramId()` to match destination's existing PDA-helper signatures.
3. Add `src/events/buyback.ts` (or the destination's preferred event-parser path) with `decodeBuybackTriggered` and `decodeLiquidityLocked`. Field layouts are pinned in the stake-program entry above (step 7); the parsers consume the already-extracted event data section, no envelope.
4. Add `src/abi/errors/buyback.ts` (or append to `src/abi/errors.ts`) with the `BUYBACK_BLOCKER` const enum, `parseBuybackBlockerName(code)`, and `buybackBlockerCode(name)`. Variant order MUST match the math crate's `BuybackBlocker` declaration order — under the protocol-fee-funded design: `CooldownActive`, `BelowTreasuryFloor`, `HaircutsActive`, `AutoPausedUnderStress`, `ReserveTopUpPending`, `ExposureBelowMinimum`, `MathOverflow` (the `BelowInsuranceFloor` / `RatioBelowThreshold` variants are dropped) — the test in `buyback.test.ts` enforces this against the enum in `crates/buyback-staging/src/buyback.rs`.

A reference implementation of all four steps is staged in this repo at [`packages/sdk-staging/`](packages/sdk-staging/). The four production files under `src/` (`src/solana/stake-buyback.ts`, `src/events/buyback.ts`, `src/errors/buyback.ts`, plus `src/index.ts`) are what lands in the destination — see each file's header comment for its specific destination path. Everything else is verification-only scaffolding marked with header comments and does NOT cross over: `package.json`, `tsconfig.json`, `pnpm-lock.yaml`, `README.md`, the vendored `src/abi/encode.ts`, and the three `src/**/*.test.ts` vitest suites. The vendored `encode.ts` mirrors the destination's existing helper module so the staged source files can typecheck against the same primitives the destination uses; at transfer time the integrator's imports resolve to destination's own `encode.ts` and the staging copy is discarded. The vitest suites stay behind for the same reason the math-crate's `cargo test` suite stays behind: they prove the staged source is correct at the moment of transfer, then the destination writes its own tests against its own fixture infrastructure (destination's `test/` directory uses `tsx` + hand-rolled asserts, not vitest).

`STAKE_IX` merge recipe. The staged file declares its four tags in a separate `STAKE_IX_BUYBACK` const so the destination's `STAKE_IX` stays untouched until merge. To transfer:

1. Read the highest tag in `dcccrypto/percolator-stake/src/instruction.rs` (the `StakeInstruction` enum is the source of truth; `dcccrypto/percolator-sdk/src/solana/stake.ts` `STAKE_IX` mirrors it). The highest in-use tag is now 23 (`SetMarketResolved = 18`, with `BindInsuranceAuthority`/`RotateInsuranceAuthority` and the cooldown/admin instructions at 19–23); verify it has not advanced before picking new values.
2. In destination's `src/solana/stake.ts`, append four keys to the existing `STAKE_IX` const at the next sequential values: `BindBuybackConfig`, `TriggerBuyback`, `SettleBuyback`, `EmergencyDrainTreasury`. Declaration order is load-bearing — it must match the on-chain enum order added in the matching `dcccrypto/percolator-stake` PR.
3. In the merged `stake-buyback.ts` content, replace each `STAKE_IX_BUYBACK.<X>` reference with `STAKE_IX.<X>`. Expect exactly four call sites (one per encoder body); a post-replace grep for `STAKE_IX_BUYBACK` in the merged tree must return zero hits.
4. Delete the `STAKE_IX_BUYBACK` const declaration, its `Object.freeze(STAKE_IX_BUYBACK)` line, and the `Instruction tags — placeholder` header comment block immediately above them.

Caller-side notes (handler concern, not file content):

- **`programId` parameter shape.** Staged PDA helpers take `programId` as a required positional argument. Destination convention makes it optional with default `getStakeProgramId()` — match that pattern at transfer (single-line edit per helper).
- **Event-emission envelope.** Each event is one `sol_log_data` chunk of `[8-byte discriminator][field section]` (stake-program entry step 7). The field-section decoders (`decodeBuybackTriggered` / `decodeLiquidityLocked`) consume the data section after the discriminator; `decodeBuybackEvent` is the discriminator-routed wrapper — it takes a full chunk, matches `BBTRIGv1` / `BBLOCKv1`, strips the 8 bytes, and routes (returning `null` for an unrelated `Program data:` chunk so a mixed log stream can be scanned).

Verification: `npx tsc --noEmit` (lint via the destination's `tsc --noEmit` script) and `npx vitest run` (the encoder, PDA, error-map, and event-parser suites) pass in `packages/sdk-staging/`. Tests cover byte layout determinism, encoder boundaries (negative roundTripId, u64::MAX), PDA seed-string sentinels, event field-order regressions, and the realized-price ratio divide-by-zero saturation (`u128::MAX`). The staged SDK uses the protocol-fee-funded naming throughout — `EmergencyDrainTreasury`, `deriveBuybackTreasury` (seed `buyback_treasury`), the seven-variant treasury blocker set (with `BelowTreasuryFloor` / `AutoPausedUnderStress` / `ReserveTopUpPending`, and no insurance-ratio variants), and the `treasury_balance_before` / `reserve_topup` event fields — matching the on-chain `dcccrypto/percolator-stake` structs byte-for-byte. It also ships the full-account decoders (`decodeBuybackConfigAccount`, `decodeBuybackState`) and the discriminator-routed event decoder (`decodeBuybackEvent`).

Transfer record: not yet merged.

## `dcccrypto/percolator-keeper`

**Status:** staged — awaiting transfer.

The keeper additions cover the cranker's buyback path: an eligibility probe that simulates `trigger_buyback` and classifies the result, the idempotent round-trip state machine, and the AMM-upgrade integrity watch. Built and tested in [`packages/keeper-staging/`](packages/keeper-staging/); the integrator copies the `src/` files into the destination keeper (each file's header names its destination path). The keeper imports the buyback symbols from `@percolatorct/sdk` (the SDK entry above) — path-aliased to `sdk-staging` here, resolving to the real dep at the destination.

Steps:

1. `src/services/buyback.ts` — `probeEligibility`: builds a `trigger_buyback` simulation, classifies the `simulateTransaction` response into `would-fire` / `blocked` / `not-live` / `rpc-error`, and decodes the gate-failure reason. **Blocker decode is base-28:** the probe reads the structured `InstructionError` `Custom` code and maps `Custom(28 + discriminant)` → the `BuybackBlocker` name via the SDK's order-locked `parseBuybackBlockerName` (the on-chain `StakeError::Buyback*` block — see the stake-program entry). Reconfirm `28` is the base against the on-chain `error.rs` at transfer. The simulation's account list is stubbed until `trigger_buyback`'s canonical accounts land (the data byte is already real, from `encodeStakeTriggerBuyback`).
2. `src/lib/round-trip.ts` — the idempotent round-trip state machine (stages triggered → converted → bought → liquidity_added → lp_burned → settled; `pendingLeg` gives the resume point after a crash; `completeLeg` rejects out-of-order and re-completed legs — the anti-double-spend guard). Pure, no external dependency.
3. `src/lib/amm-integrity.ts` — `checkAmmIntegrity`: derives the AMM's ProgramData account, validates loader-owner + ProgramData variant, sha256s its bytes, and compares to `BuybackConfig.amm_program_data_sha256` (`intact` / `drifted` / `wrong-owner` / `malformed` / `missing` / `rpc-error`). The off-chain early-warning that mirrors the on-chain settle sha-pin; reads at `confirmed` commitment by default.

Per-file transfer notes: replace the staging `../lib/log.js` import with the destination's logger (`log.ts` is staging-only, with a post-transfer grep guard); the swap/submit legs (real account lists, PumpSwap/Jupiter shapes) are deferred until the on-chain handlers land.

Verification: `pnpm -C packages/keeper-staging lint` (`tsc --noEmit`) and `pnpm -C packages/keeper-staging test` (vitest) pass — the classifier outcomes, the state-machine transitions/guards, and the AMM-integrity verdicts are covered.

Transfer record: not yet merged.

## `dcccrypto/percolator-indexer`

**Status:** staged — awaiting transfer.

The indexer additions cover the buyback's observability (required at T+0 per the design): the per-market and protocol-wide metrics aggregator and the transaction-log → event router that feeds it. Built and tested in [`packages/indexer-staging/`](packages/indexer-staging/). The destination indexer is a Hono + Supabase service; only the **pure aggregation + decode logic** is staged — the HTTP / DB layer is destination-specific and is NOT mirrored. The aggregator consumes the buyback event types from `@percolatorct/sdk` (the SDK entry above).

Steps:

1. `src/aggregate.ts` — the metrics reducer over decoded events: cumulative LP-burned (the permanent-liquidity proxy), locked-liquidity base units (token + pair side), reserve-first top-ups credited to stakers, and trigger/settle counts, per market and protocol-wide. `bigint` throughout; `realized_token_per_pair` is never summed and its `u128::MAX` divide-by-zero sentinel is filtered via the SDK's `isRealizedTokenPerPairSentinel`.
2. `src/decode-logs.ts` — `decodeBuybackEventsFromLogs`: extracts each `Program data:` chunk from a transaction's logs, base64-decodes it, and routes through the SDK's `decodeBuybackEvent` (skipping non-buyback chunks). Feeds straight into `aggregate`. At the destination, wrap per-transaction so one corrupt event chunk cannot halt the pipeline.

Verification: `pnpm -C packages/indexer-staging lint` (`tsc --noEmit`) and `pnpm -C packages/indexer-staging test` (vitest) pass — the aggregation (incl. bigint precision and sentinel handling) and the log-routing are covered.

Transfer record: not yet merged.
