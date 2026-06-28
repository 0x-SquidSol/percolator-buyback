# Protocol-Fee-Funded Autonomous Buyback — Design

**Date:** 2026-06-28
**Status:** Design approved (pending spec review) — supersedes the funding model of `PROPOSAL.md` and the wrapper/stake withdrawal entries of `INTEGRATION.md`.
**Resolves:** Issue #1 (buyback insurance withdrawal vs. the wrapper's staker-protection / D-STAKE-1 model).
**Code anchors verified against:** wrapper `dcccrypto/percolator-prog @ 45ae22c` (`src/v16_program.rs`), `dcccrypto/percolator-stake @ c3edb7f` (`src/`), engine `dcccrypto/percolator` HEAD (`src/v16.rs`).

---

## 1. Why the original design is being replaced

The original buyback (PROPOSAL.md) skims a "surplus slice" from a market's **insurance fund**, buys the market's token, pairs it, adds permanent locked liquidity, and burns the LP. Issue #1 surfaced that the wrapper's `D-STAKE-1` guard blocks any direct drain of stake-backed insurance. Deeper research established a stronger, fatal problem for the new objective (**stakers must be kept whole, and the design must be the safest possible**):

1. **There is no non-staker money inside the insurance fund.** Each market's insurance is fully partitioned into per-authority domain budgets; the engine enforces `insurance_domain_budget_remaining_total <= header.insurance` (`v16.rs:5331-5332`) and budgets every fee inflow in the same instruction ("Finding-G" discipline), so unbudgeted surplus is normally `0`. The "1.5× ratio" the staged math crate gates on is **not** surplus over stakers — it is stakers having over-flushed; that excess is still recoverable staker principal.
2. **There is no protocol treasury anywhere on-chain.** No fee account, no protocol-owned vault. Trading fees are staker *yield* (`StakePool.total_fees_earned`, `state.rs:81-83`); flushed collateral is staker *principal* (`total_flushed - total_returned`, `state.rs:382-383`).
3. **The stake pool has no "house" account.** Every token in `total_pool_value()` (`state.rs:536-565`) is owed to a junior or senior staker. Any uncompensated reduction is, by the loss waterfall, a direct staker loss.

Therefore spending insurance and burning it into LP **cannot** keep stakers whole — by construction. Every healthy DeFi protocol funds buybacks the same way instead: from a protocol-fee cut that was **never owed to LPs** (GMX keeps 63–70% for LPs and buys back from the separate 27%; Jupiter JLP keeps 75%, buyback from the 25% protocol cut; Sky/Aave/Ethena gate on surplus above a reserve and pause under stress).

This design adopts that pattern, fitted to Percolator's engine.

---

## 2. Objective & constraints

**Primary objective:** keep insurance-LP stakers **whole** (in fact, *better* than whole — see the A-plus backstop), and be the **safest** possible design.

**Hard constraints:**
- The buyback authority must have **no instruction path** that can debit insurance, the stake vault, or any LP principal. (Provable invariant — §6.)
- Funding must be **additive** (a new charge on traders), never a re-slice of existing staker yield.
- Preserve the proposal's identity where it doesn't conflict with the above: **autonomous, permissionless to crank, no admin off-switch on the buyback gate**.

**Non-goals (YAGNI):** no new engine value-class / treasury bucket (high blast radius — would touch every conservation proof); no admin-tunable buyback gate; no cross-market aggregation.

---

## 3. Architecture & data flow

Five units, each independently testable:

```
traders ──maintenance fee──▶ engine ──cranker reward (fenced)──▶ Protocol Portfolio (capital)
                                                                        │ withdraw (normal path)
                                                                        ▼
                                                              BuybackTreasury PDA ──────────┐
                                                                        │                    │ (A-plus) top up
                                          gate: cooldown/health/        │ slice               ▼ staker insurance
                                          exposure/treasury-floor       │              market insurance reserve
                                                                        ▼                  (to target, on loss)
                                              convert ▶ buy token ▶ add LP ▶ burn LP receipt
                                                                        │
                                                                        ▼
                                                  BuybackTriggered / LiquidityLocked events
```

| Unit | Purpose | Interface | Depends on |
|------|---------|-----------|------------|
| **Revenue accrual** | Earn trader-paid protocol revenue, fenced from staker insurance | Existing `SyncMaintenanceFee` with a protocol-owned cranker portfolio (acct idx 2) | engine maintenance-fee/cranker path |
| **BuybackTreasury PDA** | Hold ONLY protocol-fee revenue; the sole spend source | program-owned token account at `[b"buyback_treasury", market]` | SPL Token |
| **Buyback program** | Gate + reserve-first + custody + mechanic orchestration | `BindBuybackConfig`, `TriggerBuyback`, `SettleBuyback`, `EmergencyDrainTreasury` | math gate, AMM, Token-2022 |
| **Keeper** | Crank maintenance fee; sweep to treasury; trigger; execute round-trip | off-chain | RPC, Jupiter/AMM |
| **Events feed** | On-chain observability | `BuybackTriggered`, `LiquidityLocked` | indexer |

