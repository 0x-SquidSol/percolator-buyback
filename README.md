# percolator-buyback

A design proposal for an autonomous, protocol-funded buyback of $PERCOLATOR driven by surplus in the Percolator insurance fund. Bought tokens are paired with SOL and added as permanent locked liquidity to the canonical PumpSwap pool — the LP receipt tokens are burned, so the liquidity can never be withdrawn.

This repository is **design-decisions-finalized** — no code yet. The full design lives in [PROPOSAL.md](PROPOSAL.md). Implementation will land across `percolator` (math), `percolator-prog` (wrapper), `percolator-vault` (handler), `percolator-sdk` (encoders), `percolator-keeper` (cranker), and `percolator-indexer` (events feed).

The buyback is the supply-side counterpart to [`percolator-locker`](https://github.com/0x-SquidSol/percolator-locker)'s demand-side fee discount. Locker locks float for fee discounts; buyback locks supply and liquidity in the AMM forever. Together they form the token's full utility loop.

## Status

- **Parameters locked** (compile-time constants): 1.5× insurance ratio threshold, 0.1% per-event slice, 24h cooldown.
- **Four-condition gate locked**: ratio, cooldown, insurance floor, no active haircuts.
- **Mechanic locked**: buy → pair with SOL → add LP → burn LP receipt token via Token-2022.
- **All [PROPOSAL.md §11](PROPOSAL.md#11-design-decisions) design decisions resolved (2026-04-30)** with dcccrypto. Highlights:
    - Per-slab insurance fund (one live market today; hardcoded N=1 invariant forces an upgrade gate at N≥2).
    - Wrapper gains a new permissionless instruction tag for the slice withdrawal; vault hosts the four-condition gate and CPIs in.
    - Three-transaction cranker round-trip (Jupiter → PumpSwap legs + LP burn → settle).
    - PumpSwap upgrade-authority risk mitigated by an on-chain binary-hash pin and an emergency-drain instruction reachable only via program upgrade.
    - Indexer ships at T+0 to surface cumulative LP burned and locked-liquidity USD-equivalent.

Implementation roadmap, deployment sequencing, and operational details are tracked privately and will surface as PRs land in the implementing repos.

## License

MIT — see [LICENSE](LICENSE).
