/**
 * notifications/log.ts - the Moon notification log: a small, versioned,
 * localStorage-backed ring of the background results delivered while the app
 * was running, plus the read-watermark that turns it into an unread count.
 *
 * WHY THIS EXISTS. `result-delivered` (packages/ui-ws/src/protocol.ts) is
 * broadcast to every connected socket and, until now, produced only two
 * things that vanish: a 6.5s toast (chat/resultToasts.ts) and an OS banner
 * (chat/notifier.ts). Miss both and the fact that a job finished is gone with
 * no way to review it. This module is the durable half; the Notifications
 * panel (panels/notifications/) renders it.
 *
 * WHO WRITES WHAT - this split is load-bearing, not stylistic. localStorage
 * is shared across every Moon window (see moon-appearance.js's cross-window
 * re-skin and notifier.ts's cross-window dedupe, both of which already rely
 * on that). `setItem` is serialized, but a read-modify-write PAIR is not, so
 * two windows appending at once would silently lose an entry. Each key
 * therefore has exactly ONE writer:
 *
 *   - `luna_notification_log`     <- written ONLY by the hub window
 *     (hub/hubEngines.ts). The hub is the one window whose lifetime is the
 *     app's lifetime (src-tauri/src/main.rs destroys every other window with
 *     it) and it already holds a long-lived auto-reconnecting socket, so it
 *     is the only surface guaranteed to be listening when a background job
 *     lands. Chat windows are closable - and being closed is precisely the
 *     case this feature exists for.
 *   - `luna_notification_read_ts` <- written ONLY by the notifications panel.
 *     Unread is derived (entries strictly newer than the watermark), so
 *     marking things read never touches the log itself and the two writers
 *     never contend.
 *
 * Every exported entry point is try/catch'd and fails OPEN (empty list, or a
 * no-op), matching chat/notifier.ts's convention: localStorage throws
 * outright in some embedders, and notification bookkeeping must never take a
 * frame dispatch or a panel render down with it.
 *
 * FORWARD COMPATIBILITY. Entries carry `v` so the planned server-side
 * delivery history (a `notification-list` frame derived from the delivery
 * markers chat-service.ts already persists) can hydrate this same store
 * additively, without a migration or a second rendering path. That hydration
 * MUST stamp `rx` with the local clock as it writes each row, or hydrated rows
 * inherit the server-skew defect `rx` exists to prevent (see its doc below).
 */

/** localStorage key holding the JSON entry array. Hub-window writes only. */
export const NOTIFICATION_LOG_KEY = "luna_notification_log"
/** localStorage key holding the read watermark (epoch ms). Panel writes only. */
export const NOTIFICATION_READ_KEY = "luna_notification_read_ts"
/**
 * localStorage key holding the CLEAR watermark (epoch ms). Panel writes only.
 *
 * This key is why "Clear" does not violate the writer split above. The panel
 * cannot empty the log by writing the log key: the hub's append is a
 * read-modify-write PAIR, so a Clear landing between the hub's read and its
 * write would be silently undone and every cleared row would come back.
 * Instead the panel raises this watermark and `readNotificationLog` filters
 * everything at or below it, so clearing is a single write to a key only the
 * panel owns.
 */
export const NOTIFICATION_CLEAR_KEY = "luna_notification_clear_ts"
/** Newest-first retention cap. Bounds both render cost and storage quota. */
export const NOTIFICATION_LOG_CAP = 50
/** Bound on a single stored preview, so one huge job result can't eat quota. */
export const NOTIFICATION_PREVIEW_CAP = 280
/** Schema version stamped on every entry (see FORWARD COMPATIBILITY above). */
export const NOTIFICATION_ENTRY_VERSION = 1

