# Autonomous Buyback Proposal

A design proposal for a protocol-funded $PERCOLATOR buyback driven by surplus in the Percolator insurance fund. Bought tokens are paired with SOL and added to the canonical PumpSwap $PERCOLATOR/SOL pool, after which the LP receipt tokens are burned — permanently locking that liquidity. The buyback is the supply-side counterpart to the locker's demand-side fee discount, and the two together form the token's full utility loop. Implementation lands across `percolator`, `percolator-vault`, and `percolator-keeper`.

This document is a proposal, not a spec. Approved parameters and the four-condition gate are decided. Plumbing details — slab aggregation, cranker authority, slice custody, canonical pool address — are explicitly flagged for dcccrypto to settle against the live `percolator-vault` and `percolator` code.

## 1. Goal

- **Permanent liquidity over years**, not over weeks. The buyback's job is to convert protocol surplus into permanent on-chain liquidity at a rate the protocol can comfortably support, indefinitely.
- **No impact on solvency.** A buyback that ever weakens the insurance fund's ability to socialize a tail loss is a bug. The gate is conservative by construction.
- **No protocol subsidy.** Every dollar of cost — the SOL pair leg included — comes out of the buyback's own slice. The protocol's other reserves are never touched.
- **No governance.** All four parameters are hardcoded in the same spirit as the locker's `MIN_TIER_BRONZE` floor. There is no admin tunable that turns buybacks off or up.
- **Fully autonomous.** A permissionless cranker observes on-chain state, the program checks the gate, and either fires or no-ops. No multisig, no off-chain trigger, no human in the loop.

The buyback is not a price-support mechanism and should not be marketed as one. It is a sink that activates when the insurance fund is structurally over-collateralized relative to protocol exposure, returning the surplus to the token holder base via permanent locked liquidity in the canonical AMM pool.

### Non-goals

Calling these out so the design conversation does not drift:

- **Not a yield product.** LP fees from the locked pool stay in the pool — they are not redistributed to lockers, stakers, or the protocol. The economic benefit is depth and out-of-circulation supply; anyone holding $PERCOLATOR shares it pro-rata.
- **Not a defense mechanism.** The buyback does not activate during volatility, drawdowns, or governance events. It activates when the fund is structurally over-collateralized — a condition that is by definition uncorrelated with short-term price action.
- **Not a treasury.** The withdrawn slice exists for at most one cranker round-trip. It is not a balance the protocol can deploy elsewhere, and no instruction lets it be redirected.
- **Not retroactive.** There is no plan to "make up for" missed events if the cranker stalls or the protocol ships the feature late. Each 24h slot is fire-or-forfeit.
- **Not pure burn.** Bought tokens are NOT destroyed via SPL `Burn` — they are deposited as one side of an LP position whose receipt tokens are burned. Effect on freely-tradeable supply is equivalent (locked tokens cannot be sold by anyone), but the on-chain narrative is "permanent liquidity," not "destroyed supply."

## 2. The Four-Condition Gate

A buyback fires only when **all four** conditions are simultaneously true. Any single failure → no-op for this slot.

### 2.1 Ratio gate — `insurance_fund / total_protocol_exposure ≥ 1.5`

- The fund must be at least 1.5x the risk-weighted protocol exposure before any surplus is recognized.
- Below 1.5x, the fund is "doing its job" — every dollar is needed to backstop open risk.
- At or above 1.5x, additional dollars are surplus relative to the worst-case loss the fund needs to absorb.
- The ratio is computed against **current** exposure, not a trailing average. This is intentional: a fund that is over-collateralized right now is over-collateralized regardless of how it got there. Smoothing introduces a tunable that is hard to defend.
- Section 3 formalizes how exposure is computed.

### 2.2 Cooldown gate — `now ≥ last_buyback_ts + 24h`

- At most one buyback event per 24h rolling window.
- Caps how fast the fund can be drained even under sustained surplus.
- Forces the surplus signal to be persistent, not a one-block oracle blip — a transient oracle spike can pass the ratio gate for a few seconds, but cannot trigger two events.
- Bounds the cranker's market footprint at the daily level: at most one swap of `BUYBACK_PER_EVENT_BPS` size hits the AMM per day from this source.
- Single source of truth: `last_buyback_ts` is updated atomically inside the trigger handler, so concurrent crankers cannot double-fire.

### 2.3 Floor gate — `fund_balance > insurance_floor`

