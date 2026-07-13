/**
 * useStudioNotifier - Studio Phase 2 native/web notifications.
 *
 * Watches every raw ServerFrame (via LunaData.onServerFrame), classifies the
 * ones worth surfacing into a {kind,title,body,threadId} hit, runs the full
 * gate stack, and emits a banner through the Tauri `notify_thread` command
 * (native) or the web Notification API (browser fallback). It also owns the
 * focus-regain + pending-attention model that routes a banner click back to
 * the thread that raised it (LOCKED DECISIONS 1 + 6).
 *
 * Gate stack (exact order, per the build spec):
 *   1. GLOBAL opt-out (localStorage `luna_notifications_enabled`, fail OPEN).
 *   2. classify -> null means "not notify-worthy".
 *   3. reconnect-replay seen-guard (stable per-frame identity, bounded set).
 *      Check only here — mark-as-seen happens AFTER a successful emit so a
 *      focus-suppressed hit can still banner later (e.g. after backgrounding).
 *   4. thread-aware focus suppression (needs-input is never focus-suppressed;
 *      Studio has no in-app job-input/secret UI, so the banner is the only cue).
 *   5. per-kind localStorage dedupe claim (fail OPEN).
 *   6. emit + mark seen + record pending-attention (native, thread-carrying only).
 *
 * classify(), the gate predicates, and the emit bridge are exported as pure
 * functions so the unit test can exercise them without a DOM.
 */
import { useEffect, useRef } from "react"
import type { ServerFrame, UIState } from "@luna/ui-shared/core"
// import type ONLY: job-input-request/secret-request are ui-ws-only frames that
// arrive at runtime but are absent from the ui-shared ServerFrame union. A value
// import here would drag server code into the browser bundle; `import type` is
// erased at emit, so nothing ships.
import type { JobInputRequestFrame, SecretRequestFrame } from "@luna/ui-ws"
import type { LunaData } from "./useLunaData"
import { useUiSelector } from "./useUiStore"

export type NotifyKind = "done" | "suggested" | "needs-input"

export interface NotifyHit {
  readonly kind: NotifyKind
  readonly title: string
  readonly body: string
  /** null for needs-input (awareness-only, no focus-regain route). */
  readonly threadId: string | null
  /**
   * Stable identity for the reconnect-replay seen-guard. DONE hits from the
   * `result-delivered` broadcast and the matching `assistant-done`+delivery
   * frame share `done:<threadId>:<ts>` (the server stamps both off one
   * clock.nowMs()), so the seen-guard also dedupes that cross-frame pair by
   * threadId+ts per LOCKED DECISION 2.
   */
  readonly seenKey: string
  /** Wall-clock ms used in the dedupe signature; null when the frame has none. */
  readonly ts: number | null
}

const NOTIFICATIONS_ENABLED_KEY = "luna_notifications_enabled"

/**
 * FRAME -> CATEGORY. Pure. Returns the notification hit for a frame, or null
 * when the frame is not notify-worthy (a live assistant reply, an empty
 * suggested set, a terminal action update, an unrelated frame type).
 */
export function classify(frame: ServerFrame): NotifyHit | null {
  const type = (frame as { readonly type: string }).type

  // ── ui-ws-only frames (narrow by the string tag, then cast the typed shape).
  if (type === "job-input-request") {
    const f = frame as unknown as JobInputRequestFrame
    return {
      kind: "needs-input",
      title: "Luna needs your input",
      body: f.prompt || f.jobName,
      threadId: null,
      seenKey: `job:${f.requestId}`,
      ts: null,
    }
  }
  if (type === "secret-request") {
    const f = frame as unknown as SecretRequestFrame
    return {
      kind: "needs-input",
      title: "Luna needs your input",
      body: f.prompt || f.destinationLabel,
      threadId: null,
      seenKey: `secret:${f.requestId}`,
      ts: null,
    }
  }

  switch (frame.type) {
    case "result-delivered":
      // DONE primary: the broadcast toast, fires for every thread (background).
      return {
        kind: "done",
        title: frame.label ? `Luna · ${frame.label}` : "Luna",
        body: frame.preview,
        threadId: frame.threadId,
        seenKey: `done:${frame.threadId}:${frame.ts}`,
        ts: frame.ts,
      }
    case "assistant-done": {
      // Only background deliveries notify; a live reply (delivery == null) never
      // does. The delivered message.ts equals the result-delivered ts for the
      // same delivery, so seenKey collapses the pair (deduped by threadId+ts).
      const delivery = frame.message.delivery
      if (delivery == null) return null
      return {
        kind: "done",
        title: delivery.label ? `Luna · ${delivery.label}` : "Luna",
        body: frame.message.text,
        threadId: frame.threadId,
        seenKey: `done:${frame.threadId}:${frame.message.ts}`,
        ts: frame.message.ts,
      }
    }
    case "suggested-action-set": {
      const actions = frame.actions
      if (actions.length === 0) return null
      const last = actions[actions.length - 1]
      if (last === undefined) return null
      return {
        kind: "suggested",
        title: "Luna suggests an action",
        body: last.title,
        threadId: frame.threadId,
        seenKey: `suggested:${last.id}`,
        ts: last.createdAt,
      }
    }
    case "suggested-action-update": {
      const action = frame.action
      // Only a fresh proposal is worth a "Luna suggests an action" banner; a
      // terminal delta (accepted/completed/failed/dismissed) is not. "active" is
      // carried defensively per the spec text though the wire uses "proposed".
      const status: string = action.status
      if (status !== "proposed" && status !== "active") return null
      return {
        kind: "suggested",
        title: "Luna suggests an action",
        body: action.title,
        threadId: frame.threadId,
        seenKey: `suggested:${action.id}`,
        ts: action.createdAt,
      }
    }
    default:
      return null
  }
}

