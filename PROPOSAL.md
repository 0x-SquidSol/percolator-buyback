# Autonomous Buyback Proposal

A design and reference implementation for a protocol-funded buyback that runs **per market**: each market funds a buyback of its own token from a protocol-fee increment held in a per-market treasury, buys that token, pairs it with the market's quote asset, adds the pair to that token's pool, and burns the LP receipt tokens — permanently locking that liquidity. Implementation lands across `percolator` (math gate), `percolator-stake` (funding, treasury, gate, events), `percolator-sdk`, `percolator-keeper`, and `percolator-indexer`. The wrapper (`percolator-prog`) is unchanged.

> **Funding, gate, and custody are governed by the approved design spec** — [`docs/superpowers/specs/2026-06-28-protocol-fee-funded-buyback-design.md`](docs/superpowers/specs/2026-06-28-protocol-fee-funded-buyback-design.md) (resolves issue #1). The buyback is funded by an **additive protocol-fee increment** swept into a `BuybackTreasury` PDA — **never** by skimming the insurance fund, which is entirely staker principal with no protocol "house" money on-chain. Insurance-LP stakers are kept whole (better than whole, via a reserve-first backstop), enforced by an already-Kani-proven engine firewall, and the buyback program can debit only its treasury. Where sections below describe an insurance-fund "surplus slice" or the 1.5× insurance ratio, **the spec governs**; this document retains the per-market mechanic, the exposure formula (now used for the non-zero precondition, health, and observability — not slice sizing or a solvency ratio), observability, and rationale.

This document uses the $PERCOLATOR market as its running example, but the mechanism is per-market and per-token: every market binds its own token mint, pool, LP mint, and pair asset once at launch, and the buyback evaluates each market independently against that market's own treasury and exposure. For the $PERCOLATOR market the buyback is the supply-side counterpart to the locker's demand-side fee discount.

The hardcoded gate parameters are decided. Plumbing details — per-market binding, cranker authority, treasury custody, pool address, funding setup — are settled in §11 and the design spec against the live `percolator-stake` code.

## 1. Goal

- **Permanent liquidity over years**, not over weeks. The buyback's job is to convert protocol-fee revenue into permanent on-chain liquidity at a rate the protocol can comfortably support, indefinitely.
- **Stakers kept whole — in fact, better than whole.** The buyback spends only protocol revenue that was never owed to insurance-LP stakers, and on a market loss it tops stakers up toward a reserve target *before* buying back. No staker principal is ever spent; an already-Kani-proven engine firewall makes this an invariant.
- **No staker subsidy.** Every dollar of cost — the pair leg included — comes out of the buyback's own treasury, which holds only the protocol-fee increment. Insurance, the stake vault, and LP principal are never touched.
- **Hardcoded gate.** The buyback gate parameters are hardcoded in the same spirit as the locker's `MIN_TIER_BRONZE` floor — no admin tunable turns the gate off or up. (The funding *rate* — the maintenance-fee increment — is governance policy, like every protocol's fee switch.)
- **Fully autonomous.** A permissionless cranker observes on-chain state, the program checks the gate, and either fires or no-ops. No multisig, no human in the loop.

The buyback is not a price-support mechanism and should not be marketed as one. It is a sink funded by protocol-fee revenue, returning that revenue to the token holder base via permanent locked liquidity in the market's bound pool.

### Non-goals

Calling these out so the design conversation does not drift:

- **Not a yield product.** LP fees from the locked pool stay in the pool — they are not redistributed to lockers, stakers, or the protocol. The economic benefit is depth and out-of-circulation supply; anyone holding $PERCOLATOR shares it pro-rata.
- **Not a defense mechanism.** The buyback does not activate during volatility, drawdowns, or governance events. It activates on a fixed cadence from accrued protocol-fee revenue — a schedule that is by definition uncorrelated with short-term price action.
- **A single-purpose treasury, not a war chest.** The `BuybackTreasury` holds only the protocol-fee increment and exists only to fund buybacks and the reserve-first staker top-up; no instruction can redirect it elsewhere. It is not a general protocol balance.
- **Not retroactive.** There is no plan to "make up for" missed events if the cranker stalls or the protocol ships the feature late. Each 24h slot is fire-or-forfeit.
- **Not pure burn.** Bought tokens are NOT destroyed via SPL `Burn` — they are deposited as one side of an LP position whose receipt tokens are burned. Effect on freely-tradeable supply is equivalent (locked tokens cannot be sold by anyone), but the on-chain narrative is "permanent liquidity," not "destroyed supply."

## 2. The Gate

