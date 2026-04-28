# percolator-buyback

A design proposal for an autonomous, protocol-funded buyback and burn of the $PERCOLATOR token, driven by surplus in the Percolator insurance fund.

This repository is **proposal stage** — no code yet. The full design lives in [PROPOSAL.md](PROPOSAL.md). Once the design is reviewed and refined, this repo will host the implementation across the matching set of `percolator-vault`, `percolator`, and `percolator-keeper` changes.

The buyback is the supply-side counterpart to [`percolator-locker`](https://github.com/0x-SquidSol/percolator-locker)'s demand-side fee discount. Locker locks float; buyback retires it. Together they form the token's full utility loop.

## Status

- Parameters approved: 1.5× insurance ratio threshold, 0.1% per-event slice, 24h cooldown, hardcoded
- Four-condition gate decided
- Cross-repo plumbing details flagged as open questions for review

See [PROPOSAL.md §11](PROPOSAL.md#11-open-questions-for-dcccrypto) for what still needs domain input before this converts to a spec.

## License

MIT — see [LICENSE](LICENSE).