- `insurance_floor` is the existing admin-set hard floor on the insurance fund (already in `percolator-vault`).
- The buyback is layered **above** the floor, never bypasses it. The slice computation in section 5 saturates against `fund_balance - insurance_floor` so the floor cannot be breached even by an arithmetic edge case.
- If the floor itself is being approached, the ratio gate has likely already failed — but the floor check is kept as a defense-in-depth invariant in case the admin has raised the floor faster than exposure has fallen.
- This is the only gate that depends on an admin-controlled value. The other three are protocol-state-only.

### 2.4 Stress gate — `haircut_ratio() == 1.0`

- The protocol must currently be paying LPs 100% of what they're owed. If haircuts are active, the fund is by definition undersized for current losses and no buyback is appropriate.
- This is the strongest of the four gates: it short-circuits the entire pipeline the moment the protocol enters a stressed regime, even if ratio and cooldown would otherwise allow firing.
- Equality is deliberate. `haircut_ratio() == 1.0` means "no haircut active right now," not "no haircut in the last N blocks." A stress that has just resolved still passes — the ratio gate handles the residual.
- The gate reads from the same haircut accounting the protocol already uses to socialize losses; no new state.

The four gates are ordered cheap-to-expensive in the handler: cooldown and floor are scalar reads, stress is a single function call, ratio is the cross-market aggregation. Short-circuit on the first failure. The keeper benefits from the same ordering when probing eligibility off-chain.

## 3. The Formula

"Total exposure" is the risk-weighted notional the insurance fund would have to make whole in a worst-case maintenance-margin breach across all live markets.

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

### 3.2 Cross-market aggregation

```
total_protocol_exposure = sum(market_exposure_q for market in all_live_markets)
```

This sum **does not exist in the codebase today.** It is net-new in the `percolator` math library (section 6.1). Walking every market on every buyback check is acceptable — the cooldown gate caps this to once per 24h regardless of cranker frequency.

### 3.3 The ratio

```
ratio = insurance_fund_balance / total_protocol_exposure
```

Computed in the same fixed-point regime the rest of the vault uses. Implementations should pick a representation that does not overflow at realistic OI scales and does not lose precision near the 1.5x boundary — dcccrypto to choose between Q64.64, scaled u128, or the existing helper convention.

## 4. Constants

All four are compile-time constants in the `percolator` crate, mirroring how the locker treats `MIN_TIER_BRONZE`. No `update_config` path. No admin override. Changing any of them is a program upgrade.

| Constant | Value | Units | Purpose |
|---|---|---|---|
| `BUYBACK_RATIO_THRESHOLD` | `1.5` | ratio (fund / exposure) | Minimum surplus ratio before a buyback is eligible |
| `BUYBACK_PER_EVENT_BPS` | `10` | basis points of fund balance | Per-event withdrawal cap (0.1% of fund) |
| `BUYBACK_COOLDOWN_SECS` | `86_400` | seconds | Minimum spacing between events |
| `BUYBACK_FLOOR_GUARD` | (existing `insurance_floor`) | fund-denominated units | Hard floor inherited from existing vault config |

`BUYBACK_FLOOR_GUARD` is listed for completeness — the floor itself remains an admin-set value on the vault, the buyback gate just reads it.

The canonical PumpSwap $PERCOLATOR/SOL pool address is also a hardcoded constant on the program (the cranker reads it from the program rather than from a config file). The pool already exists from pump.fun's migration: `Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW`. dcccrypto to confirm before lock-in (see section 11).

## 5. Per-Event Behavior

When the four-condition gate passes, a complete event is split across two instructions and one cranker round-trip. The on-chain part is deterministic and gate-checked; the off-chain cranker part performs the actual market interactions.

### 5.1 On-chain trigger (`trigger_buyback`)

1. **Compute the slice.** `slice = fund_balance * BUYBACK_PER_EVENT_BPS / 10_000`. Saturating math; never withdraw more than `fund_balance - insurance_floor`. If the saturated slice is zero (fund is at or below floor), the trigger no-ops without stamping the cooldown — there is no point burning a 24h slot on a zero-byte event.
2. **Withdraw.** Move `slice` from the insurance fund to a dedicated single-purpose pool account (the "buyback pool"). The fund balance and the cooldown timestamp update atomically with the withdrawal.
3. **Emit `BuybackTriggered`.** Carries `timestamp`, `fund_balance_before`, `slice`, `total_protocol_exposure`, `ratio_q`, and the destination pool pubkey. Indexer's primary signal that a buyback is in flight, and the only durable record of the ratio at trigger time.

