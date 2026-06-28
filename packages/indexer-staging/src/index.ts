// Buyback indexer staging — entry point.
//
// At transfer time this file does NOT cross over: the destination indexer has
// its own entry that wires the HTTP (Hono) + DB (Supabase) layers. The buyback
// aggregator (added under src/ in subsequent commits) merges into the
// destination's event-processing pipeline; each file documents its own
// transfer destination in its header.
export {};
