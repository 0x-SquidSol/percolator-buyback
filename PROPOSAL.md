# Autonomous Buyback Proposal

A design and reference implementation for a protocol-funded buyback that runs **per market**: each market's surplus insurance fund buys back that market's own token, pairs it with the market's quote asset, and adds the pair to that token's pool, after which the LP receipt tokens are burned — permanently locking that liquidity. Implementation lands across `percolator` (math), `percolator-prog` (wrapper), `percolator-stake` (handler), `percolator-sdk`, `percolator-keeper`, and `percolator-indexer`.

This document uses the $PERCOLATOR market as its running example, but the mechanism is per-market and per-token: every market binds its own token mint, pool, LP mint, and pair asset once at launch, and the buyback evaluates each market independently against that market's own insurance fund and exposure. For the $PERCOLATOR market the buyback is the supply-side counterpart to the locker's demand-side fee discount.

The four hardcoded parameters and the gate are decided. Plumbing details — per-market binding, cranker authority, slice custody, pool address, wrapper integration — are settled in §11 against the live `percolator-stake` and `percolator-prog` code.

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

## 2. The Gate

A buyback fires for a market only when **all** of these conditions are simultaneously true, each evaluated against that market's own insurance fund and exposure. Any single failure → no-op for this slot.

### 2.1 Ratio gate — `insurance_fund / market_exposure ≥ 1.5`

- The fund must be at least 1.5x the market's risk-weighted exposure before any surplus is recognized.
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

- `insurance_floor` is the existing admin-set hard floor on the insurance fund.
- The buyback is layered **above** the floor, never bypasses it. The slice computation in section 5 saturates against `fund_balance - insurance_floor` so the floor cannot be breached even by an arithmetic edge case.
- If the floor itself is being approached, the ratio gate has likely already failed — but the floor check is kept as a defense-in-depth invariant in case the admin has raised the floor faster than exposure has fallen.
- This is the only gate that depends on an admin-controlled value. The other three are protocol-state-only.

### 2.4 Stress gate — `haircut_ratio() == 1.0`

- The protocol must currently be paying LPs 100% of what they're owed. If haircuts are active, the fund is by definition undersized for current losses and no buyback is appropriate.
- This is the strongest gate: it short-circuits the entire pipeline the moment the protocol enters a stressed regime, even if ratio and cooldown would otherwise allow firing.
- Equality is deliberate. `haircut_ratio() == 1.0` means "no haircut active right now," not "no haircut in the last N blocks." A stress that has just resolved still passes — the ratio gate handles the residual.
- The gate reads from the same haircut accounting the protocol already uses to socialize losses; no new state.

### 2.5 Exposure precondition — `market_exposure > 0`

- A market with zero live exposure makes the ratio gate degenerate: `fund × DEN ≥ 0 × NUM` holds for any fund balance, so the ratio would pass regardless of how small the fund is.
- Firing on a market that carries no measurable risk defeats the ratio gate's purpose — "surplus relative to exposure" is undefined when exposure is zero. The buyback requires a non-zero exposure before the ratio is evaluated, returning `ExposureBelowMinimum` otherwise.
- This matters most for a newly launched market with little or no open interest: it must accrue real risk before its insurance fund is treated as having a surplus to spend.

The gates are ordered cheap-to-expensive in the handler: cooldown and floor are scalar reads, stress is a single function call, and the exposure precondition and ratio close out the market's exposure computation. Short-circuit on the first failure. The keeper benefits from the same ordering when probing eligibility off-chain.

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

Each market is evaluated independently against its own insurance fund and its own `market_exposure_q`; there is no cross-market aggregation. The exposure helper is net-new in the `percolator` math library (section 6.1) and computes a single market's value on each buyback check — the cooldown gate caps this to once per 24h per market regardless of cranker frequency.

### 3.3 The ratio

```
ratio = insurance_fund_balance / market_exposure
```

