/**
 * createReferenceProvider — the canonical in-memory CapabilityProvider. Ships in the
 * main barrel (zero-dep, browser-safe): Moon can use it for UI-owned/local capabilities,
 * and the conformance suite runs against it to prove the suite and the reference agree.
 *
 * It models the port contract precisely: decode runs at ingest (setRawCatalog), execute
 * routes on (kind,id) against the CURRENT catalog and records the routing, and nothing
 * ever throws or rejects for an ordinary condition.
 */

import { decodeCapabilityCatalog, type CapabilityCatalog, type CapabilityDescriptor } from "./descriptor.js"
import type {
  CapabilityProvider,
  CatalogSnapshot,
  ExecuteOutcome,
  ExecuteRequest,
  ExecuteResult,
  Unsubscribe,
} from "./provider.js"

export interface RecordedExecution {
  readonly kind: string
  readonly id: string
  readonly args?: string
}

/** Decides an execute's outcome for the in-memory provider. Throwing is caught → backend-error. */
export type ReferenceExecuteHandler = (
  request: ExecuteRequest,
) =>
  | { ok: true; value?: ExecuteOutcome }
  | { ok: false; error: string; reason?: "backend-error" | "unsupported" }

export interface ReferenceProvider extends CapabilityProvider {
  /** Replace the live catalog from RAW (untrusted) input — decoded at the boundary — and notify subscribers. */
  setRawCatalog(rawCatalog: unknown): void
  /** Force the unreachable state: list/subscribe emit {ok:false}; execute → "unavailable". */
  setUnavailable(error: string): void
  /** Recorded executions in call order — the routing oracle for the conformance suite. */
  readonly executions: readonly RecordedExecution[]
}

export interface ReferenceProviderOptions {
  /** Initial RAW catalog, decoded at construction. Omit ⇒ empty catalog. */
  readonly initial?: unknown
  /** Decide execute outcomes. Omit ⇒ "present in the current catalog ⇒ ok". */
  readonly onExecute?: ReferenceExecuteHandler
}

const EMPTY_CATALOG: CapabilityCatalog = { generation: 0, agreedSchema: 1, capabilities: [] }
const keyOf = (kind: string, id: string): string => `${kind}${String.fromCharCode(0)}${id}`

interface State {
  readonly snapshot: CatalogSnapshot
  readonly index: Map<string, CapabilityDescriptor>
}

const stateFromRaw = (raw: unknown): State => {
  const decoded = decodeCapabilityCatalog(raw)
  if (!decoded.ok) return { snapshot: { ok: false, error: decoded.error }, index: new Map() }
  const index = new Map<string, CapabilityDescriptor>()
  for (const c of decoded.value.capabilities) index.set(keyOf(c.kind, c.id), c)
  return { snapshot: { ok: true, catalog: decoded.value, rejected: decoded.rejected }, index }
}

export function createReferenceProvider(opts?: ReferenceProviderOptions): ReferenceProvider {
  const listeners = new Set<(s: CatalogSnapshot) => void>()
  const executions: RecordedExecution[] = []
  let state: State =
    opts?.initial === undefined
      ? { snapshot: { ok: true, catalog: EMPTY_CATALOG, rejected: [] }, index: new Map() }
      : stateFromRaw(opts.initial)

  // Broadcast the CURRENT snapshot. Iterate a copy so a callback can (un)subscribe mid-emit,
  // and isolate each callback so one throwing subscriber can't break siblings. Re-entrant
  // changes (a subscriber that mutates the catalog from inside its own callback) are coalesced
  // into a follow-up pass rather than recursing — so a self-feeding subscriber can't overflow
  // the stack.
  let emitting = false
  let pending = false
  const emit = (): void => {
    if (emitting) {
      pending = true
      return
    }
    emitting = true
    try {
      do {
        pending = false
        const snapshot = state.snapshot
        for (const fn of [...listeners]) {
          try {
            fn(snapshot)
          } catch {
            /* one bad subscriber is isolated */
          }
        }
      } while (pending)
    } finally {
      emitting = false
    }
  }

  return {
    list() {
      return Promise.resolve(state.snapshot)
    },

    subscribe(onChange) {
      listeners.add(onChange)
      let live = true
      // Async initial emit so a handler that unsubscribes itself is never re-entered,
      // and so subscribe()/list() never race. Cancelled if unsubscribe runs first.
      queueMicrotask(() => {
        if (live && listeners.has(onChange)) {
          try {
            onChange(state.snapshot)
          } catch {
            /* isolated */
          }
        }
      })
      let done = false
      return () => {
        if (done) return
        done = true
        live = false
        listeners.delete(onChange)
      }
    },

    execute(request) {
      if (request == null) {
        const r: ExecuteResult = { ok: false, error: "execute requires a request", reason: "unknown" }
        return Promise.resolve(r) // total: a null/undefined request never throws
      }
      if (!state.snapshot.ok) {
        const r: ExecuteResult = { ok: false, error: state.snapshot.error, reason: "unavailable" }
        return Promise.resolve(r)
      }
      const found = state.index.get(keyOf(request.kind, request.id))
      if (found === undefined) {
        const r: ExecuteResult = {
          ok: false,
          error: `unknown capability ${request.kind}/${request.id}`,
          reason: "unknown",
        }
        return Promise.resolve(r) // unknown → no routing, no record
      }

      // Reached the backend → record the routing (args preserved verbatim, absent stays absent).
      executions.push(
        request.args === undefined
          ? { kind: request.kind, id: request.id }
          : { kind: request.kind, id: request.id, args: request.args },
      )

      const handler = opts?.onExecute
      if (handler === undefined) return Promise.resolve({ ok: true, value: {} })

      let decision: ReturnType<ReferenceExecuteHandler>
      try {
        decision = handler(request)
      } catch (e) {
        const r: ExecuteResult = {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          reason: "backend-error",
        }
        return Promise.resolve(r)
      }
      const r: ExecuteResult = decision.ok
        ? { ok: true, value: decision.value ?? {} }
        : { ok: false, error: decision.error, reason: decision.reason ?? "backend-error" }
      return Promise.resolve(r)
    },

    setRawCatalog(rawCatalog) {
      state = stateFromRaw(rawCatalog)
      emit()
    },

    setUnavailable(error) {
      state = { snapshot: { ok: false, error }, index: new Map() }
      emit()
    },

    get executions() {
      return [...executions]
    },
  }
}
