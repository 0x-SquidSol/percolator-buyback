/**
 * @module lib/log
 *
 * Single-point logger abstraction for the staged keeper service. Used
 * everywhere a service file would otherwise call `console.log` /
 * `console.warn` / `console.error` directly. Centralizing the surface
 * means the integrator's transfer-time swap to the destination's
 * logger (`createLogger("buyback")` from `@percolatorct/shared`) is
 * a one-line edit to this file rather than every call site.
 *
 * **Transfer destination:** does NOT cross over. The destination
 * keeper imports `createLogger` from `@percolatorct/shared` directly
 * in each service. At transfer, replace each `import { log } from
 * "../lib/log.js"` in our staged services with the destination's
 * `import { createLogger } from "@percolatorct/shared"` plus a
 * top-of-file `const log = createLogger("buyback");`.
 *
 * **Why not match the destination's createLogger shape locally?**
 * The destination's logger lives in `@percolatorct/shared` (a
 * separate repo). Vendoring it for staging would mean copying a
 * cross-cutting utility surface (config, Sentry, Discord alerts,
 * connection factory, keypair loader) we don't need to verify our
 * buyback-specific code. The staging contract is: write logic that
 * uses `log.info(...)` / `log.warn(...)` / `log.error(...)` with
 * structured fields; the integrator's `createLogger` honors the same
 * `info`/`warn`/`error` interface so the call sites need no change.
 */

/**
 * Fields attached to every structured log entry from the buyback
 * staged services. Keeping the schema explicit means the integrator's
 * `createLogger` swap can preserve field names verbatim and downstream
 * log consumers (Sentry, Loki, Discord webhooks) keep working.
 */
export interface BuybackLogFields {
  /** Always set. Identifies the staged service emitting the log. */
  service: "buyback";
  /** Optional — Solana slab pubkey when the log refers to a specific market. */
  slab?: string;
  /** Optional — current Solana slot when the log was emitted. */
  slot?: number;
  /** Optional — outcome of the eligibility probe ("would-fire" | "blocked" | "rpc-error" | "not-live"). */
  outcome?: "would-fire" | "blocked" | "rpc-error" | "not-live";
  /** Optional — `BuybackBlocker` variant name on a "blocked" outcome. */
  blocker?: string;
  /** Optional — slice amount (collateral base units) on a "would-fire" outcome. */
  slice?: string;
  /** Optional — additional unstructured context. */
  [key: string]: unknown;
}

/**
 * Logger surface. Implementations must accept a free-form message and
 * an optional structured-fields object. `console` already satisfies
 * this contract (its overloads accept `(...args: unknown[])`), so the
 * staging-time export is plain `console`. The destination's
 * `createLogger` returns an object with the same `info`/`warn`/`error`
 * methods.
 */
export interface Logger {
  info(message: string, fields?: BuybackLogFields): void;
  warn(message: string, fields?: BuybackLogFields): void;
  error(message: string, fields?: BuybackLogFields): void;
}

/**
 * Staging-time logger. Plain `console`. At transfer the integrator
 * replaces this export with `createLogger("buyback")` from
 * `@percolatorct/shared` (single-line edit).
 */
export const log: Logger = console;