Implemented via integer cross-multiplication on `u128` operands: the gate compares `fund_balance × 10` against `market_exposure × 15` (NUM=15, DEN=10) — see §11 "Ratio comparison form". No fixed-point representation needed; the boundary at exactly 1.5× is exact integer equality and equality passes per §2.1. The cross-multiply runs only after the §2.5 non-zero-exposure precondition.

## 4. Constants

All four are compile-time constants in the `percolator` crate, mirroring how the locker treats `MIN_TIER_BRONZE`. No `update_config` path. No admin override. Changing any of them is a program upgrade.

| Constant | Value | Units | Purpose |
|---|---|---|---|
| `BUYBACK_RATIO_THRESHOLD` | `1.5` | ratio (fund / exposure) | Minimum surplus ratio before a buyback is eligible |
| `BUYBACK_PER_EVENT_BPS` | `10` | basis points of fund balance | Per-event withdrawal cap (0.1% of fund) |
| `BUYBACK_COOLDOWN_SECS` | `86_400` | seconds | Minimum spacing between events |
| `BUYBACK_FLOOR_GUARD` | (existing `insurance_floor`) | fund-denominated units | Hard floor inherited from existing on-chain config |

`BUYBACK_FLOOR_GUARD` is listed for completeness — the floor itself remains an admin-set on-chain value, the buyback gate just reads it.

The pool, LP mint, and pair asset are not global constants — each market binds its own at launch (see §11 "Per-market buyback binding"), set once and immutable thereafter. The buyback token is required to differ from the market's collateral so the fund never buys its own backing. For the $PERCOLATOR market the bound pool is the existing pump.fun migration pool `Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW` (SOL-paired); a depth sweep within seven days of binding remains a pre-flight checklist item per §11.

## 5. Per-Event Behavior

When the gate passes for a market, a complete event is split across two instructions and one cranker round-trip. The on-chain part is deterministic and gate-checked; the off-chain cranker part performs the actual market interactions.

### 5.1 On-chain trigger (`trigger_buyback`)

1. **Compute the slice.** `slice = fund_balance * BUYBACK_PER_EVENT_BPS / 10_000`. Saturating math; never withdraw more than `fund_balance - insurance_floor`. If the saturated slice is zero (fund is at or below floor), the trigger no-ops without stamping the cooldown — there is no point burning a 24h slot on a zero-byte event.
2. **Withdraw.** Move `slice` from the insurance fund to a dedicated single-purpose pool account (the "buyback pool"). The fund balance and the cooldown timestamp update atomically with the withdrawal.
3. **Emit `BuybackTriggered`.** Carries `timestamp`, `fund_balance_before`, `slice`, the market's `exposure`, `ratio_q`, the token mint, and the destination pool pubkey. Indexer's primary signal that a buyback is in flight, and the only durable record of the ratio at trigger time.

### 5.2 Off-chain cranker round-trip

Reads the buyback pool, executes the following sequence against the market's bound config (token mint, pool, LP mint, pair asset), then calls `settle_buyback` (section 5.3) to close the loop. Every dollar of cost — including the pair side — is sourced from the slice; the protocol contributes nothing else.

1. **Convert the slice to the pair asset** (when it differs from the collateral). For a SOL-paired pool, swap the slice (USDC) to SOL via Jupiter; for a pool paired in the collateral itself, this leg is skipped. Slippage cost is minimal on the convert pair.
2. **Split the pair asset in half.** Half is reserved for the buy leg; the other half for the LP pair leg.
3. **Buy the market's token with half the pair asset** on the bound pool.
4. **Add liquidity.** Pair the bought token with the remaining pair asset and deposit into the same pool. Receive LP tokens (the receipt for the deposit).
5. **Burn the LP tokens.** Use **Token-2022's `Burn` instruction** to permanently destroy the LP receipt. PumpSwap's LP mints are Token-2022 (not classic SPL Token), so the cranker uses the Token-2022 program (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) for both the LP token account creation and the burn call. The liquidity is now locked in the pool with no path back out — LP fees that accrue on those tokens stay in the pool (since no holder exists to claim them), deepening the pool over time.
6. **Call `settle_buyback`** with the trade results.