A buyback fires for a market only when **all** of these conditions are simultaneously true, each evaluated against that market's own treasury and exposure. Any single failure → no-op for this slot. (The "insurance fund / 1.5× ratio" framing in earlier drafts is superseded by the design spec — the buyback reasons about its treasury and a staker-reserve target, never the insurance fund.)

### 2.1 Reserve-first backstop — stakers credited before any buyback

- If the market carries an outstanding insurance loss, the treasury **first** credits stakers toward a reserve target — the protocol fund acts as a junior buffer *above* stakers (the Ethena/Sky pattern) — and only the remainder is eligible for a buyback.
- This is what makes stakers *better* than whole: protocol revenue absorbs market losses ahead of staker principal.
- The reserve-target formula and the top-up route (a permissionless stake-side credit-to-NAV gated on a real token deposit) are settled in the design spec (its §10).
- Only what survives the reserve top-up reaches the economic gate below.

### 2.2 Cooldown gate — `now ≥ last_buyback_ts + 24h`

- At most one buyback event per 24h rolling window.
- Caps how fast the fund can be drained even under sustained surplus.
- Bounds the cadence so a transient condition cannot trigger two events in quick succession; the cooldown is the single source of truth on timing.
- Bounds the cranker's market footprint at the daily level: at most one swap of `BUYBACK_PER_EVENT_BPS` size hits the AMM per day from this source.
- Single source of truth: `last_buyback_ts` is updated atomically inside the trigger handler, so concurrent crankers cannot double-fire.

### 2.3 Treasury-floor gate — `treasury_balance > treasury_floor`

- The buyback fires only while the `BuybackTreasury` is above a small floor, so a near-empty treasury does not churn dust round-trips.
- The slice is a per-event cap (basis points) of the treasury balance; saturating math never spends below the floor.
- The treasury holds only the protocol-fee increment, so this gate — and every other — operates entirely outside the insurance fund and staker accounting.

### 2.4 Stress gate — `haircut_ratio() == 1.0`

- The market must currently be paying its LPs 100% of what they're owed. If that market's haircuts are active, the market is under stress and no buyback is appropriate — the fee accrues to the staker reserve instead. The gate is per-market: a healthy market is not blocked by another market's stress (matching the per-market treasury and exposure).
- This is the strongest gate: it short-circuits the entire pipeline the moment the market enters a stressed regime, even if cooldown would otherwise allow firing.
- Equality is deliberate. `haircut_ratio() == 1.0` means "no haircut active right now," not "no haircut in the last N blocks." A stress that has just resolved still passes — the reserve-first step (§2.1) handles the residual.
- The gate reads from the same haircut accounting the protocol already uses to socialize losses; no new state.

### 2.5 Exposure precondition — `market_exposure > 0`

- The buyback only fires on a market with live open interest. A market with zero exposure is not a real, traded market, and there is no reason to spend its treasury on liquidity for a token nobody is trading yet.
- The handler requires a non-zero exposure, returning `ExposureBelowMinimum` otherwise. Exposure also feeds the indexer and the health surface, but it does **not** size the slice (a flat bps of the treasury — §5.1) and is no longer part of a solvency ratio.
- This matters most for a newly launched market: it must accrue real open interest before its treasury is spent.

In the handler the reserve-first step (§2.1) runs first — it credits stakers and sets the remainder the rest of the gate sees — and the remaining economic gates then run cheap-to-expensive: cooldown and treasury floor are scalar reads, stress is a single function call, and the exposure precondition closes out the exposure read. Short-circuit on the first failure. The keeper benefits from the same ordering when probing eligibility off-chain.

## 3. The Formula

"Exposure" is the risk-weighted notional a market's insurance fund would have to make whole in a worst-case maintenance-margin breach for that market.

### 3.1 Per-market exposure

For each market:

```
market_exposure_q = (oi_eff_long_q + oi_eff_short_q) * oracle_price * maintenance_bps / 10_000
```

- `oi_eff_long_q`, `oi_eff_short_q` — effective open interest per side, already maintained on the market account.
- `oracle_price` — the same oracle price the matcher uses for mark-to-market.
- `maintenance_bps` — the market's maintenance margin requirement in basis points.

The intuition: open interest gives notional, oracle price converts it to fund-denominated units, maintenance bps converts notional into "what the fund is on the hook for if positions fall to maintenance and have to be socialized."

A few deliberate simplifications:

- **Long and short OI are summed, not netted.** A balanced book still represents real risk — a single one-sided liquidation cascade can hit the fund regardless of the offsetting side.
- **No correlation discount across markets.** Treating markets as independent over-states aggregate exposure compared to a true Value-at-Risk model. That over-statement is conservative in the direction the gate cares about.
- **Maintenance-bps, not initial-bps.** The fund is the backstop after a position has already breached initial margin and is being unwound. Maintenance is the right reference level.

