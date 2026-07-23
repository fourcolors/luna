/**
 * Studio deep-link parsing + global-Tauri bridge.
 *
 * The Rust side registers the `luna://` URL scheme and hands the launch/warm
 * URL to the web layer two ways: a one-shot drain command
 * (`take_launch_deep_link`) for the URL that cold-launched the app, and a
 * `studio://deep-link` event for warm activations while Studio is already
 * running. Both carry the raw URL string. This module turns
 * `luna://thread/<id>` into a thread id and no-ops safely in the plain browser
 * build (no `window.__TAURI__`), mirroring native-connection.ts guard
 * discipline.
 */

type TauriGlobal = {
  __TAURI__?: {
    core?: { invoke?: (command: string) => Promise<unknown> }
    event?: {
      listen?: (
        event: string,
        handler: (e: { payload?: unknown }) => void,
      ) => Promise<() => void>
    }
  }
}

function tauri(): TauriGlobal["__TAURI__"] {
  return (globalThis as typeof globalThis & TauriGlobal).__TAURI__
}

/**
 * How long bootstrap keeps an unconfirmed deep-linked selection alive while
 * waiting for a `thread-snapshot` (real threads always emit one on subscribe;
 * unknown threads return an empty stream and never confirm).
 */
export const DEEP_LINK_CONFIRM_GRACE_MS = 4_000

export type DeepLinkShieldDecision =
  | { readonly action: "keep" }
  | { readonly action: "clear-and-fallthrough" }
  | { readonly action: "not-applicable" }

/**
 * Bootstrap shield for a deep-linked selection that may be absent from the
 * windowed thread-list (top 50). A real thread confirms via `thread-snapshot`
 * and keeps the shield forever; a missing/deleted/wrong-server id never
 * confirms and must fall through after the grace window so selection is not
 * stranded on an empty thread across reconnects.
 */
export function deepLinkShieldDecision(args: {
  readonly selectedThreadId: string | null
  readonly routedDeepLinkId: string | null
  readonly confirmed: boolean
  readonly nowMs: number
  readonly graceUntilMs: number
}): DeepLinkShieldDecision {
  if (
    args.selectedThreadId == null ||
    args.routedDeepLinkId == null ||
    args.selectedThreadId !== args.routedDeepLinkId
  ) {
    return { action: "not-applicable" }
  }
  if (args.confirmed) return { action: "keep" }
  if (args.nowMs < args.graceUntilMs) return { action: "keep" }
  return { action: "clear-and-fallthrough" }
}

/**
 * Parse a raw deep-link URL into a thread id, or null if it is not a
 * well-formed `luna://thread/<id>` link. Rejects any other scheme or host
 * (e.g. a future `luna://connect` form) so callers can trust a non-null id.
 */
export function parseThreadDeepLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "luna:") return null
  // Canonical form: luna://thread/<id> parses "thread" as the host.
  if (url.hostname === "thread") {
    const id = url.pathname.replace(/^\/+/, "").split("/")[0] ?? ""
    return decodeURIComponent(id) || null
  }
  // Host-less fallback: some platforms surface luna:/thread/<id> with no host.
  if (url.hostname === "") {
    const segs = url.pathname.replace(/^\/+/, "").split("/")
    if (segs[0] === "thread" && segs[1]) return decodeURIComponent(segs[1])
  }
  return null
}

/**
 * Drain the URL that cold-launched Studio (one-shot on the Rust side) and
 * resolve its thread id, or null when there is none or we are not in Tauri.
 * Always resolves.
 */
export async function takeLaunchThreadId(): Promise<string | null> {
  const invoke = tauri()?.core?.invoke
  if (!invoke) return null
  try {
    return parseThreadDeepLink(await invoke("take_launch_deep_link"))
  } catch {
    return null
  }
}

/**
 * Subscribe to warm `studio://deep-link` activations (Studio already running).
 * Calls `cb` with each parsed thread id. Returns a synchronous disposer; the
 * async unlisten is reconciled through a disposed flag so tearing down before
 * the listener resolves still cleans up. No-ops outside Tauri.
 */
export function onDeepLinkThread(cb: (id: string) => void): () => void {
  const listen = tauri()?.event?.listen
  if (!listen) return () => {}
  let disposed = false
  let unlisten: (() => void) | null = null
  void listen("studio://deep-link", (event) => {
    const id = parseThreadDeepLink(event?.payload)
    if (id !== null) cb(id)
  })
    .then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    .catch(() => {})
  return () => {
    disposed = true
    if (unlisten) unlisten()
  }
}