---

## 4. Funding — the staker firewall

**Mechanism (reuses audited engine machinery, no new fee class):**

1. Designate a **protocol-owned portfolio** as the maintenance-fee cranker recipient — the separate-cranker path of `handle_sync_maintenance_fee` (`v16_program.rs:9475-9527`, account index 2), which carries the Finding-15 ownership check (`:9528`).
2. The maintenance fee is charged to traders per slot (`sync_account_fee_to_slot_not_atomic`), crediting `header.insurance` by `charged`. The wrapper routes `reward = charged × maintenance_cranker_fee_share_bps / 10_000` to the cranker portfolio via `credit_account_from_insurance_not_atomic` (`v16_program.rs:9504-9511`), and `retained = charged − reward` to asset-0 staker insurance (`:9517-9522`).
3. **The firewall:** `credit_account_from_insurance_delta` (`v16.rs:7659-7664`) rejects the reward credit if it would push `header.insurance` below `insurance_domain_budget_remaining_total` (`LockActive`). Combined with the `:5331-5332` invariant, the reward can **only** be paid from the freshly-charged, not-yet-budgeted surplus — it can **never** reach staker-budgeted insurance. There is already a Kani harness for this (`v16.rs:7674`).

**Staker-neutrality rule:** to make the protocol slice strictly additive, **raise** `maintenance_fee_per_slot` and set `maintenance_cranker_fee_share_bps` so the *increment* accrues to the protocol portfolio, leaving the staker `retained` flow at its current absolute level. (Re-routing a larger share of the *existing* fee would take from stakers and is prohibited.)

**Sweep:** the protocol portfolio's accrued `capital` is withdrawn via the engine's normal `withdraw` path into `BuybackTreasury`. This is the only money the buyback ever spends.

**Caveat to record:** `maintenance_fee_per_slot` / `maintenance_cranker_fee_share_bps` are admin-set (`handle_update_maintenance_fee_policy`, `v16_program.rs:10440`). The *funding rate* is therefore governance policy (standard — every protocol governs its fee switch). The *buyback gate* remains hardcoded with no admin off-switch.

---

## 5. The gate — A-plus reserve-first waterfall

On each `TriggerBuyback` (permissionless crank), in order:

1. **Reserve-first (the backstop).** If the market carries an outstanding insurance loss, the treasury **first** credits stakers toward a reserve target (the protocol fund acts as a junior buffer *above* stakers — Ethena/Sky pattern), and only the remainder is eligible for buyback. This makes stakers *better* than whole. **Top-up route (open — §10):** the cleanest is a treasury→stake-pool-vault transfer credited as NAV (a new stake "donation"/`total_returned`-style counter), which needs no wrapper `insurance_authority` and only ever *raises* `total_pool_value()`; topping up the wrapper insurance fund directly would require the bound authority and is not preferred.
2. **Health / auto-pause.** Block when a haircut is active on the market or the market is otherwise distressed; route the fee to the staker reserve instead. (No buyback while stakers are exposed.)
3. **Economic gate (hardcoded, no admin off-switch).** Reuse the staged `buyback_eligible` shape (`crates/buyback-staging/src/buyback.rs`) but feed it the **treasury balance**, not insurance: 24h cooldown, treasury above a floor, exposure > 0, and the per-event slice cap (e.g. bps of treasury). `Ok(0) ⇒ early-return, no cooldown stamp`.

Notes: the `BelowInsuranceFloor`/ratio-vs-insurance variants from the staged enum are dropped; the gate now reasons about the treasury and the staker-reserve target, not the insurance fund.

---

## 6. Custody & the provable invariant

- `BuybackTreasury` is a program-owned PDA at `[b"buyback_treasury", market]`, holding only protocol-fee revenue (the swept cranker rewards).
- **Invariant (Kani-provable, the formal statement of "stakers made whole"):** the buyback program exposes no instruction whose authority can debit insurance, the stake vault, the LP mint, or any staker-owned account. It can debit **only** `BuybackTreasury`. The reserve-first top-up moves value *into* staker insurance, never out.
- **Delete `WithdrawForBuyback`.** The buyback never signs as the stake `vault_auth` PDA and never CPIs into the insurance fund, so the C6/C7 unvalidated-`token_program` vault-drain class (`percolator-stake/docs/AUDIT.md`) is structurally absent. The inert wrapper tag is removed; the planned permissionless wrapper instruction is **not** added. **Net wrapper change for the buyback: zero.**

---

## 7. The mechanic — buy → pair → add-LP → burn

