/**
 * threadCache.ts - the per-thread transcript cache behind ChatGPT-style thread
 * switching (stack23 S17d).
 *
 * WHY THE CTX IS PASSED PER CALL rather than captured in a constructor. An
 * earlier attempt at this move was reverted because it broke the OUTBOUND-EDGE
 * RULE (docs/next/stack23-slices.md): being outside the render/_wireRow cycle
 * is not enough for a subsystem to move module-side - every outbound edge must
 * also be REACHABLE from the module. This cache has one such edge,
 * `ThreadDrawerEngine.render()`, and `ThreadDrawerEngine` is a classic-script
 * `const`, so it is not on `window` at all and production code may not read it
 * off `__MoonInternals`. A module that built its own ctx therefore resolved
 * `undefined` and, behind optional chaining, SILENTLY stopped repainting the
 * strip's busy dots.
 *
 * The fix is the shape threadStrip.ts uses: chat.html - which CAN see
 * ThreadDrawerEngine - supplies the ctx, and this module holds only logic.
 * Passing it per call rather than once also keeps every dependency late-bound,
 * which matters because the harness mounts modules BEFORE the classic script
 * defines State/ChatState/ChatLoop.
 *
 * WHAT IT IS FOR: the server's re-snapshot on re-subscribe stays the source of
 * truth. This cache exists to remove the blank flash on switch and make
 * A -> B -> A feel instant. Nothing here is authoritative.
 *
 * THE try/catch SHAPE IS PART OF THE CONTRACT, not defensive noise, and is
 * ported verbatim: a failed `reset()` is tolerated, a failed `loadHistory()`
 * makes `paint()` report false so the caller force-renders a blank instead of
 * leaving the previous thread's transcript on screen, and a failed `flush()`
 * is tolerated. Collapsing these into one try block would turn a load failure
 * into a reported success.
 */

export interface ThreadCacheEntry {
  readonly messages: readonly unknown[]
  readonly throughSeq: number
}

/** The slice of chat.html's `State` this module reads AND writes. Must be the
 *  SAME live object every frame handler shares - not a copy. */
export interface ThreadCacheState {
  threadCache: Record<string, ThreadCacheEntry>
  busyThreads: Record<string, boolean>
}

export interface ThreadCacheCtx {
  readonly state: ThreadCacheState | null
  readonly chatState: { reset: () => void; loadHistory: (m: readonly unknown[]) => void } | null
  readonly chatLoop: { flush: () => void } | null
  /** Repaint the thread strip - a busy dot changed. Best-effort: the sidebar
   *  may be closed, which is not an error. */
  readonly requestRender: () => void
}

export function put(
  ctx: ThreadCacheCtx,
  threadId: string | null | undefined,
  messages: unknown,
  throughSeq: unknown,
): void {
  if (!threadId || !ctx.state) return
  // Copy: the caller's array must not alias the cache, or a later mutation of
  // the frame's message list would rewrite history already handed out.
  const list = Array.isArray(messages) ? messages.slice() : []
  ctx.state.threadCache[threadId] = {
    messages: list,
    throughSeq: Number.isFinite(throughSeq) ? (throughSeq as number) : -1,
  }
}

export function get(ctx: ThreadCacheCtx, threadId: string | null | undefined): ThreadCacheEntry | null {
  if (!threadId || !ctx.state) return null
  return ctx.state.threadCache[threadId] || null
}

/** Paint ChatState from cache. Returns true if an entry existed AND loaded;
 *  false tells the caller to force a blank render itself. */
export function paint(ctx: ThreadCacheCtx, threadId: string | null | undefined): boolean {
  const entry = get(ctx, threadId)
  if (!entry) return false
  try {
    ctx.chatState?.reset()
  } catch {
    /* ChatState may not be ready in early boot tests */
  }
  try {
    ctx.chatState?.loadHistory(entry.messages)
  } catch {
    return false
  }
  try {
    ctx.chatLoop?.flush()
  } catch {
    /* renderer optional in unit tests */
  }
  return true
}

export function clear(ctx: ThreadCacheCtx, threadId: string | null | undefined): void {
  if (!threadId || !ctx.state) return
  delete ctx.state.threadCache[threadId]
}

export function markBusy(ctx: ThreadCacheCtx, threadId: string | null | undefined): void {
  if (!threadId || !ctx.state) return
  // Idempotent by design: re-marking an already-busy thread must not trigger a
  // redundant strip repaint mid-drag.
  if (ctx.state.busyThreads[threadId]) return
  ctx.state.busyThreads[threadId] = true
  try {
    ctx.requestRender()
  } catch {
    /* sidebar may be closed */
  }
}

export function clearBusy(ctx: ThreadCacheCtx, threadId: string | null | undefined): void {
  if (!threadId || !ctx.state) return
  if (!ctx.state.busyThreads[threadId]) return
  delete ctx.state.busyThreads[threadId]
  try {
    ctx.requestRender()
  } catch {
    /* best-effort */
  }
}

export function isBusy(ctx: ThreadCacheCtx, threadId: string | null | undefined): boolean {
  if (!threadId || !ctx.state) return false
  return !!ctx.state.busyThreads[threadId]
}