export interface NotificationEntry {
  /** Schema version - always NOTIFICATION_ENTRY_VERSION for entries we write. */
  readonly v: number
  /** Stable, deterministic key for React lists and for dedupe on re-append. */
  readonly id: string
  /** Thread the result landed in; clicking the entry opens it. */
  readonly threadId: string | null
  /** "suggested-action" | "background-job" | "schedule" | other server value. */
  readonly source: string | null
  /** Human label of the delivering task, when the server knew one. */
  readonly label: string | null
  /** Short excerpt of the delivered text. */
  readonly preview: string
  /** Wall-clock ms the server stamped on the delivery. */
  readonly ts: number
  /**
   * CLIENT receipt ms - when THIS machine first stored the entry. The clear
   * watermark is compared against this, never against `ts`: `ts` is the
   * SERVER's clock, so under skew a delivery that arrives after a Clear can
   * carry a stamp from before it, and filtering on `ts` would drop it forever.
   *
   * Optional because rows written before this field existed (and rows a future
   * server-history hydration may add) will not carry it; readers fall back to
   * `ts`.
   */
  readonly rx?: number
}

/** Trim to `max` chars on a char boundary, appending an ellipsis if cut. */
function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return chars.slice(0, max).join("").trimEnd() + "…"
}

/**
 * Cheap deterministic string hash (djb2-xor). Only ever used to build an
 * entry id, so collision resistance is irrelevant - determinism is the point:
 * the same delivery must produce the same id twice so dedupe works.
 */
function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i)
  return (h >>> 0).toString(36)
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/**
 * Turn a raw `result-delivered` frame into an entry, or null if it isn't one
 * we can render. PURE - takes `now` so tests don't have to freeze the clock.
 */
export function normalizeDelivery(frame: unknown, now: number = Date.now()): NotificationEntry | null {
  if (!frame || typeof frame !== "object") return null
  const f = frame as Record<string, unknown>
  const threadId = str(f.threadId)
  const label = str(f.label)
  const source = str(f.source)
  const rawPreview = str(f.preview)
  // A delivery with no text at all is still worth logging (the job DID
  // finish) - fall back the same way notifier.ts does rather than dropping it.
  const preview = truncate(rawPreview ?? "A background task finished.", NOTIFICATION_PREVIEW_CAP)
  const ts = typeof f.ts === "number" && Number.isFinite(f.ts) && f.ts > 0 ? f.ts : now
  return {
    v: NOTIFICATION_ENTRY_VERSION,
    id: `n_${ts}_${hash(`${threadId ?? ""}|${label ?? ""}|${preview}`)}`,
    threadId,
    source,
    label,
    preview,
    ts,
    // `now` is the LOCAL clock; `ts` above prefers the server's. See the `rx`
    // doc on NotificationEntry for why the clear watermark needs the local one.
    rx: now,
  }
}

/**
 * Prepend `entry` to `entries`, dropping an existing row with the same id
 * (a re-delivered frame updates in place rather than duplicating), sorting
 * newest-first and enforcing `cap`. PURE.
 */
export function appendEntry(
  entries: readonly NotificationEntry[],
  entry: NotificationEntry,
  cap: number = NOTIFICATION_LOG_CAP,
): NotificationEntry[] {
  const rest = entries.filter((e) => e.id !== entry.id)
  return [entry, ...rest].sort((a, b) => b.ts - a.ts).slice(0, Math.max(0, cap))
}

/**
 * Entries that survive a clear at `clearedAt`. PURE.
 *
 * Strict `>` so a Clear taken in the same millisecond as an entry wins the tie:
 * the user pressed the button after seeing the row, so the row goes.
 */
export function dropCleared(
  entries: readonly NotificationEntry[],
  clearedAt: number,
): NotificationEntry[] {
  if (clearedAt <= 0) return [...entries]
  return entries.filter((e) => (e.rx ?? e.ts) > clearedAt)
}

/** Entries strictly newer than the watermark. PURE. */
export function countUnread(entries: readonly NotificationEntry[], watermark: number): number {
  return entries.reduce((n, e) => (e.ts > watermark ? n + 1 : n), 0)
}

/**
 * Parse a stored payload into entries, discarding anything malformed. PURE.
 * Unknown-version rows are kept (forward compatibility: a newer app version
 * may have written them, and dropping them would silently lose the user's
 * history on a downgrade) but rows missing the fields we render are not.
 */
