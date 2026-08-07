/**
 * threadList.ts - the thread drawer's pure selection-and-ordering logic
 * (stack23 S17, first increment).
 *
 * WHY THIS MOVES AHEAD OF THE REST OF THE DRAWER. S17 lands as one cohesive
 * slice because `render()` -> `_renderRow()` -> `_wireRow()` -> back into
 * `render()` is a CYCLE, so list rendering and drag cannot own the DOM
 * separately (see docs/next/stack23-slices.md's S17 seam finding). That
 * constraint is about DOM OWNERSHIP. The functions below touch no DOM at all -
 * they decide WHICH threads are visible, in WHAT order, and WHERE a redock
 * drop lands - so they carry none of the cycle's risk and can move first.
 *
 * Every function here is a verbatim port of the corresponding
 * `ThreadDrawerEngine` method, and each one is pinned by
 * test/thread-drawer-list.test.ts (26 assertions, mutation-verified) driving
 * the LIVE engine. chat.html delegates to these, so those pins now cover this
 * module through the same seam.
 *
 * NO DOM, NO GLOBALS, NO `State` IMPORT: the caller passes the state slice in.
 * That is what makes this testable without booting chat.html, and what lets
 * the eventual React drawer consume it unchanged.
 */

/** One thread row as the drawer sees it. Deliberately loose: these fields
 *  arrive from the server's `thread-list` frame and from a legacy cache, and
 *  the vanilla code read them untyped. Narrowing them is a separate concern
 *  from moving the logic. */
export interface ThreadRow {
  readonly id: string
  readonly title?: string | null
  readonly lastMessagePreview?: string | null
  readonly lastMessageAt?: number | string | null
  readonly updatedAt?: number | string | null
  readonly createdAt?: number | string | null
  readonly system?: boolean
}

/** The slice of chat.html's `State` the selectors read. Passed in rather than
 *  imported so this module stays pure. */
export interface ThreadListState {
  readonly threads?: readonly ThreadRow[] | null
  readonly threadSearch?: string | null
  /** Threads detached into floater windows; they leave the strip until
   *  redock or close (Chrome-like). Keys are thread ids. */
  readonly floatedThreadIds?: Record<string, unknown> | null
  /** Session-local order from drag-to-redock inserts. Does not rewrite the
   *  server's ordering. */
  readonly threadOrder?: readonly string[] | null
}

/**
 * Effective sort timestamp for a thread.
 *
 * The `||` chain is LOAD-BEARING and not a `??` in disguise: a literal `0`
 * falls through to the next field, so an epoch-stamped row sorts by whichever
 * later field it has. Switching to `??` would silently reorder such rows.
 * Pinned by "treats a 0 timestamp as absent rather than as the epoch".
 */
export function threadTimestamp(t: ThreadRow | null | undefined): number {
  const v = (t && (t.lastMessageAt || t.updatedAt || t.createdAt)) || 0
  const n = typeof v === "number" ? v : Date.parse(String(v))
  return Number.isFinite(n) ? n : 0
}

/**
 * The rows the strip should show, filtered and ordered.
 *
 * Order of operations is verbatim from vanilla and matters: drop system and
 * id-less rows, then floaters, then the search filter, and only then sort -
 * so the search runs over the same set the user can actually see.
 *
 * Never sorts the caller's array. Note WHY that holds: `rows` is always a
 * `.filter()` result by the time it is sorted, and `.filter()` already copies,
 * so `State.threads` is safe regardless. The extra `.slice()` before each
 * sort is belt-and-braces against a future edit that drops the filter - it is
 * deliberately NOT claimed as tested, because no assertion can observe it
 * while the filter is there (verified: removing it leaves all 26 pins green).
 * Vanilla sorted without it for exactly this reason.
 */
export function visibleThreads(state: ThreadListState): ThreadRow[] {
  const q = (state.threadSearch || "").trim().toLowerCase()
  let rows = (state.threads || []).filter((t) => t && t.id && !t.system)

  const floated = state.floatedThreadIds
  if (floated) {
    rows = rows.filter((t) => !floated[t.id])
  }

  if (q) {
    rows = rows.filter((t) =>
      ((t.title || "") + " " + (t.lastMessagePreview || "")).toLowerCase().includes(q),
    )
  }

  const order = state.threadOrder
  if (Array.isArray(order) && order.length) {
    const rank = new Map(order.map((id, i) => [id, i] as const))
    // 1e9 for unranked, verbatim from vanilla: every ranked id sorts ahead of
    // every unranked one, and unranked ids fall back to recency among
    // themselves.
    return rows.slice().sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id)! : 1e9
      const rb = rank.has(b.id) ? rank.get(b.id)! : 1e9
      if (ra !== rb) return ra - rb
      return threadTimestamp(b) - threadTimestamp(a)
    })
  }
  return rows.slice().sort((a, b) => threadTimestamp(b) - threadTimestamp(a))
}

/**
 * Which of the `n + 1` insert slots a redock drop at `yRatio` lands in
 * (before the first row, between two, or after the last).
 *
 * `Number(yRatio) || 0` collapses NaN, null, undefined and non-numeric input
 * to the top slot rather than propagating NaN into a slice index.
 */
export function insertIndexForRatio(n: number, yRatio: unknown): number {
  if (n <= 0) return 0
  const r = Math.max(0, Math.min(1, Number(yRatio) || 0))
  return Math.min(n, Math.max(0, Math.round(r * n)))
}