### 5.3 On-chain settlement (`settle_buyback`)

Verifies that:
- The supplied LP token mint matches the market's bound LP mint.
- The reported `lp_burned_amount` was actually destroyed (Anchor account constraints check the LP token account is now empty or that the burn was atomic with the call).
- The buyback pool is empty after settlement (the entire slice was consumed).

Then emits `LiquidityLocked` with the slice, pair acquired, token bought, pair paired, `lp_tokens_burned`, the token mint and pool pubkey, and the realized buy price. Closes the loop.

### 5.4 Invariants

- The cooldown stamp advances iff `slice > 0` and the withdrawal succeeds. A failed withdrawal must roll back the stamp — Anchor's transactional semantics handle this for free if both sit in the same instruction.
- The buyback pool is single-purpose: it holds at most one undisbursed slice at a time. If a previous slice has not yet been settled when the next trigger fires (24h+ later), the new slice is added on top — no separate accounting per event. Settlement consumes whatever the pool holds.
- `BuybackTriggered` and `LiquidityLocked` are not paired one-to-one. A single `LiquidityLocked` may close out multiple stale triggers if the cranker fell behind. Indexers should track cumulative LP burned, not match-by-match.
- The cranker's convert → buy → add-liquidity sequence is intended to be atomic at the cranker process level (one Solana transaction, multiple inner instructions). If composing the full sequence into one transaction is infeasible due to compute budget, the cranker may break it into multiple transactions with a slippage bound across the gap.

The on-chain handler's job ends at step 3 of section 5.1. The cranker round-trip in section 5.2 runs asynchronously — if the cranker stalls, the next buyback slot is still gated by `last_buyback_ts`, so a stuck pool does not compound. Recovery is "the cranker catches up," not a program-level rollback.

A buyback event is intentionally split across two on-chain instructions (trigger, then settle) so the on-chain program never embeds DEX or AMM routing logic. This means a Jupiter or PumpSwap outage degrades the buyback gracefully: triggers still fire on schedule, settlement just queues until the swap and add-liquidity paths return.

## 6. What Needs To Be Built, By Repo

This section pre-dates the §11 design decisions and covers the math library, handler, keeper, and indexer at sketch level. The wrapper's new permissionless instruction tag and the SDK's new encoders are described in §11; §11 is authoritative when it disagrees with the sketches below.

### 6.1 `percolator` (math library)

- New helper: `market_exposure(market: MarketView) -> Result<u128, BuybackBlocker>`. Applies the per-market formula in section 3.1 to a single market's view — one market per buyback check. Uses checked arithmetic and returns `Err(BuybackBlocker::MathOverflow)` on overflow rather than saturating — saturation is indistinguishable from genuine high exposure in operator logs, whereas an explicit `Err` preserves observability while keeping the same fail-closed property (the gate blocks regardless). Overflow at u128 scale still means something is wrong with input data, not that the buyback should fire.
- New helper: `buyback_eligible(fund_balance, exposure, last_buyback_ts, now, haircut_active, floor) -> Result<u64, BuybackBlocker>`. Single function that runs the gates and returns either the slice size or the failing condition. Pure, no I/O — handler wires the inputs.
- New constants module entries for the four values in section 4.
- New `BuybackBlocker` enum with one variant per gate (`CooldownActive`, `BelowInsuranceFloor`, `HaircutsActive`, `ExposureBelowMinimum`, `RatioBelowThreshold`) plus `MathOverflow` (the checked-arithmetic fail-closed channel above), so callers can distinguish failure modes without parsing strings.
- Unit tests should cover boundary cases: exactly 1.5x ratio, cooldown at exactly 24h, fund balance at exactly the floor, `haircut_ratio` at 0.999... These are the values most likely to expose fixed-point or comparison-direction bugs.