/** Best-effort localStorage - undefined when it throws (private mode / no DOM). */
function safeLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** GATE 1: global opt-out, fail OPEN (any read failure -> enabled). */
export function notificationsEnabled(
  storage: Storage | undefined = safeLocalStorage(),
): boolean {
  try {
    if (storage === undefined) return true
    return storage.getItem(NOTIFICATIONS_ENABLED_KEY) !== "false"
  } catch {
    return true
  }
}

/** GATE 4 predicate: is this single multi-thread window actually front-and-lit. */
export function isWindowFocused(): boolean {
  if (typeof document === "undefined") return false
  return document.hasFocus() && document.visibilityState !== "hidden"
}

/**
 * GATE 4: thread-aware focus suppression.
 *
 * Thread-carrying kinds (done / suggested) suppress only when the window is
 * focused AND that exact thread is on screen (the user already sees the
 * transcript / chips).
 *
 * needs-input is NEVER focus-suppressed: Studio has no in-app job-input or
 * secret-answer UI yet, so the banner is the only awareness channel. Suppressing
 * while focused would silently drop prompts until the job times out.
 */
export function shouldSuppress(
  hit: NotifyHit,
  selectedThreadId: string | null,
  focused: boolean,
): boolean {
  if (hit.kind === "needs-input") return false
  return focused && hit.threadId !== null && selectedThreadId === hit.threadId
}

/** GATE 5 signature: kind + threadId + ts + a body prefix. */
export function dedupeSignature(hit: NotifyHit): string {
  return `${hit.kind}:${hit.threadId ?? ""}:${hit.ts ?? ""}:${hit.body.slice(0, 40)}`
}

/**
 * GATE 5: per-kind localStorage claim. Returns true when the hit is newly
 * claimed (emit), false when it repeats the last claim for its kind (drop).
 * Keyed PER-KIND so a DONE can never cross-suppress a later NEEDS-INPUT. Fails
 * OPEN (returns true) on any storage error.
 */
export function claimDedupe(
  hit: NotifyHit,
  storage: Storage | undefined = safeLocalStorage(),
): boolean {
  if (storage === undefined) return true
  const key = `luna_notify_last_${hit.kind}`
  const sig = dedupeSignature(hit)
  try {
    if (storage.getItem(key) === sig) return false
    storage.setItem(key, sig)
    return true
  } catch {
    return true
  }
}

export type EmitResult = "native" | "web" | "none"

interface TauriCore {
  readonly invoke?: (cmd: string, args: Record<string, unknown>) => unknown
}
interface TauriGlobal {
  readonly core?: TauriCore
}

/**
 * GATE 6 emit: the isTauri-vs-web branch, fail-soft like Moon's chat.html.
 * Returns which surface handled it so the caller can gate focus-regain routing
 * to native banners only (the web path routes precisely via Notification click).
 */
export function emitNotification(
  hit: NotifyHit,
  onWebClick?: (threadId: string) => void,
): EmitResult {
  const tauri = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__
  const invoke = tauri?.core?.invoke
  if (typeof invoke === "function") {
    void Promise.resolve(
      invoke("notify_thread", {
        kind: hit.kind,
        title: hit.title,
        body: hit.body,
        threadId: hit.threadId ?? "",
      }),
    ).catch(() => {})
    return "native"
  }
  return notifyWeb(hit, onWebClick)
}

/**
 * Web fallback: raise a browser Notification (requesting permission once if it
 * is neither granted nor denied). The click closure carries the threadId, so a
 * web click routes precisely without the focus-regain single-pending model.
 * No-ops (returns "none") when the Notification API is absent.
 */
function notifyWeb(hit: NotifyHit, onWebClick?: (threadId: string) => void): EmitResult {
  if (typeof Notification === "undefined") return "none"
  const tag = `${hit.kind}:${hit.threadId ?? ""}`
  const raise = (): void => {
    try {
      const n = new Notification(hit.title, { body: hit.body, tag })
      n.onclick = (): void => {
        window.focus()
        if (hit.threadId !== null && onWebClick !== undefined) onWebClick(hit.threadId)
        n.close()
      }
    } catch {
      // Some engines throw on construction even when the API exists; fail soft.
    }
  }
  try {
    if (Notification.permission === "granted") {
      raise()
    } else if (Notification.permission !== "denied") {
      void Notification.requestPermission()
        .then((perm) => {
          if (perm === "granted") raise()
        })
        .catch(() => {})
    }
  } catch {
    // Permission probe can throw on locked-down engines; fail soft.
  }
  return "web"
}