### 5.2 Off-chain cranker round-trip

Reads the buyback pool, executes the following sequence, then calls `settle_buyback` (section 5.3) to close the loop. Every dollar of cost — including the SOL needed for the LP pair side — is sourced from the slice; the protocol contributes nothing else.

1. **USDC → SOL** via Jupiter. Convert the entire slice to SOL. Slippage cost is minimal on this pair.
2. **Split the SOL in half.** Half is reserved for the buy leg; the other half for the LP pair leg.
3. **Buy $PERCOLATOR with half the SOL** on the canonical PumpSwap $PERCOLATOR/SOL pool.
4. **Add liquidity.** Pair the bought $PERCOLATOR with the remaining SOL and deposit into the same PumpSwap pool. Receive LP tokens (the receipt for the deposit).
5. **Burn the LP tokens.** Use **Token-2022's `Burn` instruction** to permanently destroy the LP receipt. PumpSwap's LP mints are Token-2022 (not classic SPL Token), so the cranker uses the Token-2022 program (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) for both the LP token account creation and the burn call. The liquidity is now locked in the pool with no path back out — LP fees that accrue on those tokens stay in the pool (since no holder exists to claim them), deepening the pool over time.
6. **Call `settle_buyback`** with the trade results.

### 5.3 On-chain settlement (`settle_buyback`)

Verifies that:
- The supplied LP token mint matches the canonical PumpSwap pool's LP mint.
- The reported `lp_burned_amount` was actually destroyed (Anchor account constraints check the LP token account is now empty or that the burn was atomic with the call).
- The buyback pool is empty after settlement (the entire slice was consumed).

Then emits `LiquidityLocked` with `slice_usdc`, `sol_acquired`, `perc_bought`, `sol_paired`, `lp_tokens_burned`, `pool_pubkey`, and `realized_perc_per_sol`. Closes the loop.

### 5.4 Invariants

- The cooldown stamp advances iff `slice > 0` and the withdrawal succeeds. A failed withdrawal must roll back the stamp — Anchor's transactional semantics handle this for free if both sit in the same instruction.
- The buyback pool is single-purpose: it holds at most one undisbursed slice at a time. If a previous slice has not yet been settled when the next trigger fires (24h+ later), the new slice is added on top — no separate accounting per event. Settlement consumes whatever the pool holds.
- `BuybackTriggered` and `LiquidityLocked` are not paired one-to-one. A single `LiquidityLocked` may close out multiple stale triggers if the cranker fell behind. Indexers should track cumulative LP burned, not match-by-match.
- The cranker's USDC → SOL → $PERCOLATOR → add-liquidity sequence is intended to be atomic at the cranker process level (one Solana transaction, multiple inner instructions). If composing the full sequence into one transaction is infeasible due to compute budget, the cranker may break it into two transactions with a slippage bound across the gap.

The on-chain handler's job ends at step 3 of section 5.1. The cranker round-trip in section 5.2 runs asynchronously — if the cranker stalls, the next buyback slot is still gated by `last_buyback_ts`, so a stuck pool does not compound. Recovery is "the cranker catches up," not a program-level rollback.

A buyback event is intentionally split across two on-chain instructions (trigger, then settle) so the on-chain program never embeds DEX or AMM routing logic. This means a Jupiter or PumpSwap outage degrades the buyback gracefully: triggers still fire on schedule, settlement just queues until the swap and add-liquidity paths return.

## 6. What Needs To Be Built, By Repo

### 6.1 `percolator` (math library)

- New helper: `total_protocol_exposure(markets: &[MarketView]) -> u128` (or fixed-point equivalent). Walks every live market, applies the per-market formula in section 3.1, sums. Should saturate on overflow rather than wrap — overflow at this scale means something is wrong with input data, not that the buyback should fire on a wrapped value.
- New helper: `buyback_eligible(fund_balance, exposure, last_buyback_ts, now, haircut_ratio, floor) -> Result<u64, BuybackBlocker>`. Single function that runs all four gates and returns either the slice size or the failing condition. Pure, no I/O — handler wires the inputs.
- New constants module entries for the four values in section 4.
- New `BuybackBlocker` enum with one variant per gate (`RatioBelowThreshold`, `CooldownActive`, `BelowInsuranceFloor`, `HaircutsActive`) so callers can distinguish failure modes without parsing strings.
- Unit tests should cover boundary cases: exactly 1.5x ratio, cooldown at exactly 24h, fund balance at exactly the floor, `haircut_ratio` at 0.999... These are the values most likely to expose fixed-point or comparison-direction bugs.