### 6.2 `percolator-stake` (handler)

- New instruction: `trigger_buyback`. Permissionless. Loads the market's insurance fund account, that market's account (for the exposure inputs), the market's bound buyback config, and `Clock`.
- Wires those into `buyback_eligible`. On success, debits the fund, credits the buyback pool PDA, stamps `last_buyback_ts`, emits `BuybackTriggered`. On failure, returns the gate-specific error.
- New instruction: `settle_buyback`. Called by the cranker after the off-chain round-trip lands LP tokens that have been burned. Verifies the LP mint matches the market's bound LP mint, that the cranker's reported `lp_burned_amount` was actually destroyed, and that the buyback pool is empty. Emits `LiquidityLocked`.
- New PDA: the buyback pool account that holds the withdrawn slice between trigger and settle. Custody question flagged in section 11.
- New persistent `BuybackState` PDA per market carrying `last_buyback_ts: i64` and the per-market counters. Append-only addition in the spirit of the locker's change protocol — never insert mid-struct, never reorder, never resize.
- New per-market binding: the token mint, pool, LP mint, and pair asset for each market, set once at launch and immutable thereafter (see §11 "Per-market buyback binding"). Read by `settle_buyback` to verify the supplied LP mint matches the market's bound LP mint.
- New events: `BuybackTriggered` and `LiquidityLocked`. Both must be append-only within their own structure once shipped, same rule the locker's events follow.

### 6.3 `percolator-keeper` (cranker)

- New crank loop: poll `trigger_buyback` eligibility every N seconds (60-120s feels right; the on-chain cooldown gate is the real ratelimit).
- On a successful trigger, read the buyback pool and execute the section 5.2 sequence against the market's bound config: convert the slice to the pair asset, split, half-buy the token on the bound pool, add-liquidity with the bought token plus the remaining pair asset, burn the LP receipt token, call `settle_buyback`.
- Should be tolerant of being one of many crankers — the on-chain cooldown ensures only one trigger lands per 24h slot, the rest get a gate-failure error, log and move on.
- Logging should distinguish "no event because gate X failed" from "no event because cooldown" — the former is informational, the latter is the steady state.
- Each leg of the cranker sequence has its own slippage bound. If any leg exceeds its bound, the cranker aborts and surfaces an error. The trigger has already happened on-chain; the slice will sit in the pool until a successful round-trip clears it.
- The cranker reads each market's bound pool and assumes it is initialized, aborting cleanly if not. The AMM's add-liquidity instruction layout is the integration's load-bearing dependency — see section 11.

### 6.4 `percolator-indexer` (optional, recommended)

- Decode `BuybackTriggered` and `LiquidityLocked`. Surface a "buybacks" feed.
- Useful columns: timestamp, market, token mint, slice, ratio at trigger, exposure at trigger, token bought, pair paired, LP tokens burned, realized buy price.
- Filter rule mirrors the locker's: pin to the canonical program and per-market binding, ignore any unbound market under the program ID.
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

### 7.4 Why these conditions and not more

- The gates each guard a distinct failure mode: under-collateralization (ratio), drain rate (cooldown), absolute floor breach (floor), active stress (haircut), and no-measurable-risk (exposure precondition). Removing any one re-opens a specific failure mode.
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

- **Every trigger emits `BuybackTriggered` with the ratio at firing time.** A third-party can replay history and confirm that no event fired below 1.5x.
- **Every settlement emits `LiquidityLocked` with `lp_tokens_burned`, token bought, pair paired, the token mint, and `pool_pubkey`.** Cumulative LP-burned and the resulting locked liquidity are reconstructible from event logs alone, no account-state required.
- **The LP token burn is verifiable on-chain.** Any RPC can confirm the LP receipt was destroyed via Token-2022's `Burn` instruction, meaning the corresponding pool position can never be withdrawn.
- **`last_buyback_ts` is on-chain.** Cooldown enforcement is auditable from any RPC.
- **The four constants are in source, and each market's binding is on-chain.** Anyone can read `BUYBACK_RATIO_THRESHOLD`, `BUYBACK_PER_EVENT_BPS`, `BUYBACK_COOLDOWN_SECS` from the program binary and each market's bound token/pool from its binding account, and confirm the values.

