/**
 * @module lib/log
 *
 * Single-point logger abstraction for the staged keeper service. Used
 * everywhere a service file would otherwise call `console.log` /
 * `console.warn` / `console.error` directly. Centralizing the surface
 * means the integrator's transfer-time swap to the destination's
 * logger (`createLogger("keeper:buyback")` from `@percolatorct/shared`) is
 * a one-line edit to this file rather than every call site.
 *
 * **Transfer destination:** does NOT cross over. The destination
 * keeper imports `createLogger` from `@percolatorct/shared` directly
 * in each service. At transfer, replace each `import { log } from
 * "../lib/log.js"` in our staged services with the destination's
 * `import { createLogger } from "@percolatorct/shared"` plus a
 * top-of-file `const log = createLogger("keeper:buyback");`.
 *
 * **Post-transfer verification:** in destination's `src/services/`
 * (the only place staged service files land), `grep -r '"../lib/log.js"'
 * src/services/` MUST return zero hits. A surviving occurrence means
 * a service file was copied without rewriting the import — the
 * destination would silently degrade to `console`, bypassing
 * `@percolatorct/shared`'s Sentry breadcrumbs and Discord critical
 * alerts. tsc catches the dangling import only if `lib/log.js` is
 * also dropped from destination (which it should be — the file is
 * staging-only); the grep is a belt-and-suspenders check that
 * matches the same post-replace-grep idiom INTEGRATION.md uses for
 * the `STAKE_IX_BUYBACK` rewiring.
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
 *
 * **Why are `BuybackLogFields` and `Logger` un-exported?** Both
 * interfaces describe the shape of the staging-time `log` const, and
 * neither has a destination-side equivalent in `@percolatorct/shared`.
 * Exporting them would invite a service file to write `import type
 * { Logger } from "../lib/log.js"` — that named import dangles at
 * transfer time, when this file is dropped from the destination.
 * Keeping the types file-local pushes the failure into staging-time
 * tsc rather than letting it leak into post-transfer destination
 * code. Service files lose nothing: TypeScript's contextual typing
 * propagates `BuybackLogFields` through the `log: Logger` declaration,
 * so the field schema (and the `outcome` literal union) still
 * autocompletes at every `log.info(msg, { ... })` call site without
 * requiring a named-type import.
 */

/**
 * Fields attached to every structured log entry from the buyback
 * staged services. Keeping the schema explicit means the integrator's
 * `createLogger` swap can preserve field names verbatim and downstream
 * log consumers (Sentry, Loki, Discord webhooks) keep working.
 *
 * The service-namespace tag (`"keeper:buyback"`) is intentionally NOT
 * a field here. The destination's `createLogger("keeper:buyback")`
 * injects the namespace at construction time — duplicating it on
 * every call site would force the integrator to strip it at transfer
 * (or risk double-tagging / overwriting the constructor-bound value).
 * Staged call sites pass only domain fields, byte-identical to
 * destination call sites like `logger.info("msg", { slot })`.
 */
interface BuybackLogFields {
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
  /**
   * Optional — additional ad-hoc context. Restricted to primitive
   * values so the type system blocks accidental object logging
   * (e.g. `{ keypair }`, `{ ...rpcConfig }`, `{ connection }`) which
   * would silently leak secrets and full RPC payloads to the
   * destination's downstream consumers (Sentry, Loki, Discord
   * webhooks). Stringify objects at the call site if you really need
   * to log them.
   */
  [key: string]: string | number | bigint | boolean | null | undefined;
}

/**
 * Logger surface. Implementations must accept a free-form message and
 * an optional structured-fields object. `console` already satisfies
 * this contract (its overloads accept `(...args: unknown[])`), so the
 * staging-time export is plain `console`. The destination's
 * `createLogger` returns an object with the same `info`/`warn`/`error`
 * methods.
 */
interface Logger {
  info(message: string, fields?: BuybackLogFields): void;
  warn(message: string, fields?: BuybackLogFields): void;
  error(message: string, fields?: BuybackLogFields): void;
}

/**
 * Staging-time logger. Plain `console`. At transfer the integrator
 * replaces this export with `createLogger("keeper:buyback")` from
 * `@percolatorct/shared` (single-line edit).
 */
export const log: Logger = console;