### 6.2 `percolator-vault` (handler)

- New instruction: `trigger_buyback`. Permissionless. Loads the insurance fund account, every market account (or a packed exposure summary — see section 11), the vault config, and `Clock`.
- Wires those into `buyback_eligible`. On success, debits the fund, credits the buyback pool PDA, stamps `last_buyback_ts`, emits `BuybackTriggered`. On failure, returns the gate-specific error.
- New instruction: `settle_buyback`. Called by the cranker after the off-chain round-trip lands LP tokens that have been burned. Verifies the LP mint matches the canonical PumpSwap pool's LP mint, that the cranker's reported `lp_burned_amount` was actually destroyed, and that the buyback pool is empty. Emits `LiquidityLocked`.
- New PDA: the buyback pool account that holds the withdrawn slice between trigger and settle. Custody question flagged in section 11.
- New persistent field on the vault config (or a dedicated `BuybackState` PDA): `last_buyback_ts: i64`. Append-only addition in the spirit of the locker's change protocol — never insert mid-struct, never reorder, never resize.
- New constant on the program: the canonical PumpSwap $PERCOLATOR/SOL pool pubkey (`Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW`, the pump.fun migration pool). Read by `settle_buyback` to verify the LP mint matches. Hardcoded — changing it requires a program upgrade.
- New events: `BuybackTriggered` and `LiquidityLocked`. Both must be append-only within their own structure once shipped, same rule the locker's events follow.

### 6.3 `percolator-keeper` (cranker)

- New crank loop: poll `trigger_buyback` eligibility every N seconds (60-120s feels right; the on-chain cooldown gate is the real ratelimit).
- On a successful trigger, read the buyback pool and execute the section 5.2 sequence: USDC → SOL via Jupiter, SOL split, half-buy on PumpSwap, add-liquidity with the bought $PERCOLATOR plus the remaining SOL, burn the LP receipt token, call `settle_buyback`.
- Should be tolerant of being one of many crankers — the on-chain cooldown ensures only one trigger lands per 24h slot, the rest get a gate-failure error, log and move on.
- Logging should distinguish "no event because gate X failed" from "no event because cooldown" — the former is informational, the latter is the steady state.
- Each leg of the cranker sequence has its own slippage bound. If any leg exceeds its bound, the cranker aborts and surfaces an error. The trigger has already happened on-chain; the slice will sit in the pool until a successful round-trip clears it.
- The canonical pool already exists (`Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW`); the cranker assumes the pool is initialized and aborts cleanly if not. PumpSwap's add-liquidity instruction layout is the integration's load-bearing dependency — see section 11.

### 6.4 `percolator-indexer` (optional, recommended)

- Decode `BuybackTriggered` and `LiquidityLocked`. Surface a "buybacks" feed.
- Useful columns: timestamp, slice, ratio at trigger, exposure at trigger, $PERCOLATOR bought, SOL paired, LP tokens burned, realized buy price.
- Filter rule mirrors the locker's: pin to the canonical vault pubkey, ignore any other vault under the program ID.
- Cumulative-LP-burned and total-locked-liquidity-USD-equivalent are the headline metrics — useful for the launch site and for any external dashboard tracking the supply story.

## 7. Why These Numbers

### 7.1 Why 1.5x

- 1.0x means the fund exactly covers maintenance-margin worst case. Buying back at 1.0x would, by construction, leave the protocol under-funded the moment any single market's exposure ticks up.
- 1.2x is too tight a margin against oracle noise and OI bursts.
- 2.0x is defensible but parks too much idle capital in the fund before any surplus is recognized — a meaningful drag on the buyback's long-term cumulative effect.
- 1.5x is the smallest ratio that survives a plausible single-market stress test (oracle gap + OI spike) without dropping the fund below 1.0x. It is conservative without being inert.

### 7.2 Why 0.1% per event

