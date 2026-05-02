// Buyback keeper staging — entry point.
//
// At transfer time, this file does NOT cross over: the destination
// keeper has its own `src/index.ts` that wires up the existing
// services (adl, crank, liquidation, monitor, oracle). The buyback
// service merges in alongside them.
//
// Each file under `src/services/` (added in subsequent commits)
// documents its own transfer destination in its header.
export {};
