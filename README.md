# percolator-buyback

A design and reference implementation for an autonomous, protocol-funded buyback that runs **per market**. Each market's surplus insurance fund buys back that market's own token, pairs it with the market's quote asset, and adds the pair as permanent locked liquidity to that token's pool — the LP receipt tokens are burned, so the liquidity can never be withdrawn.

A buyback fires only while a market's insurance fund is well above the risk it carries. The slice is a small fraction of surplus and is clamped above the fund's solvency floor, so the buyback can never weaken a market's ability to socialize a loss. The bought token is shipped straight into burned LP and is never held by the fund — the fund stays denominated in its collateral and never backs itself with the token it buys.

This repository is the **design home**. The full design lives in [PROPOSAL.md](PROPOSAL.md), and integration tracking lives in [INTEGRATION.md](INTEGRATION.md). Reference implementations of standalone modules are staged under [`crates/`](crates/) and [`packages/`](packages/) — these compile and test in isolation here before being transferred into the live repos. Implementation lands across `percolator` (math), `percolator-prog` (wrapper), `percolator-stake` (handler, state, events), `percolator-sdk` (encoders), `percolator-keeper` (cranker), and `percolator-indexer` (events feed).

## Status

- **Parameters** (compile-time constants): 1.5× insurance-ratio threshold, 0.1% per-event slice, 24h cooldown.
- **Gate**: cooldown, insurance floor, no active haircut, a non-zero-exposure precondition, and the ratio — all evaluated **per market** against that market's own insurance fund and exposure.
- **Mechanic**: buy the market's token → pair with the market's quote asset → add LP → burn the LP receipt token via Token-2022.
- **Per market, per token**: each market binds its own token mint, pool, LP mint, and pair mint once at launch and immutable thereafter. The buyback token must differ from the market's collateral — mirroring the stake program's existing collateral≠LP-mint guard — so a market never buys its own backing.
- **Pair asset — bound per market**: SOL today, since the canonical PumpSwap pools are SOL-paired (the slice converts via Jupiter); USDC when the pools are launched in-house, which drops the conversion leg.
- **Cranker**: three-transaction round-trip (convert → buy + add-LP + LP burn → settle); events carry the token mint so each market's buybacks are distinguishable on-chain.
- **External dependency**: a third-party AMM pool's upgrade authority is the design's main external risk, mitigated by an on-chain binary-hash pin and an emergency-drain path reachable only via program upgrade. Launching pools on an in-house AMM removes this surface.

## License

MIT — see [LICENSE](LICENSE).
