/**
 * createFrameCapabilityProvider — a CapabilityProvider (the Cycle-3 port) backed by a
 * request/response FRAME channel. Generic over any transport that can send a frame and
 * deliver server frames (Moon WS, ui-web WS, …), so "add a backend" reuses this instead
 * of re-implementing the port per frontend.
 *
 * It consumes server->client `capability-catalog` frames (decoded at the boundary to
 * populate the catalog) and `capability-execute-result` frames (keyed by requestId, to
 * resolve executions); it sends client->server `capability-execute` frames. Zero-dep.
 */

import { decodeCapabilityCatalog } from "./descriptor.js"
import type { CapabilityProvider, CatalogSnapshot, ExecuteResult, Unsubscribe } from "./provider.js"

/** A bidirectional frame channel to a backend that speaks the capability frames. */
export interface FrameTransport {
  /** Send a client->server frame (a plain JSON object). */
  readonly send: (frame: unknown) => void
  /** Subscribe to server->client frames; returns an unsubscribe. The provider filters by `frame.type`. */
  readonly onFrame: (handler: (frame: unknown) => void) => Unsubscribe
}

export interface FrameProviderOptions {
  /**
   * Session context merged into every capability-execute frame's `args` (e.g. the
   * active threadId). Re-read per execute so it's always current. The user's typed
   * argument string (ExecuteRequest.args) rides alongside under `args.text`.
   */
  readonly context?: () => Record<string, unknown> | undefined
  /** ms before a pending execute resolves {ok:false, reason:"unavailable"}. Default 15000; 0 disables. */
  readonly executeTimeoutMs?: number
  /** Generate a request id. Default is an internal counter (deterministic; no crypto dependency). */
  readonly newRequestId?: () => string
}

export function createFrameCapabilityProvider(
  transport: FrameTransport,
  opts?: FrameProviderOptions,
): CapabilityProvider {
  const timeoutMs = opts?.executeTimeoutMs ?? 15_000
  let counter = 0
  const newRequestId = opts?.newRequestId ?? (() => `cap-${++counter}`)

  let snapshot: CatalogSnapshot = { ok: false, error: "no capability-catalog received yet" }
  const listeners = new Set<(s: CatalogSnapshot) => void>()
  const pending = new Map<string, (r: ExecuteResult) => void>()

  const emit = (s: CatalogSnapshot): void => {
    for (const fn of [...listeners]) {
      try {
        fn(s)
      } catch {
        /* isolate one bad subscriber */
      }
    }
  }

  // Single inbound handler; filters by frame.type. (The transport may register it for
  // specific frame types or for all frames — the provider ignores anything it doesn't own.)
  transport.onFrame((frame) => {
    if (typeof frame !== "object" || frame === null) return
    const f = frame as Record<string, unknown>
    if (f.type === "capability-catalog") {
      const dec = decodeCapabilityCatalog(f.catalog)
      snapshot = dec.ok ? { ok: true, catalog: dec.value, rejected: dec.rejected } : { ok: false, error: dec.error }
      emit(snapshot)
    } else if (f.type === "capability-execute-result") {
      const id = typeof f.requestId === "string" ? f.requestId : ""
      const resolve = pending.get(id)
      if (resolve) {
        pending.delete(id)
        resolve(
          f.ok === true
            ? { ok: true, value: {} }
            : { ok: false, error: typeof f.message === "string" ? f.message : "command failed", reason: "backend-error" },
        )
      }
    }
  })

  const isKnown = (kind: string, id: string): boolean =>
    snapshot.ok && snapshot.catalog.capabilities.some((c) => c.kind === kind && c.id === id)

  return {
    list() {
      return Promise.resolve(snapshot)
    },

    subscribe(onChange) {
      listeners.add(onChange)
      let live = true
      queueMicrotask(() => {
        if (live && listeners.has(onChange)) {
          try {
            onChange(snapshot)
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
        return Promise.resolve(r)
      }
      // No catalog yet ⇒ the backend is effectively unavailable (don't route).
      if (!snapshot.ok) {
        const r: ExecuteResult = { ok: false, error: snapshot.error, reason: "unavailable" }
        return Promise.resolve(r)
      }
      // Route only what the current catalog advertises; never send a frame for an
      // unknown (kind,id). Matches the port contract (unknown ⇒ no routing recorded).
      if (!isKnown(request.kind, request.id)) {
        const r: ExecuteResult = { ok: false, error: `unknown capability ${request.kind}/${request.id}`, reason: "unknown" }
        return Promise.resolve(r)
      }

      const requestId = newRequestId()
      const args: Record<string, unknown> = { ...(opts?.context?.() ?? {}) }
      if (request.args !== undefined && request.args !== "") args.text = request.args

      return new Promise<ExecuteResult>((resolve) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | null = null
        const finish = (r: ExecuteResult): void => {
          if (settled) return
          settled = true
          if (timer !== null) clearTimeout(timer) // release the timeout once resolved
          pending.delete(requestId)
          resolve(r)
        }
        pending.set(requestId, finish)
        try {
          transport.send({ type: "capability-execute", requestId, kind: request.kind, id: request.id, args })
        } catch (e) {
          finish({ ok: false, error: e instanceof Error ? e.message : String(e), reason: "unavailable" })
          return
        }
        if (timeoutMs > 0) {
          timer = setTimeout(() => finish({ ok: false, error: "no response from backend", reason: "unavailable" }), timeoutMs)
        }
      })
    },
  }
}
