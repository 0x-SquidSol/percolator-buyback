/**
 * Verification-only test suite for `src/decode-logs.ts`. Proves the log->event
 * router extracts `Program data:` chunks, routes them through the SDK decoder,
 * skips unrelated lines, and feeds straight into the aggregator.
 */
import { describe, it, expect } from "vitest";
import {
  BUYBACK_TRIGGERED_DISCRIMINATOR,
  LIQUIDITY_LOCKED_DISCRIMINATOR,
} from "@percolatorct/sdk";
import {
  extractProgramDataChunks,
  decodeBuybackEventsFromLogs,
} from "../src/decode-logs.js";
import { aggregate } from "../src/aggregate.js";

// The router cares about discriminator routing, not field values (those are
// covered in the SDK decoder suite), so zero-filled field sections of the
// correct length suffice: 112 for triggered, 120 for locked.
function triggeredChunk(): Uint8Array {
  return Buffer.concat([
    Buffer.from(BUYBACK_TRIGGERED_DISCRIMINATOR),
    Buffer.alloc(112),
  ]);
}
function lockedChunk(): Uint8Array {
  return Buffer.concat([
    Buffer.from(LIQUIDITY_LOCKED_DISCRIMINATOR),
    Buffer.alloc(120),
  ]);
}
function programDataLine(chunk: Uint8Array): string {
  return "Program data: " + Buffer.from(chunk).toString("base64");
}

describe("extractProgramDataChunks", () => {
  it("extracts and base64-decodes only Program data lines", () => {
    const chunk = triggeredChunk();
    const chunks = extractProgramDataChunks([
      "Program invoke [1]",
      programDataLine(chunk),
      "Program log: noise",
    ]);
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0])).toEqual(Array.from(chunk));
  });
});

describe("decodeBuybackEventsFromLogs", () => {
  it("decodes a single triggered event", () => {
    const events = decodeBuybackEventsFromLogs([
      "Program invoke [1]",
      programDataLine(triggeredChunk()),
      "Program success",
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("triggered");
  });

  it("decodes triggered + locked in order, skipping unrelated chunks", () => {
    const unrelated = Buffer.concat([
      Buffer.from(new TextEncoder().encode("OTHEREVT")),
      Buffer.alloc(50),
    ]);
    const events = decodeBuybackEventsFromLogs([
      programDataLine(triggeredChunk()),
      "Program log: something",
      programDataLine(unrelated),
      programDataLine(lockedChunk()),
    ]);
    expect(events.map((e) => e.kind)).toEqual(["triggered", "locked"]);
  });

  it("returns empty when there are no Program data lines", () => {
    expect(
      decodeBuybackEventsFromLogs(["Program invoke [1]", "Program success"]),
    ).toEqual([]);
  });

  it("feeds straight into the aggregator", () => {
    const events = decodeBuybackEventsFromLogs([
      programDataLine(triggeredChunk()),
      programDataLine(lockedChunk()),
    ]);
    const metrics = aggregate(events);
    expect(metrics.triggers).toBe(1);
    expect(metrics.settles).toBe(1);
  });
});