### 3.2 Per-market evaluation

Each market is evaluated independently against its own treasury and its own `market_exposure_q`; there is no cross-market aggregation. The exposure helper is net-new in the `percolator` math library (section 6.1) and computes a single market's value on each buyback check — the cooldown gate caps this to once per 24h per market regardless of cranker frequency.

### 3.3 No solvency ratio

The original design gated on `insurance_fund_balance / market_exposure ≥ 1.5`. That is **removed**: the buyback no longer reads the insurance fund, so there is no solvency ratio to compute. `market_exposure` survives only as (a) the non-zero-exposure precondition (§2.5) and (b) an input to the health surface and the indexer — the slice itself is a flat bps of the treasury, not a function of exposure. The `BUYBACK_RATIO_THRESHOLD` constant and the `BelowInsuranceFloor` / `RatioBelowThreshold` block reasons are dropped (see §4 and the design spec §8).

## 4. Constants

The buyback gate parameters are compile-time constants in the `percolator` crate, mirroring how the locker treats `MIN_TIER_BRONZE`. No `update_config` path on the gate; changing any of them is a program upgrade. (The funding *rate* — the maintenance-fee increment — is a separate, admin-set governance value, not a buyback-gate constant.)

| Constant | Value | Units | Purpose |
|---|---|---|---|
| `BUYBACK_PER_EVENT_BPS` | `10` | basis points of treasury balance | Per-event slice cap (0.1% of the treasury) |
| `BUYBACK_COOLDOWN_SECS` | `86_400` | seconds | Minimum spacing between events |
| `BUYBACK_TREASURY_FLOOR` | (small absolute) | treasury base units | Below this the treasury is left to accrue; no dust round-trips |

The `BUYBACK_RATIO_THRESHOLD` and insurance-floor constants from the original design are **dropped** — the buyback reads the treasury, not the insurance fund.

The pool, LP mint, and pair asset are not global constants — each market binds its own at launch (see §11 "Per-market buyback binding"), set once and immutable thereafter. The buyback token is required to differ from the market's collateral. For the $PERCOLATOR market the bound pool is the existing pump.fun migration pool `Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW` (SOL-paired); a depth sweep within seven days of binding remains a pre-flight checklist item per §11.

## 5. Per-Event Behavior

When the gate passes for a market, a complete event is split across two instructions and one cranker round-trip. The on-chain part is deterministic and gate-checked; the off-chain cranker part performs the actual market interactions.

### 5.1 On-chain trigger (`trigger_buyback`)

1. **Reserve-first.** If the market carries an outstanding loss, credit stakers toward the reserve target before anything else (§2.1); only the remainder is eligible.
2. **Compute the slice.** `slice = treasury_balance * BUYBACK_PER_EVENT_BPS / 10_000`, capped to keep the treasury above its floor. If the slice rounds to zero, the trigger no-ops without stamping the cooldown — there is no point burning a 24h slot on a zero-byte event.
3. **Reserve the slice** inside the `BuybackTreasury` for the cranker round-trip; stamp the cooldown atomically. No insurance, vault, or LP account is touched.
4. **Emit `BuybackTriggered`.** Carries `timestamp`, `token_mint`, `treasury_balance_before`, `reserve_topup`, `slice`, `market_exposure`, and the treasury pubkey. The indexer's primary signal that a buyback is in flight.

### 5.2 Off-chain cranker round-trip

Reads the treasury's reserved slice, executes the following sequence against the market's bound config (token mint, pool, LP mint, pair asset), then calls `settle_buyback` (section 5.3) to close the loop. Every dollar of cost — including the pair side — is sourced from the slice; no other balance is touched.

1. **Convert the slice to the pair asset** (when it differs from the collateral). For a SOL-paired pool, swap the slice (USDC) to SOL via Jupiter; for a pool paired in the collateral itself, this leg is skipped. Slippage cost is minimal on the convert pair.
2. **Split the pair asset in half.** Half is reserved for the buy leg; the other half for the LP pair leg.
3. **Buy the market's token with half the pair asset** on the bound pool.
4. **Add liquidity.** Pair the bought token with the remaining pair asset and deposit into the same pool. Receive LP tokens (the receipt for the deposit).
5. **Burn the LP tokens.** Use **Token-2022's `Burn` instruction** to permanently destroy the LP receipt. PumpSwap's LP mints are Token-2022 (not classic SPL Token), so the cranker uses the Token-2022 program (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) for both the LP token account creation and the burn call. The liquidity is now locked in the pool with no path back out — LP fees that accrue on those tokens stay in the pool (since no holder exists to claim them), deepening the pool over time.
6. **Call `settle_buyback`** with the trade results.

