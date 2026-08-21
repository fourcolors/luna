/**
 * threadCreate.ts - the new-thread INTENT state machine (stack23 S17e).
 *
 * This is not bookkeeping; it is the arbitration between two things the user
 * can do a few milliseconds apart: press "+ New", and click an existing thread
 * row. Both want to decide what the window shows when the server's
 * `thread-created` ack finally lands. The intent is the tie-breaker, and every
 * transition below encodes a decision about whose action wins.
 *
 * Three states, held on `State.threadCreateIntent`:
 *   null         no create in flight
 *   'attach'     a create is in flight AND its result should take the window
 *   'background' a create is in flight but something newer took the window
 *
 * WHY IT MOVES WITH THE DRAWER (S17) rather than with the composer: `begin`
 * is the drawer's "+ New" button, `moveToBackground` is `onRowClick` conceding
 * the window to a newer selection, and `settle`/`fail` are consumed by the
 * frame handlers that resolve the create. It is the drawer's arbitration, and
 * it only ever touches `State` - no DOM, no engine calls, no outbound edges
 * (see the OUTBOUND-EDGE RULE in docs/next/stack23-slices.md for why that
 * distinction decides what can move).
 *
 * Ported verbatim; the return values are the contract:
 *   begin()  -> true when the caller should actually mint a thread
 *   settle() -> true when the created thread should be attached to the window
 *   fail()   -> true when the failure should be surfaced to the user
 */

/** The slice of chat.html's `State` this machine reads and writes. Must be the
 *  SAME live object every frame handler shares, never a copy. */
export interface ThreadCreateStateSlice {
  threadCreateIntent: "attach" | "background" | null
  threadListAutoSelectPending: boolean
  pendingFreshThread: boolean
  activeThreadId: string | null
}

/**
 * "+ New" pressed. Returns true when the caller should mint a thread.
 *
 * A SECOND press while one is already in flight returns false but still
 * re-asserts 'attach': it means "stay with the fresh-thread intent", not "mint
 * another concurrent thread". That re-adoption is what recovers a request an
 * intervening row click had pushed to the background.
 */
export function begin(state: ThreadCreateStateSlice): boolean {
  state.threadListAutoSelectPending = false
  if (state.threadCreateIntent !== null) {
    state.threadCreateIntent = "attach"
    return false
  }
  state.threadCreateIntent = "attach"
  return true
}

/** A newer explicit selection took the window; a create still in flight must
 *  no longer claim it when it lands. */
export function moveToBackground(state: ThreadCreateStateSlice): void {
  if (state.threadCreateIntent === "attach") state.threadCreateIntent = "background"
}

/** The create succeeded. Returns true when its thread should take the window. */
export function settle(state: ThreadCreateStateSlice): boolean {
  const shouldAttach = state.threadCreateIntent === "attach"
  state.threadCreateIntent = null
  state.threadListAutoSelectPending = false
  return shouldAttach
}

/** The create failed. Returns true when the failure should be surfaced - a
 *  backgrounded create failing is not something to interrupt the user with. */
export function fail(state: ThreadCreateStateSlice): boolean {
  const shouldSurface = state.threadCreateIntent === "attach"
  state.threadCreateIntent = null
  state.threadListAutoSelectPending = false
  return shouldSurface
}

/**
 * The socket dropped mid-create.
 *
 * The outcome is unknowable, so this preserves the user's STRONGER intent: if
 * they wanted a fresh thread and no thread is showing, reconnect mints one. An
 * extra empty row is preferable to silently attaching an old thread the user
 * never asked to see.
 */
export function onDisconnect(state: ThreadCreateStateSlice): void {
  if (state.threadCreateIntent === "attach" && !state.activeThreadId) {
    state.pendingFreshThread = true
  }
  state.threadCreateIntent = null
  state.threadListAutoSelectPending = false
}
