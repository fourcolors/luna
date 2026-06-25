/**
 * The CapabilityProvider port — the single version-aware seam each transport adapter
 * (Hermes HTTP/SSE, Luna WS, OpenClaw) implements. It normalizes backend-native data
 * into the decoded capability envelope and routes execution back to the backend.
 *
 * Async-total: no method REJECTS for an ordinary backend condition. list/subscribe
 * surface an unreachable backend as an `{ok:false}` snapshot; execute surfaces it as
 * `{ok:false, reason:"unavailable"}`. A rejected Promise means the provider itself is
 * broken — the conformance suite forbids it. This is the async analogue of the
 * "decoders are total — they never throw" rule from Cycle 1.
 */

import type { CapabilityCatalog, CapabilityDescriptor } from "./descriptor.js"

/** Why an execute did not succeed — lets the UI branch without string-matching `error`. */
export type ExecuteFailureReason =
  | "unknown" // provider does not recognize (kind,id)
  | "unsupported" // recognized, but this provider can't execute it
  | "backend-error" // backend ran it and reported failure
  | "unavailable" // backend unreachable / not connected / timed out

/** What a successful execution yields. Opaque to the package; the kind's renderer interprets it. */
export interface ExecuteOutcome {
  readonly detail?: Record<string, unknown>
}

export type ExecuteResult =
  | { readonly ok: true; readonly value: ExecuteOutcome }
  | { readonly ok: false; readonly error: string; readonly reason: ExecuteFailureReason }

/** Identifies WHAT to execute. Routes on (kind,id) — the same stability anchor merge keys on. */
export interface ExecuteRequest {
  readonly kind: CapabilityDescriptor["kind"]
  readonly id: string
  /** Raw, post-token argument text the user typed. The provider parses it per-kind. */
  readonly args?: string
}

/** A capability the provider received but could not decode — surfaced, never dropped. */
export interface RejectedEntry {
  readonly index: number
  readonly error: string
}

/**
 * What `list` returns and `subscribe` delivers: the decoded catalog (generation included)
 * plus the boundary report, or a transport-error when the backend is unreachable.
 */
export type CatalogSnapshot =
  | { readonly ok: true; readonly catalog: CapabilityCatalog; readonly rejected: readonly RejectedEntry[] }
  | { readonly ok: false; readonly error: string }

export type Unsubscribe = () => void

export interface CapabilityProvider {
  /** Current catalog as a one-shot. Always resolves (never rejects). Returns the FULL decoded catalog. */
  list(): Promise<CatalogSnapshot>

  /**
   * Observe the catalog. Emits the current snapshot exactly once, ASYNCHRONOUSLY (next
   * microtask) on subscribe — so a handler that unsubscribes itself can't be re-entered —
   * then again on every subsequent change. Multiple subscribers supported. The returned
   * Unsubscribe is idempotent and, once called, prevents any further (incl. in-flight) emit.
   */
  subscribe(onChange: (snapshot: CatalogSnapshot) => void): Unsubscribe

  /** Route an execution back to the backend. Resolves an ExecuteResult; never rejects for an ordinary failure. */
  execute(request: ExecuteRequest): Promise<ExecuteResult>
}
