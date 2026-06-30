/**
 * @module decode-logs
 *
 * Turn a transaction's program logs into decoded buyback events for the
 * aggregator. percolator-stake emits each event as a `Program data: <base64>`
 * line carrying one `[8-byte discriminator][field section]` chunk (a single
 * `sol_log_data` call). This module extracts those lines, base64-decodes them,
 * and routes each through the SDK's `decodeBuybackEvent`; non-buyback
 * `Program data:` lines — other events, or another program in the same
 * transaction — decode to `null` and are skipped.
 *
 * **Transfer destination:** `dcccrypto/percolator-indexer/src/` — sits ahead of
 * `aggregate.ts` in the event-processing pipeline. Uses Node `Buffer` for
 * base64; the destination may swap to its preferred decoder.
 */

import { decodeBuybackEvent, type BuybackEvent } from "@percolatorct/sdk";

/** Prefix the Solana runtime prepends to a `sol_log_data` line. */
const PROGRAM_DATA_PREFIX = "Program data: ";

/**
 * Extract and base64-decode every `Program data:` chunk from a log array, in
 * order. For a single-chunk `sol_log_data` (what the buyback emitter uses) the
 * payload is one base64 token after the prefix; only that first token is
 * decoded. Returns every program-data chunk — buyback or not; the caller
 * filters.
 */
export function extractProgramDataChunks(
  logs: readonly string[],
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const token = line.slice(PROGRAM_DATA_PREFIX.length).split(" ")[0] ?? "";
    chunks.push(new Uint8Array(Buffer.from(token, "base64")));
  }
  return chunks;
}

/**
 * Decode every buyback event in a transaction's logs, in emission order.
 * Non-buyback program-data lines are skipped. A chunk whose discriminator
 * matches a buyback event but whose field section is the wrong length throws
 * (via `decodeBuybackEvent`) — a corrupt event is surfaced, not silently
 * dropped.
 */
export function decodeBuybackEventsFromLogs(
  logs: readonly string[],
): BuybackEvent[] {
  const events: BuybackEvent[] = [];
  for (const chunk of extractProgramDataChunks(logs)) {
    const decoded = decodeBuybackEvent(chunk);
    if (decoded !== null) events.push(decoded);
  }
  return events;
}