### 5.3 On-chain settlement (`settle_buyback`)

Verifies that:
- The supplied LP token mint matches the market's bound LP mint.
- The reported `lp_burned_amount` was actually destroyed (the handler's account checks confirm the LP token account is now empty, or that the burn was atomic with the call).
- The treasury's reserved slice is fully consumed after settlement.

Then emits `LiquidityLocked` with the slice, pair acquired, token bought, pair paired, `lp_tokens_burned`, the token mint and pool pubkey, and the realized buy price. Closes the loop.

### 5.4 Invariants

- The cooldown stamp advances iff `slice > 0` and the slice reservation succeeds. A failed reservation must roll back the stamp — the same transactional semantics handle this for free if both sit in the same instruction.
- The treasury reserves at most one undisbursed slice at a time. If a previous slice has not yet been settled when the next trigger fires (24h+ later), the new slice is added on top — no separate accounting per event. Settlement consumes the reserved amount.
- `BuybackTriggered` and `LiquidityLocked` are not paired one-to-one. A single `LiquidityLocked` may close out multiple stale triggers if the cranker fell behind. Indexers should track cumulative LP burned, not match-by-match.
- The cranker's convert → buy → add-liquidity sequence is intended to be atomic at the cranker process level (one Solana transaction, multiple inner instructions). If composing the full sequence into one transaction is infeasible due to compute budget, the cranker may break it into multiple transactions with a slippage bound across the gap.

The on-chain handler's job ends at step 3 of section 5.1. The cranker round-trip in section 5.2 runs asynchronously — if the cranker stalls, the next buyback slot is still gated by `last_buyback_ts`, so a stuck pool does not compound. Recovery is "the cranker catches up," not a program-level rollback.

A buyback event is intentionally split across two on-chain instructions (trigger, then settle) so the on-chain program never embeds DEX or AMM routing logic. This means a Jupiter or PumpSwap outage degrades the buyback gracefully: triggers still fire on schedule, settlement just queues until the swap and add-liquidity paths return.

## 6. What Needs To Be Built, By Repo

This section covers the math gate, the funding setup, the stake-program handler, the keeper, and the indexer at sketch level. The funding model (protocol-fee increment → treasury), the staker firewall, and custody are governed by the design spec; §11 and the spec are authoritative when they disagree with the sketches below. **There is no wrapper entry — the wrapper (`percolator-prog`) is unchanged.**

### 6.1 `percolator` (math gate)

- Helper: `market_exposure(market: MarketView) -> Result<u128, BuybackBlocker>`. Applies the per-market formula in section 3.1 to a single market's view; checked arithmetic, `Err(MathOverflow)` on overflow. Unchanged — it now feeds the non-zero-exposure precondition and the indexer/health surface, not slice sizing or a solvency ratio (the slice is a flat bps of the treasury).
- Helper: `buyback_eligible(treasury_balance, exposure, last_buyback_ts, now, haircut_active, treasury_floor) -> Result<u64, BuybackBlocker>`. Runs the gates (cooldown, treasury floor, non-zero exposure, no-haircut) and returns either the slice size (bps of treasury, clamped to the floor) or the failing condition. Pure, no I/O. The reserve-first step (§2.1) runs in the handler, before this.
- Constants module entries for the section-4 values (`BUYBACK_PER_EVENT_BPS`, `BUYBACK_COOLDOWN_SECS`, `BUYBACK_TREASURY_FLOOR`).
- `BuybackBlocker` enum, in canonical declaration order (gate-evaluation sequence, `MathOverflow` last as the cross-cutting fail-closed bucket): `CooldownActive`, `BelowTreasuryFloor`, `HaircutsActive`, `AutoPausedUnderStress`, `ReserveTopUpPending`, `ExposureBelowMinimum`, `MathOverflow`. The original `BelowInsuranceFloor` / `RatioBelowThreshold` variants are **dropped** (no insurance read). This order is load-bearing — the SDK error map and the on-chain enum must match it byte-for-byte.
- Unit tests cover the boundaries: cooldown at exactly 24h, treasury at exactly the floor, exposure exactly 0, slice rounding to 0.

### 6.2 `percolator-stake` (funding, treasury, handler)

- **Funding setup.** Designate a protocol-owned portfolio as the maintenance-fee cranker recipient (the audited separate-cranker path), and **raise** the maintenance-fee increment so the protocol slice is strictly additive (design spec §4). Sweep the protocol portfolio's accrued capital into `BuybackTreasury` via the engine's normal withdraw path.
- **`BuybackTreasury` PDA** at `[b"buyback_treasury", market]`, program-owned, holding only swept protocol-fee revenue — the sole spend source.
- `trigger_buyback`. Permissionless. Loads the treasury, the market account (exposure + health), the bound buyback config, and `Clock`. Runs reserve-first (§2.1), then `buyback_eligible` against the treasury. On success reserves the slice in the treasury, stamps `last_buyback_ts`, emits `BuybackTriggered`. Never touches insurance, the vault, or LP.
- `settle_buyback`. Verifies the LP mint matches the bound LP mint, the reported `lp_burned_amount` was destroyed, and the treasury's reserved slice is fully consumed. Emits `LiquidityLocked`.
- `emergency_drain_treasury`. Returns a stranded slice to the treasury — a protocol problem, never a staker one.
- `BuybackState` PDA per market (`last_buyback_ts`, counters) and the per-market `BuybackConfig` binding (token/pool/LP-mint/pair), set once at launch, immutable, append-only.
- Events `BuybackTriggered` / `LiquidityLocked`, append-only.
- **No wrapper change, no `vault_auth` CPI, and no `total_buyback_spent` NAV surgery** — the buyback never touches the stake pool's value, so staker NAV is unaffected by construction.

### 6.3 `percolator-keeper` (cranker)

- New crank loop: poll `trigger_buyback` eligibility every N seconds (60-120s feels right; the on-chain cooldown gate is the real ratelimit).
- On a successful trigger, read the treasury's reserved slice and execute the section 5.2 sequence against the market's bound config: convert the slice to the pair asset, split, half-buy the token on the bound pool, add-liquidity with the bought token plus the remaining pair asset, burn the LP receipt token, call `settle_buyback`.
- Should be tolerant of being one of many crankers — the on-chain cooldown ensures only one trigger lands per 24h slot, the rest get a gate-failure error, log and move on.
- Logging should distinguish "no event because gate X failed" from "no event because cooldown" — the former is informational, the latter is the steady state.
- Each leg of the cranker sequence has its own slippage bound. If any leg exceeds its bound, the cranker aborts and surfaces an error. The trigger has already happened on-chain; the slice will sit in the pool until a successful round-trip clears it.
- The cranker reads each market's bound pool and assumes it is initialized, aborting cleanly if not. The AMM's add-liquidity instruction layout is the integration's load-bearing dependency — see section 11.

### 6.4 `percolator-indexer` (required at T+0)

- Decode `BuybackTriggered` and `LiquidityLocked`. Surface a "buybacks" feed.
- Useful columns: timestamp, market, token mint, slice, reserve top-up, exposure at trigger, token bought, pair paired, LP tokens burned, realized buy price.
- Filter rule mirrors the locker's: pin to the canonical program and per-market binding, ignore any unbound market under the program ID.
- Cumulative-LP-burned and total-locked-liquidity-USD-equivalent are the headline metrics — useful for the launch site and for any external dashboard tracking the supply story.

## 7. Why These Numbers

### 7.1 Why a treasury floor and a slice cap (not a 1.5× ratio)

- The 1.5× insurance ratio is **gone** — the buyback spends a dedicated treasury, not the insurance fund, so there is no solvency ratio to defend.
- The treasury holds only protocol-fee revenue, so the only sizing questions are: leave enough to avoid dust round-trips (the floor), and bound the per-event market footprint (the slice cap). Staker protection is handled ahead of all of this by the reserve-first step (§2.1).

### 7.2 Why 0.1% per event

- 10 bps is small enough that an erroneous trigger cannot meaningfully drain the treasury in a single event.
- It is large enough that, compounded daily across years, it produces a visible liquidity-lock signal — order of magnitude tens of bps per month at sustained eligibility.
- Half of the 10 bps is the buy leg's market footprint on the pool; half is the LP pair leg.
- Bounds the cranker's market impact: 10 bps of the treasury is a known-small order size relative to the token's expected liquidity, especially as the locked pool deepens with each event.

### 7.3 Why 24h

- Pairs cleanly with daily protocol bookkeeping and oracle update cadences.
- Gives the treasury a full day to refill from protocol-fee revenue between events.
- Makes the maximum annual draw legible: 365 events × 10 bps ≈ 36% of the treasury per year **in the worst case where every single day is eligible**. In practice it caps far below that, and it only ever spends protocol revenue.

### 7.4 Why these conditions and not more

- The gates each guard a distinct failure mode: drain rate (cooldown), treasury-floor breach (floor), active stress (haircut), no-measurable-risk (exposure precondition), and staker exposure on a market loss (reserve-first). Removing any one re-opens a specific failure mode.
- Adding a discretionary gate — e.g., a price-based gate, a volume gate, a circulating-supply gate — moves the system away from "buy when the fund is structurally surplus" toward "buy when conditions look right by some discretionary measure." That is the slope toward governance.
- These gates can all be evaluated from on-chain state alone, with no off-chain inputs beyond the oracle the protocol already trusts. This matters: the autonomy property fails the moment a gate depends on a value that requires off-chain attestation.

### 7.5 Why hardcoded

- Same argument as the locker's `MIN_TIER_BRONZE` floor: a buyback whose parameters can be moved by an admin is a buyback whose social contract can be moved by an admin. Locking liquidity floats only as much credibility as the rules around it.
- Program upgrades to change any of the four constants are observable on-chain and require the same trust assumption as any other code change — strictly stronger than a config knob.
- The locker's `update_config` rate-limit (7 days, 50% bound, ordering preservation) is the right model for parameters that genuinely need to track market conditions. Buyback parameters do not — they are policy, not tuning surface.

### 7.6 Why LP-and-burn-LP instead of pure burn

- Pure burn destroys $PERCOLATOR supply directly but takes the protocol's USDC out of the system permanently with no continued utility.
- LP-and-burn-LP achieves nearly the same effect on freely-tradeable supply — locked tokens cannot be sold by anyone, ever — while leaving the protocol's USDC inside a permanent on-chain liquidity pool.
- The locked pool also accumulates trading fees from organic volume on every PumpSwap swap. Those fees are permanently stuck in the pool (the LP holders that would normally claim them have been burned), which means the locked liquidity grows over time even without new buybacks.
- For a microcap token with thin order books, deeper liquidity is meaningful trader UX. A pure-burn program would not provide that.
- The narrative trade — "permanent locked liquidity" instead of "destroyed supply" — is slightly less legible but functionally equivalent for price effect, and strictly stronger on liquidity.

## 8. Observability

The buyback's social contract depends on outsiders being able to verify it is operating as designed. The minimum observable surface:

- **Every trigger emits `BuybackTriggered` with the treasury balance, reserve top-up, slice, and exposure at firing time.** A third party can replay history and confirm every event came from protocol-fee revenue and stayed within the slice cap.
- **Every settlement emits `LiquidityLocked` with `lp_tokens_burned`, token bought, pair paired, the token mint, and `pool_pubkey`.** Cumulative LP-burned and the resulting locked liquidity are reconstructible from event logs alone, no account-state required.
- **The LP token burn is verifiable on-chain.** Any RPC can confirm the LP receipt was destroyed via Token-2022's `Burn` instruction, meaning the corresponding pool position can never be withdrawn.
- **`last_buyback_ts` is on-chain.** Cooldown enforcement is auditable from any RPC.
- **The gate constants are in source, and each market's binding is on-chain.** Anyone can read `BUYBACK_PER_EVENT_BPS`, `BUYBACK_COOLDOWN_SECS`, `BUYBACK_TREASURY_FLOOR` from the program binary and each market's bound token/pool from its binding account, and confirm the values.

A buyback that meets these points has nowhere to hide a discretionary override — every event is traceable to gate-state at firing time, every parameter is in the binary, and the LP burn is irreversible. This is the same observability stance the locker takes with `LockPosition.tier` snapshots.

## 9. Failure Modes And Mitigations

What goes wrong, and what stops it from compounding:

- **Stuck cranker.** Trigger fires, the slice sits reserved in the treasury, no cranker picks it up. Mitigation: the cranker is permissionless (anyone can settle) and `emergency_drain_treasury` returns a stranded slice. A stuck slice is a protocol problem, never a staker one — insurance is never involved.
- **Oracle desync.** Exposure no longer gates a solvency ratio and does not size the slice (a flat bps of the treasury) — it feeds only the non-zero precondition and observability — so a bad oracle cannot trigger an over-large or insurance-backed withdrawal (there is none). Worst case it mis-fires the exposure precondition (blocking, or allowing, a buyback on a zero/non-zero read); the cooldown bounds compounding and the haircut gate halts buybacks while the market is genuinely stressed.
- **Sandwich on the cranker round-trip.** A searcher front-runs the buy leg, the LP-add leg, or both. Mitigation: per-leg slippage bounds enforced by the keeper, the 24h cooldown that makes the schedule too irregular to systematically front-run, and the deepening of the locked pool itself (each event makes the pool harder to sandwich than the last).
- **Impermanent loss against locked liquidity.** The token moves significantly against the pair asset after liquidity is locked. The locked pool rebalances mechanically — if the token appreciates, the pool ends up holding more of the pair asset and less of the token than at deposit. This is not a bug; it is the standard AMM cost. The economic effect is "the protocol effectively sold some of the token into strength via the LP," which is acceptable since the slice was protocol-funded surplus to begin with.
- **Concurrent triggers.** Two crankers race to call `trigger_buyback`. Mitigation: atomic update of `last_buyback_ts` inside the handler — one wins, the other gets `CooldownActive`. Standard Solana account-write semantics handle this.
- **Treasury below floor.** The treasury sits below its floor (early life, or right after a large reserve top-up). Mitigation: the floor gate fails immediately, no buyback fires, the treasury accrues protocol-fee revenue until it crosses the floor.
- **Bound pool deprecated or migrated.** The AMM retires the version a market's bound pool is in, or liquidity migrates elsewhere. Mitigation: the binding is immutable, so there is no automatic "redirect" — the affected market's buyback halts and is resumed only by an observable program change. Other markets are unaffected.
- **AMM maturity.** A newer AMM is less battle-tested than older Solana AMMs. Mitigation: bind established pools with real volume and depth; if a critical AMM bug surfaced post-launch, the buyback could be paused via program upgrade pending resolution. Running pools on an in-house AMM removes the third-party dependency.
- **Buyback math constants are wrong.** The thresholds turn out to be too aggressive or too conservative under live conditions. Mitigation: program upgrade. There is no shortcut; this is the price of hardcoding.

## 10. Composition With The Locker

The locker and the buyback are designed to interlock without sharing accounts or PDAs. They live in different programs and coordinate only through the token's market price and the locked pool's depth.

- **Locker** — locks float on the demand side. Tokens locked for fee discounts are off the freely-tradeable supply for at least one cycle, then the discount-end window. This is a soft sink: tokens come back when users unlock.
- **Buyback** — locks supply and liquidity on the protocol side. Protocol-fee revenue is converted to permanent locked liquidity in the market's bound pool. This is a hard sink: tokens deposited cannot be sold by anyone, ever, and the pool deepens further from organic trading fees that are stuck inside it.

Together they bracket the supply story: discount-driven locking removes float while protocol revenue is being earned, buyback-driven liquidity locking permanently anchors supply and improves market depth in proportion to the protocol-fee revenue earned. Neither depends on the other to function — the locker works on a protocol with no buyback, and the buyback works on a protocol with no locker — but the two together convert protocol success into immediate utility (fee discount), durable out-of-circulation supply, and a deepening on-chain market for the token.

The buyback does not read locker state, and the locker does not read buyback state. The integration surface is the SPL mint and nothing else.

## 11. Design Decisions

The funding, custody, and staker-protection decisions are governed by the design spec ([`docs/superpowers/specs/2026-06-28-protocol-fee-funded-buyback-design.md`](docs/superpowers/specs/2026-06-28-protocol-fee-funded-buyback-design.md)); the per-market, binding, AMM, and cranker decisions below carry over. Precise account layouts, error codes, and event field tables are enumerated as each instruction lands.

- **Per-market evaluation.** Each market has its own `BuybackTreasury` (fed by that market's protocol-fee increment) and is evaluated independently against its own treasury and its own exposure — there is no global aggregation and no cross-market state. A market with no live exposure is blocked by the §2.5 precondition. The trigger handler reads exactly one market's state, so account-walk cost is constant regardless of how many markets exist.
- **Per-market buyback binding.** Each market binds its buyback config — token mint, pool, LP mint, and pair asset — once, at market launch, and immutable thereafter (the set-once pattern already used for the wrapper's insurance-authority bind). Because the operator launches both the market and its pool, the two are bound together at birth; there is no admin-mutable post-launch path, so the pool/LP addresses cannot be repointed. The bound token mint is required to differ from the market's collateral mint (and from the LP mint), mirroring the stake program's existing `collateral_mint != lp_mint` guard, so a market never buys its own backing.
- **Cranker authority model — permissionless.** Follows the wrapper's existing `PermissionlessCrank` / `handle_permissionless_crank` convention. Concurrent crankers race for the cooldown stamp; one wins, the rest receive a gate-state error.
- **Custody — `BuybackTreasury` PDA owned by the stake program**, at `[b"buyback_treasury", market]`, one per market. It holds only swept protocol-fee revenue and is the sole spend source. The buyback program exposes no instruction whose authority can debit insurance, the stake vault, the LP mint, or any staker account — a Kani-provable firewall (design spec §6).
- **Funding — protocol-fee increment, not an insurance withdrawal.** The buyback is funded by raising the maintenance-fee increment and routing it to a protocol-owned cranker portfolio, then sweeping that to the treasury. The engine's `credit_account_from_insurance_delta` guard (already Kani-proven) ensures the reward can only be paid from freshly-charged, not-yet-budgeted surplus and can never reach staker-budgeted insurance. **The wrapper is unchanged — the previously-planned `WithdrawForBuyback` permissionless instruction is dropped**, and with it the entire `vault_auth`-CPI vault-drain surface.
- **Reserve-first backstop (stakers better than whole).** On a market loss, the treasury credits stakers toward a reserve target before any buyback (the protocol fund is a junior buffer above stakers). The recommended top-up route is a permissionless stake-side credit-to-NAV gated on a real token deposit (mirroring how `ReturnInsurance` gates on actual token movement); it only ever *raises* `total_pool_value()` and needs no wrapper authority. The reserve-target formula is an open planning item (design spec §10).
- **Pool verification at binding.** For each market, the bound pool, LP mint, and AMM program ID are verified at bind time: the pool is AMM-owned, the LP mint is Token-2022 with no unexpected extensions, and the program ID matches. A live depth check on the bound pool is a pre-flight checklist item within seven days of binding. For the $PERCOLATOR market the bound pool is the pump.fun migration pool `Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW` (SOL-paired).
- **AMM upgrade authority — pinned, with emergency drain.** A third-party AMM (e.g. PumpSwap) whose upgrade authority is a single externally-owned key is the design's only unbounded loss surface: a malicious upgrade could redirect add-liquidity reserves — but only *treasury* funds are ever at stake, never staker money. Mitigation: the program pins the AMM's program-data hash per bound pool and refuses to settle on drift; the keeper watches for `BPFLoaderUpgradeable` events targeting the bound AMM and disables itself; `emergency_drain_treasury` recovers a stranded slice. Launching pools on an in-house AMM with renounced or multisig-held upgrade authority removes this surface entirely — and lets the pool address be derived rather than pinned. The design spec recommends the in-house AMM.
- **Pair asset — per-market.** The pair asset is part of each market's binding. PumpSwap migration pools are SOL-paired, so a SOL-paired market keeps the cranker's collateral→SOL conversion leg (USDC→SOL via Jupiter). A market whose pool is launched in-house can be paired in the collateral (e.g. USDC), which drops the conversion leg entirely.
- **Per-leg slippage bounds — env-var-configured, conservative defaults.** Each swap leg (the optional collateral→pair conversion, the buy, and the add-liquidity) carries an independent slippage cap, plus a depth-aware dynamic check that aborts the round-trip when implied price impact exceeds the natural pool impact by a configured margin. The exact default values live in the keeper repo's `.env.example` and are intentionally not published here — pinning slippage in a public spec is a sandwich-bot's free lunch.
- **Compute-budget feasibility — up to three transactions.** Jupiter routing alone can exceed 1M CU; composing it with the buy/add-liquidity legs and the Token-2022 burn does not fit within Solana's 1.4M CU cap. The cranker round-trip is split into wallet-client transactions: an optional convert leg (collateral→pair via Jupiter), the buy + add-liquidity + Token-2022 LP burn, then `settle_buyback`. The cranker carries an idempotent state machine across the transactions so a crash mid-round-trip is recoverable. A market paired in its collateral drops the convert leg.
- **Oracle source — same helper the matcher already uses.** Hyperp markets dispatch to `engine.config.mark_ewma_e6`; Pyth-backed markets to `oracle::read_engine_price_e6`. The buyback math reads via the same code path the matcher reads from, so the two cannot diverge.
- **Maintenance bps source — per-market, immutable post-init.** `risk_params.maintenance_margin_bps` is set at market initialization and never touched by `UpdateConfig`. The buyback inherits no admin-mutable field on this axis.
- **No solvency ratio.** The 1.5× insurance ratio is removed (§3.3). Sizing is a simple integer bps-of-treasury slice, clamped above the treasury floor; the only exposure check is the non-zero precondition (§2.5).
- **LP token burn mechanism — Token-2022 `Burn` instruction.** The bound pool's LP mint is Token-2022, the burn destroys the receipt directly, and the destruction is verifiable on-chain. `settle_buyback` validates the post-burn balance and the LP mint's runtime extension list (rejects any unknown extension, defending against a future AMM upgrade adding extensions to the mint).
- **Indexer scope — required at T+0.** Cumulative LP burned and total locked-liquidity USD-equivalent (per market) are headline metrics for the supply story; the indexer ships alongside the handler rather than as a follow-up.
- **Mainnet rollout sequencing — staged.** Math gate release → stake upgrade U1 (the funding setup, `BuybackTreasury`, `BuybackState`/binding structs, and gate-only handler, inert) → stake upgrade U2 (the treasury sweep, reserve-first top-up, trigger/settle wired) → SDK release → keeper deploy in probe-only mode → indexer deploy → probe-only soak → flip the keeper's trigger flag. **No wrapper upgrade.** Each step has an explicit gate that must pass before the next begins.
