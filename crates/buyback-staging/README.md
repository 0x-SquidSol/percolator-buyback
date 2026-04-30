# buyback-staging

This is a staging crate, not a published one. Its sole purpose is to compile-and-test the file at `src/buyback.rs` in isolation before that file is transferred into the live math crate at `dcccrypto/percolator`.

The file's contents are intentionally stdlib-only and carry no Solana dependencies, so it can be exercised here without pulling in the rest of the protocol's build context. See [`../../INTEGRATION.md`](../../INTEGRATION.md) for the transfer steps and the broader integration plan.

Local verification:

```sh
cargo build -p buyback
cargo test -p buyback
cargo clippy -p buyback -- -D warnings
cargo fmt -p buyback -- --check
cargo doc -p buyback --no-deps
```

All five commands must be clean before changes here are pushed.
