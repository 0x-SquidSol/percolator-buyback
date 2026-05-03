// Buyback SDK staging — entry point.
//
// Re-exports the public surface staged for transfer into
// `dcccrypto/percolator-sdk`. Each exported symbol's destination is
// documented in the file where it's defined.
//
// At transfer time, this file does NOT cross over: the destination SDK
// has its own `src/index.ts` barrel that re-exports everything via
// `export * from "./solana/stake.js"`. The buyback additions are
// merged into the destination's existing modules, not dropped as a
// standalone package.
//
// Until then, this barrel mirrors the destination's shape so the
// keeper-staging package can import via the bare `@percolatorct/sdk`
// specifier (resolved by tsconfig path alias + vitest resolve.alias to
// this file) without any deep-import rewrites at transfer time.
export * from "./solana/stake-buyback.js";
export * from "./solana/constants.js";
export * from "./events/buyback.js";
export * from "./errors/buyback.js";
export * from "./abi/encode.js";