- 10 bps is small enough that an erroneous trigger (oracle desync, market-account staleness, math bug) cannot meaningfully damage the fund in a single event.
- It is large enough that, compounded daily across years, it produces a visible liquidity-lock signal — order of magnitude tens of bps per month at sustained eligibility.
- Half of the 10 bps is the buy leg's market footprint on the PumpSwap pool; half is the LP pair leg. The buy-leg impact is therefore 5 bps of fund per event, smaller still than a pure-burn variant of the same proposal.
- Bounds the cranker's market impact: 10 bps of the insurance fund is a known-small order size relative to $PERCOLATOR's expected liquidity, especially as the locked pool itself deepens with each event.

### 7.3 Why 24h

- Pairs cleanly with daily protocol bookkeeping and oracle update cadences.
- Gives the fund a full day to refill from fees between events, so a string of consecutive eligible days does not monotonically drain it.
- Makes the maximum annual drawdown legible: 365 events × 10 bps ≈ 36% of the fund balance per year **in the worst case where every single day is eligible**, which itself requires sustained 1.5x+ coverage. In practice this caps far below 36%.

### 7.4 Why these four conditions and not more

- The four gates each guard a distinct failure mode: under-collateralization (ratio), drain rate (cooldown), absolute floor breach (floor), active stress (haircut). Removing any one of them re-opens a specific failure mode.
- Adding a fifth — e.g., a price-based gate, a volume gate, a circulating-supply gate — moves the system away from "buy when the fund is structurally surplus" toward "buy when conditions look right by some discretionary measure." That is the slope toward governance.
- The four gates are also the four that can be evaluated from on-chain state alone, with no off-chain inputs beyond the oracle the protocol already trusts. This matters: the autonomy property fails the moment a gate depends on a value that requires off-chain attestation.

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

- **Every trigger emits `BuybackTriggered` with the ratio at firing time.** A third-party can replay history and confirm that no event fired below 1.5x.
- **Every settlement emits `LiquidityLocked` with `lp_tokens_burned`, `perc_bought`, `sol_paired`, and `pool_pubkey`.** Cumulative LP-burned and the resulting locked liquidity are reconstructible from event logs alone, no account-state required.
- **The LP token burn is verifiable on-chain.** Any RPC can confirm the LP receipt was destroyed via Token-2022's `Burn` instruction, meaning the corresponding pool position can never be withdrawn.
- **`last_buyback_ts` is on-chain.** Cooldown enforcement is auditable from any RPC.
- **The four constants and the canonical pool address are in source.** Anyone can read `BUYBACK_RATIO_THRESHOLD`, `BUYBACK_PER_EVENT_BPS`, `BUYBACK_COOLDOWN_SECS`, and the pool pubkey directly from the program binary and confirm the values.

A buyback that meets these points has nowhere to hide a discretionary override — every event is traceable to gate-state at firing time, every parameter is in the binary, and the LP burn is irreversible. This is the same observability stance the locker takes with `LockPosition.tier` snapshots.

## 9. Failure Modes And Mitigations

What goes wrong, and what stops it from compounding:

- **Stuck cranker.** Trigger fires, slice sits in the pool, no cranker picks it up. Mitigation: cranker is permissionless, anyone can settle. Worst case: USDC sits idle until somebody runs the round-trip leg. The 24h cooldown prevents the pool from accumulating more than ~365 events of stuck slice in a year, and even one settlement clears the entire pool.
- **Oracle desync (fund-denying direction).** A bad oracle inflates `oracle_price` and therefore `total_protocol_exposure`, failing the ratio gate when it should pass. This is the safe direction — false negatives (no buyback when one is warranted) are strictly preferred to false positives (buyback when fund is needed).
- **Oracle desync (fund-permitting direction).** A stale or manipulated oracle deflates `oracle_price` and inflates the apparent ratio, passing the gate when it should not. Mitigation: the per-event 10 bps cap bounds single-event damage, the cooldown bounds compounding, and the haircut gate catches the case where the protocol is already paying for a real loss the oracle missed.
- **Sandwich on the cranker round-trip.** A searcher front-runs the buy leg, the LP-add leg, or both. Mitigation: per-leg slippage bounds enforced by the keeper, the 24h cooldown that makes the schedule too irregular to systematically front-run, and the deepening of the locked pool itself (each event makes the pool harder to sandwich than the last).
- **Impermanent loss against locked liquidity.** $PERCOLATOR moves significantly against SOL after liquidity is locked. The locked pool rebalances mechanically — if $PERCOLATOR appreciates, the pool ends up holding more SOL and less $PERCOLATOR than at deposit. This is not a bug; it is the standard AMM cost. The economic effect is "the protocol effectively sold some $PERCOLATOR into strength via the LP," which is acceptable since the slice was protocol-funded surplus to begin with.
- **Concurrent triggers.** Two crankers race to call `trigger_buyback`. Mitigation: atomic update of `last_buyback_ts` inside the handler — one wins, the other gets `CooldownActive`. Standard Solana account-write semantics handle this.
- **Floor raised faster than fund grows.** Admin raises `insurance_floor` to a level above current balance. Mitigation: floor gate fails immediately, no buyback fires, fund accumulates until it crosses the new floor.
- **Canonical PumpSwap pool deprecated or migrated.** PumpSwap retires the AMM version the canonical pool is in, or liquidity migrates to a deeper pool. Mitigation: program upgrade. The canonical pool address is hardcoded; if it must change, the upgrade is observable on-chain. There is no automatic "redirect."
- **PumpSwap maturity.** PumpSwap is newer and less battle-tested than older Solana AMMs. Mitigation: the canonical pool is the existing pump.fun migration pool with established volume and depth; no new pool is created. If a critical PumpSwap bug surfaced post-launch, the buyback could be paused via program upgrade pending resolution.
- **Buyback math constants are wrong.** The thresholds turn out to be too aggressive or too conservative under live conditions. Mitigation: program upgrade. There is no shortcut; this is the price of hardcoding.