A buyback that meets these points has nowhere to hide a discretionary override — every event is traceable to gate-state at firing time, every parameter is in the binary, and the LP burn is irreversible. This is the same observability stance the locker takes with `LockPosition.tier` snapshots.

## 9. Failure Modes And Mitigations

What goes wrong, and what stops it from compounding:

- **Stuck cranker.** Trigger fires, slice sits in the pool, no cranker picks it up. Mitigation: cranker is permissionless, anyone can settle. Worst case: USDC sits idle until somebody runs the round-trip leg. The 24h cooldown prevents the pool from accumulating more than ~365 events of stuck slice in a year, and even one settlement clears the entire pool.
- **Oracle desync (fund-denying direction).** A bad oracle inflates `oracle_price` and therefore the market's exposure, failing the ratio gate when it should pass. This is the safe direction — false negatives (no buyback when one is warranted) are strictly preferred to false positives (buyback when fund is needed).
- **Oracle desync (fund-permitting direction).** A stale or manipulated oracle deflates `oracle_price` and inflates the apparent ratio, passing the gate when it should not. Mitigation: the per-event 10 bps cap bounds single-event damage, the cooldown bounds compounding, and the haircut gate catches the case where the protocol is already paying for a real loss the oracle missed.
- **Sandwich on the cranker round-trip.** A searcher front-runs the buy leg, the LP-add leg, or both. Mitigation: per-leg slippage bounds enforced by the keeper, the 24h cooldown that makes the schedule too irregular to systematically front-run, and the deepening of the locked pool itself (each event makes the pool harder to sandwich than the last).
- **Impermanent loss against locked liquidity.** The token moves significantly against the pair asset after liquidity is locked. The locked pool rebalances mechanically — if the token appreciates, the pool ends up holding more of the pair asset and less of the token than at deposit. This is not a bug; it is the standard AMM cost. The economic effect is "the protocol effectively sold some of the token into strength via the LP," which is acceptable since the slice was protocol-funded surplus to begin with.
- **Concurrent triggers.** Two crankers race to call `trigger_buyback`. Mitigation: atomic update of `last_buyback_ts` inside the handler — one wins, the other gets `CooldownActive`. Standard Solana account-write semantics handle this.
- **Floor raised faster than fund grows.** Admin raises `insurance_floor` to a level above current balance. Mitigation: floor gate fails immediately, no buyback fires, fund accumulates until it crosses the new floor.
- **Bound pool deprecated or migrated.** The AMM retires the version a market's bound pool is in, or liquidity migrates elsewhere. Mitigation: the binding is immutable, so there is no automatic "redirect" — the affected market's buyback halts and is resumed only by an observable program change. Other markets are unaffected.
- **AMM maturity.** A newer AMM is less battle-tested than older Solana AMMs. Mitigation: bind established pools with real volume and depth; if a critical AMM bug surfaced post-launch, the buyback could be paused via program upgrade pending resolution. Running pools on an in-house AMM removes the third-party dependency.
- **Buyback math constants are wrong.** The thresholds turn out to be too aggressive or too conservative under live conditions. Mitigation: program upgrade. There is no shortcut; this is the price of hardcoding.

## 10. Composition With The Locker

The locker and the buyback are designed to interlock without sharing accounts or PDAs. They live in different programs and coordinate only through the token's market price and the locked pool's depth.