- 3-transaction round-trip (convert → buy + add-LP + LP-burn → settle), permissionless settle, irregular schedule, per-leg slippage caps; the pool deepens each event.
- **AMM choice — recommend in-house AMM.** It eliminates the *only* Critical risk (external upgrade authority), drops a swap leg (pair in collateral), removes the ~270k-CU program-data sha-pin at settle, and lets us fix the LP mint's Token-2022 extension set. If an external AMM (e.g. PumpSwap) is used in the interim: keep the program-data sha256 pin **with** the mandatory `BPFLoaderUpgradeable` owner-check, and `EmergencyDrainTreasury`.
- **Stuck-slice recovery is now a protocol problem, not a staker problem.** A mid-flight failure strands *treasury* funds; `EmergencyDrainTreasury` returns them to the treasury. Insurance is never involved.
- Settle-side validation (token-2022 LP-burn proof) carries over from INTEGRATION.md's list, retargeted at the treasury/bound-pool: `lp_mint == BuybackConfig.lp_mint`, owner == Token-2022, `mint_authority == bound pool PDA`, extension-list ⊆ allowlist (runtime), `lp_token_account.amount == 0`, `treasury post-balance` consistent, cranker signs.

---

## 8. Events, errors, testing

- **Events (append-only):** `BuybackTriggered { timestamp, token_mint, treasury_balance_before, reserve_topup, slice, market_exposure, buyback_treasury }`, `LiquidityLocked { token_mint, slice, pair_acquired, token_bought, pair_paired, lp_tokens_burned, pool_pubkey, realized_token_per_pair }`.
- **Errors:** trimmed `BuybackBlocker` — drop `BelowInsuranceFloor`; keep `CooldownActive`, `HaircutsActive`, `ExposureBelowMinimum`, `MathOverflow`; add `BelowTreasuryFloor`, `AutoPausedUnderStress`, `ReserveTopUpPending`.
- **Testing:**
  - **Kani:** the firewall invariant (buyback can only debit treasury) + the existing `credit_account_from_insurance_delta` proof remains the basis of staker-safety.
  - **LiteSVM e2e:** accrue maintenance fee to protocol portfolio → withdraw to treasury → (loss case) reserve top-up → trigger → buy/add-LP/burn → settle; assert staker `total_pool_value()` is non-decreasing across the whole sequence.
  - **Adversarial:** spoofed cranker recipient (Finding-15), attempts to point any buyback debit at insurance/vault/LP, AMM upgrade mid-flight, treasury-drain via wrong dest, zero-slice no-stamp.

---

## 9. Delta vs. existing staged work

- **Keep / adapt:** the math gate crate (retarget at treasury), the SDK encoder/PDA/event scaffolding (rename insurance→treasury, drop `WithdrawForBuyback` — already correctly not exported), the keeper round-trip.
- **Drop:** the entire `dcccrypto/percolator-prog` (wrapper) INTEGRATION entry; the insurance-skim funding model; the `total_buyback_spent` NAV-surgery on `StakePool` (no longer needed — the buyback never touches the pool).
- **Add:** the protocol-cranker-portfolio funding setup; `BuybackTreasury` PDA + sweep; the A-plus reserve-first top-up; the in-house-AMM (or pinned-external) mechanic.

---

## 10. Open questions / risks to resolve in planning

1. **Reserve target definition + top-up mechanism** (A-plus): per-market absolute, or a function of OI/exposure? Needs (a) a concrete formula, (b) a source for "outstanding loss" the buyback program can read (the stake pool's `total_flushed - total_returned` vs. a wrapper read), and (c) the exact top-up instruction/counter (recommended: a permissionless stake-side "donate-to-NAV" credit gated on a real token deposit, mirroring how `ReturnInsurance`/`RecoverFlushedInsurance` gate `total_returned` on actual token movement — `processor.rs:3112-3124`).
2. **Where the buyback program reads market health** (haircut-active, exposure) — same oracle/mark helper as the matcher to avoid divergence.
3. **In-house AMM timeline** — ship pinned-external first, or block on the in-house AMM? Determines whether the sha-pin leg is needed at all.
4. **Governance** for the maintenance-fee increment (who sets it, how it's disclosed prospectively to stakers/traders).
5. **Confirm** the engine rev the deployed wrapper is built against matches the clone used here (the wrapper pins the engine as a path dep, not a git rev).

---

## References

- Engine firewall: `v16.rs:7649-7717` (credit-from-surplus + guard), `v16.rs:5331-5332` (partition invariant), `v16.rs:7674` (Kani harness).
- Funding path: `v16_program.rs:9460-9527` (`handle_sync_maintenance_fee`), `:9504-9522` (reward/retained split), `:10440` (fee policy, admin-set).
- Staker accounting: `state.rs:536-565` (`total_pool_value`), `:380-405` (`effective_junior_balance`), `:304-324` (`realized_junior_loss` / conservation).
- D-STAKE-1 (now moot): `v16_program.rs:9085-9100`.
- Comparables: GMX rewards split, Jupiter JLP/Litterbox, Sky Smart Burn Engine (`vow.hump`), Aave buy-&-distribute (≥2× OPEX runway), Ethena reserve-first + APY floor.