## 10. Composition With The Locker

The locker and the buyback are designed to interlock without sharing accounts or PDAs. They live in different programs and coordinate only through the token's market price and the locked pool's depth.

- **Locker** — locks float on the demand side. Tokens locked for fee discounts are off the freely-tradeable supply for at least one cycle, then the discount-end window. This is a soft sink: tokens come back when users unlock.
- **Buyback** — locks supply and liquidity on the protocol side. Surplus insurance fund balance is converted to permanent locked liquidity in the canonical PumpSwap pool. This is a hard sink: tokens deposited cannot be sold by anyone, ever, and the pool deepens further from organic trading fees that are stuck inside it.

Together they bracket the supply story: discount-driven locking removes float while protocol revenue is being earned, buyback-driven liquidity locking permanently anchors supply and improves market depth in proportion to how over-collateralized the protocol has become. Neither depends on the other to function — the locker works on a protocol with no buyback, and the buyback works on a protocol with no locker — but the two together convert protocol success into immediate utility (fee discount), durable out-of-circulation supply, and a deepening on-chain market for the token.

The buyback does not read locker state, and the locker does not read buyback state. The integration surface is the SPL mint and nothing else.

## 11. Design Decisions

The questions originally raised in this section have been resolved with dcccrypto (2026-04-30). The decisions below are committed; precise account layouts, error codes, and event field tables will be enumerated as each instruction lands in the implementing repos.

