//! Staging crate for the buyback module destined for `dcccrypto/percolator`.
//!
//! The single load-bearing file is [`buyback`]; this `lib.rs` exists only so
//! the file compiles and tests in isolation. When the contents of
//! `src/buyback.rs` are transferred into the live math crate, that crate's
//! `lib.rs` adds the same `pub mod buyback;` line.

pub mod buyback;