export function parseEntries(raw: string | null | undefined): NotificationEntry[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: NotificationEntry[] = []
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue
    const r = row as Record<string, unknown>
    if (typeof r.id !== "string" || typeof r.ts !== "number" || !Number.isFinite(r.ts)) continue
    out.push({
      v: typeof r.v === "number" ? r.v : NOTIFICATION_ENTRY_VERSION,
      id: r.id,
      threadId: str(r.threadId),
      source: str(r.source),
      label: str(r.label),
      preview: typeof r.preview === "string" ? r.preview : "",
      ts: r.ts,
      // Pre-`rx` rows (and any future hydrated rows) fall back to `ts`.
      rx: typeof r.rx === "number" && Number.isFinite(r.rx) ? r.rx : r.ts,
    })
  }
  return out.sort((a, b) => b.ts - a.ts)
}

// ── storage-touching wrappers (all fail open) ───────────────────────────────

/**
 * Read the LIVE log: stored rows minus anything a Clear retired.
 *
 * The filter lives HERE rather than in `parseEntries` because parseEntries is
 * documented pure, and because this is the single storage-touching choke point
 * every reader goes through - including the hub's own `appendNotification`, so
 * its next write physically compacts the retired rows away and the cap applies
 * to live entries only. Returns [] on any storage/parse failure.
 */
export function readNotificationLog(): NotificationEntry[] {
  try {
    return dropCleared(
      parseEntries(localStorage.getItem(NOTIFICATION_LOG_KEY)),
      readNotificationClearedAt(),
    )
  } catch {
    return []
  }
}

/** Read the clear watermark (epoch ms). 0 when unset or unreadable. */
export function readNotificationClearedAt(): number {
  try {
    const raw = localStorage.getItem(NOTIFICATION_CLEAR_KEY)
    const n = raw ? Number(raw) : 0
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/**
 * Append a `result-delivered` frame to the log. HUB WINDOW ONLY (see the
 * module doc's writer split). Returns the stored entry, or null if the frame
 * wasn't usable or storage refused the write.
 */
export function appendNotification(frame: unknown, now: number = Date.now()): NotificationEntry | null {
  const entry = normalizeDelivery(frame, now)
  if (!entry) return null
  try {
    const next = appendEntry(readNotificationLog(), entry)
    localStorage.setItem(NOTIFICATION_LOG_KEY, JSON.stringify(next))
    return entry
  } catch {
    return null
  }
}

/** Read the read-watermark (epoch ms). 0 when unset or unreadable. */
export function readNotificationWatermark(): number {
  try {
    const raw = localStorage.getItem(NOTIFICATION_READ_KEY)
    const n = raw ? Number(raw) : 0
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/**
 * Advance the read watermark to the newest entry's timestamp. PANEL ONLY.
 * Never moves backwards, so opening a stale panel can't un-read newer rows.
 */
export function markNotificationsRead(entries?: readonly NotificationEntry[]): number {
  const list = entries ?? readNotificationLog()
  const newest = list.reduce((max, e) => (e.ts > max ? e.ts : max), 0)
  const next = Math.max(newest, readNotificationWatermark())
  try {
    if (next > 0) localStorage.setItem(NOTIFICATION_READ_KEY, String(next))
  } catch {
    /* watermark is cosmetic - a failed write just means it stays unread */
  }
  return next
}

/** Unread count against the stored watermark. 0 on any failure. */
export function unreadNotificationCount(): number {
  return countUnread(readNotificationLog(), readNotificationWatermark())
}

/**
 * Retire every entry currently in the log, by raising the clear watermark.
 *
 * Writes ONE key, and one the panel exclusively owns - see NOTIFICATION_CLEAR_KEY.
 * It deliberately does NOT touch the log key (that is the hub's, and racing its
 * read-modify-write would resurrect the cleared rows) and does NOT touch the
 * read watermark (that compares against the SERVER `ts`, so parking it at `now`
 * would silently mark-as-read a later delivery whose stamp predates the clear;
 * it is redundant anyway now that retired rows never reach a reader).
 *
 * Never moves backwards, so a stale panel cannot un-clear. Returns false if
 * storage refused the write, so the caller can avoid rendering an empty list
 * that isn't actually empty.
 */
export function clearNotificationLog(now: number = Date.now()): boolean {
  try {
    const next = Math.max(now, readNotificationClearedAt())
    if (next <= 0) return false
    localStorage.setItem(NOTIFICATION_CLEAR_KEY, String(next))
    return true
  } catch {
    return false
  }
}