- **Slab vs market aggregation — per-slab.** The insurance fund lives inside each slab's `RiskEngine`; there is no global account today. With a single live market at launch, per-slab is mathematically equivalent to the global formulation in section 3. The implementation enforces a hardcoded `MAX_MARKETS_FOR_PER_SLAB = 1` invariant: a second live market causes `trigger_buyback` to fail closed with a dedicated `BuybackBlocker` variant until a program upgrade migrates to global aggregation (or the shared-vault concept tracked under PERC-628 ships, whichever comes first). This converts the "what happens at N=2" question into a forced upgrade gate rather than an emergent failure.
- **Account walking cost — bounded by the N=1 invariant.** While `MAX_MARKETS_FOR_PER_SLAB = 1` holds, the trigger handler reads exactly one market's state. Account-walk cost is constant. The migration to global aggregation will revisit this with a periodically-updated exposure cache if `N` grows materially.
- **Cranker authority model — permissionless.** Confirmed against the existing wrapper convention (`caller_idx == u16::MAX` for `handle_keeper_crank`). Concurrent crankers race for the cooldown stamp; one wins, the rest receive a gate-state error.
- **Buyback pool custody — fresh PDA owned by the vault program.** Cleanest separation between the slice in flight and any other balance. One rent-funded account per slab.
- **Vault → wrapper integration — new permissionless wrapper instruction.** Neither of the two existing insurance-withdraw paths is appropriate (one is admin-only, the other rate-limited in a way that would collide with the buyback's own 24h cooldown). The wrapper gains a new permissionless instruction tag that accepts a CPI from the vault PDA and transfers the slice from the slab insurance fund to the buyback pool. Policy (the four-condition gate) lives in the vault; the wrapper's new tag does the bare withdrawal under the vault PDA's signature. This keeps the wrapper minimal and matches its declared "thin perp engine" stance.
- **Canonical PumpSwap pool address — `Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW`.** Pool, LP mint, and PumpSwap program ID all re-verified (2026-04-30): pool exists and is PumpSwap-owned; LP mint is vanilla Token-2022, 82 bytes, no extensions; program ID confirmed. A live "deepest pool" depth check via DexScreener is required within seven days of the vault deploy and is part of the pre-flight checklist.
- **PumpSwap upgrade authority — single key, mitigated by binary-pin + emergency drain.** PumpSwap's upgrade authority is a single externally-owned key, not multisig and not renounced. This is the only unbounded loss surface in the design and is mitigated as follows: the vault binary pins PumpSwap's program-data hash at deploy time, and `settle_buyback` re-hashes that program-data on every settlement and reverts if the hash has drifted. Stuck slices are recoverable via an emergency-drain instruction reachable only after a program upgrade (preserving the "no admin tunable" property — the recovery path requires an observable code change, like every other halt path in the design). The keeper additionally watches for `BPFLoaderUpgradeable` events targeting PumpSwap's program ID and disables itself on detection.
- **USDC vs SOL pair side — SOL.** The canonical PumpSwap pool is SOL-paired; the cranker's USDC→SOL conversion step is mandatory. Re-evaluated only if a deeper $PERCOLATOR/USDC pool ever becomes canonical.
- **Per-leg slippage bounds — env-var-configured, conservative defaults.** Each of the three swap legs (Jupiter USDC→SOL, PumpSwap buy, PumpSwap add-liquidity) carries an independent slippage cap, plus a depth-aware dynamic check that aborts the round-trip when implied price impact exceeds the natural pool impact by a configured margin. The exact default values live in the keeper repo's `.env.example` and are intentionally not published here — pinning slippage in a public spec is a sandwich-bot's free lunch.
- **Compute-budget feasibility — three transactions.** Jupiter routing alone can exceed 1M CU; composing it with PumpSwap legs and the Token-2022 burn does not fit within Solana's 1.4M CU cap. The cranker round-trip is split into three wallet-client transactions: Tx A (USDC→SOL via Jupiter), Tx B (SOL split + PumpSwap buy + add-liquidity + Token-2022 LP burn), Tx C (`settle_buyback`). The cranker carries an idempotent state machine across the three transactions so a crash mid-round-trip is recoverable.
- **Oracle source — same helper the matcher already uses.** Hyperp markets dispatch to `engine.config.mark_ewma_e6`; Pyth-backed markets to `oracle::read_engine_price_e6`. The buyback math reads via the same code path the matcher reads from, so the two cannot diverge.
- **Maintenance bps source — per-market, immutable post-init.** `risk_params.maintenance_margin_bps` is set at market initialization and never touched by `UpdateConfig`. The buyback inherits no admin-mutable field on this axis.
- **Ratio comparison form — integer cross-multiplication.** The 1.5× threshold is expressed as the constant pair (numerator = 15, denominator = 10), and the gate compares `fund_balance × 10` against `total_exposure × 15`. Integer-only, no fixed-point representation, no floor/ceiling ambiguity at the boundary. Equality passes (proposal §2.1 specifies `≥`).
- **LP token burn mechanism — Token-2022 `Burn` instruction.** Confirmed: the canonical pool's LP mint is Token-2022, the burn destroys the receipt directly, and the destruction is verifiable on-chain. `settle_buyback` validates the post-burn balance and the LP mint's runtime extension list (rejects any unknown extension, defending against a future PumpSwap upgrade adding extensions to the mint).
- **Indexer scope — required at T+0.** Cumulative LP burned and total locked-liquidity USD-equivalent are headline metrics for the supply story; the indexer ships alongside the vault rather than as a follow-up.
- **Mainnet rollout sequencing — staged.** Math crate release → wrapper upgrade with the new permissionless instruction (inert) → vault upgrade U1 with state struct and gate-only handler (inert) → vault upgrade U2 with withdrawal and settlement wired → SDK release → keeper deploy in probe-only mode → indexer deploy → probe-only soak → flip the keeper's trigger flag. Each step has an explicit gate that must pass before the next begins.