interface PendingAttention {
  readonly threadId: string
  readonly kind: NotifyKind
  readonly title: string
  readonly ts: number
}

const SEEN_LIMIT = 256

/** Record a seen identity, evicting the oldest once the bound is exceeded. */
function rememberSeen(seen: Set<string>, key: string): void {
  seen.add(key)
  if (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
}

export type ProcessNotifyResult = "emitted" | "dropped"

/**
 * Pure gate pipeline (exported for unit tests). Order is load-bearing:
 *   3. drop if already seen (do NOT mark yet)
 *   4. drop if focus-suppressed (do NOT mark — a later background delivery
 *      or un-suppress must still be able to banner)
 *   5. drop if per-kind dedupe claim fails
 *   6. emit; only on a real surface (`native` | `web`) mark seen + pending
 *
 * Marking seen before suppress/emit permanently burns one-shot frames
 * (needs-input requestIds) that were suppressed while focused.
 */
export function processNotifyHit(
  hit: NotifyHit,
  opts: {
    readonly seen: Set<string>
    readonly selectedThreadId: string | null
    readonly focused: boolean
    readonly storage?: Storage
    readonly emit: (hit: NotifyHit) => EmitResult
    readonly onNativePending?: (hit: NotifyHit) => void
  },
): ProcessNotifyResult {
  // 3. reconnect-replay seen-guard (check only).
  if (opts.seen.has(hit.seenKey)) return "dropped"
  // 4. thread-aware focus suppression (no mark — allow a later emit).
  if (shouldSuppress(hit, opts.selectedThreadId, opts.focused)) return "dropped"
  // 5. per-kind dedupe claim (fail OPEN).
  if (!claimDedupe(hit, opts.storage)) return "dropped"
  // 6. emit; only burn the seen key after a real surface handled it.
  const result = opts.emit(hit)
  if (result === "none") return "dropped"
  rememberSeen(opts.seen, hit.seenKey)
  if (result === "native" && hit.threadId !== null) opts.onNativePending?.(hit)
  return "emitted"
}

const selectSelectedThreadId = (state: UIState): string | null => state.selectedThreadId

/**
 * Mount once (StudioApp holds the full LunaData). Self-subscribes to the raw
 * frame side-channel and wires focus-regain routing. Returns nothing.
 */
export function useStudioNotifier(luna: LunaData): void {
  const selectedThreadId = useUiSelector(luna.store, selectSelectedThreadId)

  // Latest selection in a ref so the stable frame listener reads it without
  // re-subscribing on every selection change.
  const selectedThreadIdRef = useRef<string | null>(selectedThreadId)
  selectedThreadIdRef.current = selectedThreadId

  // Reconnect-replay seen-guard (GATE 3). Bounded so a long session cannot grow
  // it without limit; a replayed frame's stable identity must never re-banner
  // after a successful emit.
  const seenRef = useRef<Set<string>>(new Set())

  // Native banners awaiting a focus-regain route (Slice 3). Keyed by threadId;
  // needs-input (no threadId) is never added.
  const pendingAttentionRef = useRef<Map<string, PendingAttention>>(new Map())

  useEffect(
    () =>
      luna.onServerFrame((frame: ServerFrame) => {
        // 1. GLOBAL opt-out (fail OPEN).
        if (!notificationsEnabled()) return
        // 2. classify.
        const hit = classify(frame)
        if (hit === null) return
        processNotifyHit(hit, {
          seen: seenRef.current,
          selectedThreadId: selectedThreadIdRef.current,
          focused: isWindowFocused(),
          emit: (h) => emitNotification(h, luna.requestDeepLink),
          onNativePending: (h) => {
            if (h.threadId === null) return
            pendingAttentionRef.current.set(h.threadId, {
              threadId: h.threadId,
              kind: h.kind,
              title: h.title,
              ts: h.ts ?? Date.now(),
            })
          },
        })
      }),
    [luna.onServerFrame, luna.requestDeepLink],
  )

  // Focus-regain routing (Slice 3): when the window regains focus and EXACTLY
  // one native banner is pending, deep-link that thread. Multi-pending -> do
  // nothing (LOCKED DECISION 6, no attention strip in Phase 2).
  useEffect(() => {
    const onRegain = (): void => {
      if (!isWindowFocused()) return
      const items = [...pendingAttentionRef.current.values()]
      if (items.length !== 1) return
      const target = items[0]
      if (target === undefined) return
      pendingAttentionRef.current.clear()
      luna.requestDeepLink(target.threadId)
    }
    window.addEventListener("focus", onRegain)
    document.addEventListener("visibilitychange", onRegain)
    return () => {
      window.removeEventListener("focus", onRegain)
      document.removeEventListener("visibilitychange", onRegain)
    }
  }, [luna.requestDeepLink])

  // Clear-on-watch: opening/viewing a thread satisfies its pending attention.
  useEffect(() => {
    if (selectedThreadId !== null) pendingAttentionRef.current.delete(selectedThreadId)
  }, [selectedThreadId])
}
