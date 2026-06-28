# percolator-buyback

A design and reference implementation for an autonomous, protocol-funded buyback that runs **per market**. Each market funds a buyback of its own token from a **protocol-fee increment** — a small, additive maintenance-fee charge routed to a protocol-owned treasury, never from staker capital. The treasury buys the market's token, pairs it with the market's quote asset, adds the pair as permanent locked liquidity to that token's pool, and burns the LP receipt tokens, so the liquidity can never be withdrawn.

The defining constraint is that **insurance-LP stakers are kept whole — in fact, better than whole**. The buyback spends only protocol revenue that was never owed to stakers (the staker firewall is an already-Kani-proven engine invariant), and on a market loss the treasury tops stakers up toward a reserve target *first*, buying back only the remainder and auto-pausing under stress. The buyback program can debit **only** its own treasury — never insurance, the stake vault, or any LP principal — so there is **no wrapper change and no instruction path that can touch staker funds**.

This repository is the **design home**. The authoritative funding/architecture spec is [docs/superpowers/specs/2026-06-28-protocol-fee-funded-buyback-design.md](docs/superpowers/specs/2026-06-28-protocol-fee-funded-buyback-design.md); [PROPOSAL.md](PROPOSAL.md) carries the mechanic and rationale, and integration tracking lives in [INTEGRATION.md](INTEGRATION.md). Reference implementations of standalone modules are staged under [`crates/`](crates/) and [`packages/`](packages/) — these compile and test in isolation here before being transferred into the live repos. Implementation lands across `percolator` (math gate), `percolator-stake` (funding setup, treasury, gate, events), `percolator-sdk` (encoders), `percolator-keeper` (cranker), and `percolator-indexer` (events feed). **The wrapper (`percolator-prog`) is unchanged.**

## Status

- **Funding**: a raised maintenance-fee *increment* accrues to a protocol-owned cranker portfolio (reusing the audited maintenance-fee path), swept into a per-market `BuybackTreasury` PDA. Strictly additive — traders pay the increment; stakers' existing flow is untouched. The funding *rate* is governance policy; the buyback *gate* is hardcoded.
- **Staker firewall**: the reward credit is rejected if it would dip into staker-budgeted insurance (`credit_account_from_insurance_delta`, already Kani-proven), and the buyback program can debit only the treasury. Stakers cannot lose principal to the buyback.
- **Reserve-first backstop**: on a market loss the treasury credits stakers toward a reserve target *before* any buyback, so stakers end up better than whole.
- **Gate** (hardcoded, no admin off-switch): 24h cooldown, treasury above a floor, non-zero exposure, a per-event slice cap of the treasury, and a health/auto-pause check — evaluated **per market**.
- **Mechanic**: buy the market's token → pair with the market's quote asset → add LP → burn the LP receipt token via Token-2022.
- **Per market, per token**: each market binds its own token mint, pool, LP mint, and pair asset once at launch and immutable thereafter; the buyback token must differ from the market's collateral.
- **AMM**: an in-house AMM is recommended (removes the only Critical risk and drops a swap leg); a pinned external pool (binary-hash pin + `BPFLoaderUpgradeable` owner check) is the interim option.
- **Wrapper**: no change. The previously-planned `WithdrawForBuyback` instruction is dropped — the buyback never touches the insurance fund.

## License

MIT — see [LICENSE](LICENSE).
