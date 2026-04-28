# Autonomous Buyback Proposal

A design proposal for a protocol-funded $PERCOLATOR buyback driven by surplus in the Percolator insurance fund. The buyback is the supply-side counterpart to the locker's demand-side fee discount, and the two together form the token's full utility loop. Implementation lands across `percolator`, `percolator-vault`, and `percolator-keeper`.

This document is a proposal, not a spec. Approved parameters and the four-condition gate are decided. Plumbing details — slab aggregation, cranker authority, pre-burn pool custody — are explicitly flagged for dcccrypto to settle against the live `percolator-vault` and `percolator` code.

## 1. Goal

- **Supply reduction over years**, not over weeks. The token has a fixed cap; the buyback's job is to retire float at the rate the protocol can comfortably support, indefinitely.
- **No impact on solvency.** A buyback that ever weakens the insurance fund's ability to socialize a tail loss is a bug. The gate is conservative by construction.
- **No governance.** All four parameters are hardcoded in the same spirit as the locker's `MIN_TIER_BRONZE` floor. There is no admin tunable that turns buybacks off or up.
- **Fully autonomous.** A permissionless cranker observes on-chain state, the program checks the gate, and either fires or no-ops. No multisig, no off-chain trigger, no human in the loop.

The buyback is not a price-support mechanism and should not be marketed as one. It is a sink that activates when the insurance fund is structurally over-collateralized relative to protocol exposure, returning the surplus to the token holder base via burn.

### Non-goals

Calling these out so the design conversation does not drift:

- **Not a yield product.** Burned tokens are not redistributed to lockers or stakers. The economic benefit is supply reduction, full stop. Anyone holding $PERCOLATOR shares it pro-rata.
- **Not a defense mechanism.** The buyback does not activate during volatility, drawdowns, or governance events. It activates when the fund is structurally over-collateralized — a condition that is by definition uncorrelated with short-term price action.
- **Not a treasury.** The pre-burn pool exists for at most one cranker round-trip. It is not a balance the protocol can deploy elsewhere, and no instruction lets it be redirected.
- **Not retroactive.** There is no plan to "make up for" missed events if the cranker stalls or the protocol ships the feature late. Each 24h slot is fire-or-forfeit.

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
- Bounds the cranker's market footprint at the daily level: at most one buy of `BUYBACK_PER_EVENT_BPS` size hits the market per day from this source.
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

## 5. Per-Event Behavior

When the four-condition gate passes:

1. **Compute the slice.** `slice = fund_balance * BUYBACK_PER_EVENT_BPS / 10_000`. Saturating math; never withdraw more than `fund_balance - insurance_floor`. If the saturated slice is zero (fund is at or below floor), the trigger no-ops without stamping the cooldown — there is no point burning a 24h slot on a zero-byte event.
2. **Withdraw.** Move `slice` from the insurance fund to a dedicated buyback pool account. The fund balance and the cooldown timestamp update atomically with the withdrawal.
3. **Emit `BuybackTriggered`.** Carries `timestamp`, `fund_balance_before`, `slice`, `total_protocol_exposure`, `ratio_q`, and the destination pool pubkey. This is the indexer's primary signal that a buyback is in flight, and the only durable record of the ratio at trigger time.
4. **Cranker buys.** A permissionless cranker reads the pool, executes a market buy of $PERCOLATOR against whatever venue the protocol designates (DEX route, Jupiter aggregator — dcccrypto's call), and lands the bought tokens in a burn-authority account.
5. **Cranker burns.** The bought tokens are burned via SPL `Burn`, reducing circulating supply. A `BuybackBurned` event closes the loop with `amount_burned` and the realized buy price.

A few invariants the implementation must hold:

- The cooldown stamp advances iff `slice > 0` and the withdrawal succeeds. A failed withdrawal must roll back the stamp — Anchor's transactional semantics handle this for free if both sit in the same instruction.
- The pool account is single-purpose: it holds at most one undisbursed slice at a time. If a previous slice has not yet been settled when the next trigger fires (24h+ later), the new slice is added on top — no separate accounting per event. Settlement burns whatever the pool holds.
- `BuybackTriggered` and `BuybackBurned` are not paired one-to-one. A single `BuybackBurned` may settle multiple triggers if the cranker fell behind. Indexers should track cumulative burned, not match-by-match.

The on-chain handler's job ends at step 3. Steps 4-5 are the cranker's job and run asynchronously — if the cranker stalls, the next buyback slot is still gated by `last_buyback_ts`, so a stuck pool does not compound. Recovery is "the cranker catches up," not a program-level rollback.

A buyback event is intentionally split across two instructions (trigger, then settle) so the on-chain program never has to embed DEX routing logic. This also means a Jupiter or aggregator outage degrades the buyback gracefully: triggers still fire on schedule, settlement just queues until the swap path returns.

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
- New instruction: `settle_buyback`. Called by the cranker after the off-chain swap lands tokens in the program's burn-authority ATA. Verifies the tokens are $PERCOLATOR, burns them, emits `BuybackBurned`.
- New PDA: the buyback pool account that holds the withdrawn fund slice between trigger and settle. Custody question flagged in section 11.
- New persistent field on the vault config (or a dedicated `BuybackState` PDA): `last_buyback_ts: i64`. Append-only addition in the spirit of the locker's change protocol — never insert mid-struct, never reorder, never resize.
- New events: `BuybackTriggered` and `BuybackBurned`. Both must be append-only within their own structure once shipped, same rule the locker's events follow.

### 6.3 `percolator-keeper` (cranker)

- New crank loop: poll `trigger_buyback` eligibility every N seconds (60-120s feels right; the on-chain cooldown gate is the real ratelimit).
- On a successful trigger, read the pool, route a swap (Jupiter or whatever the protocol standardizes on), land tokens in the burn ATA, call `settle_buyback`.
- Should be tolerant of being one of many crankers — the on-chain cooldown ensures only one trigger lands per 24h slot, the rest get a gate-failure error, log and move on.
- Logging should distinguish "no event because gate X failed" from "no event because cooldown" — the former is informational, the latter is the steady state.
- Failure of the swap leg (slippage exceeded, route unavailable) should not retry blindly. Back off, surface the error, let a human or higher-level system intervene if it persists. The trigger has already happened on-chain; the slice will sit in the pool until settlement succeeds.

### 6.4 `percolator-indexer` (optional, recommended)

- Decode `BuybackTriggered` and `BuybackBurned`. Surface a "buybacks" feed.
- Useful columns: timestamp, slice, ratio at trigger, exposure at trigger, amount burned, realized price.
- Filter rule mirrors the locker's: pin to the canonical vault pubkey, ignore any other vault under the program ID.
- Cumulative-burned counter is the headline metric — useful for the launch site and for any external dashboard tracking the supply story.

## 7. Why These Numbers

### 7.1 Why 1.5x

- 1.0x means the fund exactly covers maintenance-margin worst case. Buying back at 1.0x would, by construction, leave the protocol under-funded the moment any single market's exposure ticks up.
- 1.2x is too tight a margin against oracle noise and OI bursts.
- 2.0x is defensible but parks too much idle capital in the fund before any surplus is recognized — a meaningful drag on the buyback's long-term cumulative effect.
- 1.5x is the smallest ratio that survives a plausible single-market stress test (oracle gap + OI spike) without dropping the fund below 1.0x. It is conservative without being inert.

### 7.2 Why 0.1% per event

- 10 bps is small enough that an erroneous trigger (oracle desync, market-account staleness, math bug) cannot meaningfully damage the fund in a single event.
- It is large enough that, compounded daily across years, it produces a visible burn signal — order of magnitude tens of bps per month at sustained eligibility.
- It bounds the cranker's market impact: 10 bps of the insurance fund is a known-small order size relative to $PERCOLATOR's expected liquidity.

### 7.3 Why 24h

- Pairs cleanly with daily protocol bookkeeping and oracle update cadences.
- Gives the fund a full day to refill from fees between events, so a string of consecutive eligible days does not monotonically drain it.
- Makes the maximum annual drawdown legible: 365 events × 10 bps ≈ 36% of the fund balance per year **in the worst case where every single day is eligible**, which itself requires sustained 1.5x+ coverage. In practice this caps far below 36%.

### 7.4 Why these four conditions and not more

- The four gates each guard a distinct failure mode: under-collateralization (ratio), drain rate (cooldown), absolute floor breach (floor), active stress (haircut). Removing any one of them re-opens a specific failure mode.
- Adding a fifth — e.g., a price-based gate, a volume gate, a circulating-supply gate — moves the system away from "buy when the fund is structurally surplus" toward "buy when conditions look right by some discretionary measure." That is the slope toward governance.
- The four gates are also the four that can be evaluated from on-chain state alone, with no off-chain inputs beyond the oracle the protocol already trusts. This matters: the autonomy property fails the moment a gate depends on a value that requires off-chain attestation.

### 7.5 Why hardcoded

- Same argument as the locker's `MIN_TIER_BRONZE` floor: a buyback whose parameters can be moved by an admin is a buyback whose social contract can be moved by an admin. Burning floats only as much credibility as the rules around it.
- Program upgrades to change any of the four constants are observable on-chain and require the same trust assumption as any other code change — strictly stronger than a config knob.
- The locker's `update_config` rate-limit (7 days, 50% bound, ordering preservation) is the right model for parameters that genuinely need to track market conditions. Buyback parameters do not — they are policy, not tuning surface.

## 8. Observability

The buyback's social contract depends on outsiders being able to verify it is operating as designed. The minimum observable surface:

- **Every trigger emits `BuybackTriggered` with the ratio at firing time.** A third-party can replay history and confirm that no event fired below 1.5x.
- **Every settlement emits `BuybackBurned` with `amount_burned`.** Cumulative-burned is reconstructible from event logs alone, no account-state required.
- **`last_buyback_ts` is on-chain.** Cooldown enforcement is auditable from any RPC.
- **The four constants are in source.** Anyone can read `BUYBACK_RATIO_THRESHOLD`, `BUYBACK_PER_EVENT_BPS`, `BUYBACK_COOLDOWN_SECS` and confirm the values.

A buyback that meets these four points has nowhere to hide a discretionary override — every event is traceable to gate-state at firing time, and every parameter is in the binary. This is the same observability stance the locker takes with `LockPosition.tier` snapshots.

## 9. Failure Modes And Mitigations

What goes wrong, and what stops it from compounding:

- **Stuck cranker.** Trigger fires, slice sits in the pool, no cranker picks it up. Mitigation: cranker is permissionless, anyone can settle. Worst case: tokens-equivalent capital sits idle until somebody runs the settlement leg. The 24h cooldown prevents the pool from accumulating more than ~365 events of stuck slice in a year, and even one settlement clears the entire pool.
- **Oracle desync.** A bad oracle price inflates `oracle_price` and therefore `total_protocol_exposure`, failing the ratio gate when it should pass. Mitigation: this is the safe direction — false negatives (no buyback when one is warranted) are strictly preferred to false positives (buyback when fund is needed).
- **Oracle desync in the other direction.** A stale or manipulated oracle deflates `oracle_price` and inflates the apparent ratio, passing the gate when it should not. Mitigation: the per-event 10 bps cap bounds single-event damage, the cooldown bounds compounding, and the haircut gate catches the case where the protocol is already paying for a real loss the oracle missed.
- **Sandwich on the cranker buy.** A searcher front-runs the buyback's market buy and dumps after. Mitigation: keeper-side slippage bound and the 24h cooldown, which makes the buy schedule too irregular to systematically front-run.
- **Concurrent triggers.** Two crankers race to call `trigger_buyback`. Mitigation: atomic update of `last_buyback_ts` inside the handler — one wins, the other gets `CooldownActive`. Standard Solana account-write semantics handle this.
- **Floor raised faster than fund grows.** Admin raises `insurance_floor` to a level above current balance. Mitigation: floor gate fails immediately, no buyback fires, fund accumulates until it crosses the new floor.
- **Buyback math constants are wrong.** The thresholds turn out to be too aggressive or too conservative under live conditions. Mitigation: program upgrade. There is no shortcut; this is the price of hardcoding.

## 10. Composition With The Locker

The locker and the buyback are designed to interlock without sharing accounts or PDAs. They live in different programs and coordinate only through the token's market price.

- **Locker** — locks float on the demand side. Tokens locked for fee discounts are off the freely-tradeable supply for at least one cycle, then the discount-end window. This is a soft sink: tokens come back when users unlock.
- **Buyback** — burns supply on the protocol side. Surplus insurance fund balance is converted to permanently retired tokens. This is a hard sink: burned tokens never re-enter circulation.

Together they bracket the supply story: discount-driven locking removes float while protocol revenue is being earned, buyback-driven burning permanently retires float in proportion to how over-collateralized the protocol has become. Neither depends on the other to function — the locker works on a protocol with no buyback, and the buyback works on a protocol with no locker — but the two together convert protocol success into both immediate utility (fee discount) and durable supply reduction.

The buyback does not read locker state, and the locker does not read buyback state. The integration surface is the SPL mint and nothing else.

## 11. Open Questions For dcccrypto

These need domain knowledge that lives in the `percolator-vault` and `percolator` repos, not the locker spec.

- **Slab vs market aggregation.** Is `total_protocol_exposure` summed across all slabs (global) or scoped per market and then aggregated? The formula in section 3 assumes global. If exposure is naturally per-slab in the existing math, the aggregation primitive needs to land in `percolator` first.
- **Account walking cost.** The trigger handler needs to see every live market's `oi_eff_long_q`, `oi_eff_short_q`, and `oracle_price`. With a small number of markets, passing them as remaining accounts is fine. Past some N, a periodically-updated exposure cache becomes preferable. dcccrypto to call where N sits today and where it is likely to sit at mainnet.
- **Cranker authority model.** The `trigger_buyback` instruction is sketched as permissionless, with the on-chain gate doing all the gatekeeping. Confirm this matches the existing keeper authority story — if the project has a designated cranker key, the buyback trigger can hang off the same authority.
- **Buyback pool custody.** Where does the withdrawn slice live between `trigger_buyback` and `settle_buyback`? Options: (a) a fresh PDA owned by the vault program, (b) a pre-existing program-owned ATA, (c) reuse the insurance fund account with a sub-balance counter. (a) is the cleanest separation; (c) avoids account-creation cost. dcccrypto's call.
- **DEX routing.** Jupiter aggregator is the obvious default but commits the protocol to Jupiter availability. Is a fallback route required (e.g. direct CLMM pool) or is Jupiter-or-bust acceptable?
- **Slippage bound on the cranker buy.** The cranker needs a max-slippage parameter to avoid sandwich exploitation. This sits in the keeper, not on-chain, but the value should be set deliberately given expected $PERCOLATOR liquidity.
- **Oracle source for `oracle_price` in the formula.** Almost certainly the same oracle the matcher already uses, but worth pinning explicitly so the buyback math and the matcher math cannot diverge. A separate oracle would create arbitrage between the two.
- **Maintenance bps source.** Per-market constant or admin-tunable? If admin-tunable, the buyback inherits whatever change protocol governs that field.
- **Fixed-point representation for the ratio.** The 1.5x threshold needs to be expressed without precision loss at realistic exposure scales. Pick the representation that matches the existing vault math conventions.
- **Burn authority.** The mint authority for $PERCOLATOR — is it already program-controlled, or does the burn flow assume tokens are sent to a sink address that nobody can recover from? The two are equivalent economically but different operationally; only the first lets the program emit a verifiable `Burn` event.
- **Indexer scope.** This proposal lists indexer support as optional. If the launch site needs to display "X $PERCOLATOR burned to date," the indexer becomes load-bearing — flag now or after launch.
- **Mainnet rollout sequencing.** Buyback can ship simultaneously with the protocol or be enabled later. Shipping later means the first batch of buybacks happens against a more mature exposure dataset, which is conservative; shipping simultaneously means the supply story is in place from day one.

Once these are settled, the proposal converts to a spec: precise account layouts, error codes, and event field tables for each new instruction and event.