- **Locker** — locks float on the demand side. Tokens locked for fee discounts are off the freely-tradeable supply for at least one cycle, then the discount-end window. This is a soft sink: tokens come back when users unlock.
- **Buyback** — locks supply and liquidity on the protocol side. Surplus insurance fund balance is converted to permanent locked liquidity in the market's bound pool. This is a hard sink: tokens deposited cannot be sold by anyone, ever, and the pool deepens further from organic trading fees that are stuck inside it.

Together they bracket the supply story: discount-driven locking removes float while protocol revenue is being earned, buyback-driven liquidity locking permanently anchors supply and improves market depth in proportion to how over-collateralized the protocol has become. Neither depends on the other to function — the locker works on a protocol with no buyback, and the buyback works on a protocol with no locker — but the two together convert protocol success into immediate utility (fee discount), durable out-of-circulation supply, and a deepening on-chain market for the token.

The buyback does not read locker state, and the locker does not read buyback state. The integration surface is the SPL mint and nothing else.

## 11. Design Decisions

The decisions below are committed; precise account layouts, error codes, and event field tables will be enumerated as each instruction lands in the implementing repos.

- **Per-market evaluation.** The insurance fund lives inside each market's `RiskEngine` and is denominated in that market's collateral. Each market is evaluated independently against its own fund and its own exposure — there is no global aggregation and no cross-market state. A market with no live exposure is blocked by the §2.5 precondition rather than spending its seed insurance. The trigger handler reads exactly one market's state, so account-walk cost is constant regardless of how many markets exist.
- **Per-market buyback binding.** Each market binds its buyback config — token mint, pool, LP mint, and pair asset — once, at market launch, and immutable thereafter (the set-once pattern already used for the wrapper's insurance-authority bind). Because the operator launches both the market and its pool, the two are bound together at birth; there is no admin-mutable post-launch path, so the pool/LP addresses cannot be repointed. The bound token mint is required to differ from the market's collateral mint (and from the LP mint), mirroring the stake program's existing `collateral_mint != lp_mint` guard, so a market never buys its own backing.
- **Cranker authority model — permissionless.** Follows the wrapper's existing `PermissionlessCrank` / `handle_permissionless_crank` convention. Concurrent crankers race for the cooldown stamp; one wins, the rest receive a gate-state error.
- **Buyback pool custody — fresh PDA owned by the stake program.** Cleanest separation between the slice in flight and any other balance. One rent-funded account per market.
- **Stake → wrapper integration — new permissionless wrapper instruction.** Neither of the two existing insurance-withdraw paths is appropriate (one is admin-only, the other rate-limited in a way that would collide with the buyback's own 24h cooldown). The wrapper gains a new permissionless instruction tag that accepts a CPI from the stake program's `vault_auth` PDA and transfers the slice from the market's insurance fund to the buyback pool. Policy (the gate) lives in the stake program; the wrapper's new tag does the bare withdrawal under the `vault_auth` PDA's signature, validating the token program and destination so a permissionless caller cannot redirect funds. This keeps the wrapper minimal and matches its declared "thin perp engine" stance.
- **Insurance-authority binding — asserted at trigger.** The wrapper exposes `BindInsuranceAuthority` and `RotateInsuranceAuthority`, so a market's insurance authority is not assumed fixed. The withdrawal CPI is signed by the stake program's `vault_auth` PDA, which must be the bound insurance authority; the handler asserts this at trigger and blocks (rather than failing mid-CPI) if the authority has been rotated away.
- **Pool verification at binding.** For each market, the bound pool, LP mint, and AMM program ID are verified at bind time: the pool is AMM-owned, the LP mint is Token-2022 with no unexpected extensions, and the program ID matches. A live depth check on the bound pool is a pre-flight checklist item within seven days of binding. For the $PERCOLATOR market the bound pool is the pump.fun migration pool `Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW` (SOL-paired).
- **AMM upgrade authority — pinned, with emergency drain.** A third-party AMM (e.g. PumpSwap) whose upgrade authority is a single externally-owned key is the design's only unbounded loss surface: a malicious upgrade could redirect add-liquidity reserves. Mitigation: the program pins the AMM's program-data hash per bound pool and refuses to settle if the pin no longer matches; drift halts the buyback for that market. Stuck slices are recoverable via an emergency-drain instruction reachable only after a program upgrade (preserving the "no admin tunable" property). The keeper additionally watches for `BPFLoaderUpgradeable` events targeting the bound AMM and disables itself on detection. Launching pools on an in-house AMM with renounced or multisig-held upgrade authority removes this surface entirely — and lets the pool address be derived rather than pinned.
- **Pair asset — per-market.** The pair asset is part of each market's binding. PumpSwap migration pools are SOL-paired, so a SOL-paired market keeps the cranker's collateral→SOL conversion leg (USDC→SOL via Jupiter). A market whose pool is launched in-house can be paired in the collateral (e.g. USDC), which drops the conversion leg entirely.
- **Per-leg slippage bounds — env-var-configured, conservative defaults.** Each swap leg (the optional collateral→pair conversion, the buy, and the add-liquidity) carries an independent slippage cap, plus a depth-aware dynamic check that aborts the round-trip when implied price impact exceeds the natural pool impact by a configured margin. The exact default values live in the keeper repo's `.env.example` and are intentionally not published here — pinning slippage in a public spec is a sandwich-bot's free lunch.
- **Compute-budget feasibility — up to three transactions.** Jupiter routing alone can exceed 1M CU; composing it with the buy/add-liquidity legs and the Token-2022 burn does not fit within Solana's 1.4M CU cap. The cranker round-trip is split into wallet-client transactions: an optional convert leg (collateral→pair via Jupiter), the buy + add-liquidity + Token-2022 LP burn, then `settle_buyback`. The cranker carries an idempotent state machine across the transactions so a crash mid-round-trip is recoverable. A market paired in its collateral drops the convert leg.
- **Oracle source — same helper the matcher already uses.** Hyperp markets dispatch to `engine.config.mark_ewma_e6`; Pyth-backed markets to `oracle::read_engine_price_e6`. The buyback math reads via the same code path the matcher reads from, so the two cannot diverge.
- **Maintenance bps source — per-market, immutable post-init.** `risk_params.maintenance_margin_bps` is set at market initialization and never touched by `UpdateConfig`. The buyback inherits no admin-mutable field on this axis.
- **Ratio comparison form — integer cross-multiplication.** The 1.5× threshold is expressed as the constant pair (numerator = 15, denominator = 10), and the gate compares `fund_balance × 10` against `market_exposure × 15`. Integer-only, no fixed-point representation, no floor/ceiling ambiguity at the boundary. Equality passes (proposal §2.1 specifies `≥`). The cross-multiply runs only after the §2.5 non-zero-exposure precondition.
- **LP token burn mechanism — Token-2022 `Burn` instruction.** The bound pool's LP mint is Token-2022, the burn destroys the receipt directly, and the destruction is verifiable on-chain. `settle_buyback` validates the post-burn balance and the LP mint's runtime extension list (rejects any unknown extension, defending against a future AMM upgrade adding extensions to the mint).
- **Indexer scope — required at T+0.** Cumulative LP burned and total locked-liquidity USD-equivalent (per market) are headline metrics for the supply story; the indexer ships alongside the handler rather than as a follow-up.
- **Mainnet rollout sequencing — staged.** Math crate release → wrapper upgrade with the new permissionless withdrawal instruction (inert) → stake upgrade U1 with the `BuybackState`/binding structs and gate-only handler (inert) → stake upgrade U2 with withdrawal and settlement wired → SDK release → keeper deploy in probe-only mode → indexer deploy → probe-only soak → flip the keeper's trigger flag. The buyback instructions take the next free stake tags after the current set. Each step has an explicit gate that must pass before the next begins.
