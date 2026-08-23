/**
 * NotificationsPanel.tsx - the Notification Center: a reviewable list of the
 * background results Luna has delivered, so a finished job is still findable
 * after its 6.5s toast (chat/resultToasts.ts) and OS banner
 * (chat/notifier.ts) have both evaporated.
 *
 * NO WEBSOCKET, deliberately. Every other data-driven panel opens its own
 * socket via ctx.connectWs, but a panel's socket only exists while the panel
 * is open - which would make this one show nothing that arrived before you
 * opened it, i.e. everything you actually wanted. Instead the hub window
 * (hub/hubEngines.ts, the one window alive for the app's whole lifetime)
 * accumulates deliveries into src/notifications/log.ts, and this panel is a
 * pure reader of that store, live-updated through cross-window `storage`
 * events - the same mechanism moon-appearance.js already uses to re-skin
 * every window at once.
 *
 * READ SEMANTICS. The stored watermark is advanced on mount, which clears the
 * orb's unread pip immediately. The watermark AS IT WAS at mount is kept in a
 * ref so rows that were unread when you opened the panel stay visually marked
 * for this viewing - clearing the badge shouldn't also erase the answer to
 * "which of these are new?".
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Button, EmptyState } from "../../astryx-kit"
import type { PanelCtx } from "../panel-ctx"
import {
  NOTIFICATION_LOG_KEY,
  clearNotificationLog,
  markNotificationsRead,
  readNotificationLog,
  readNotificationWatermark,
  type NotificationEntry,
} from "../../notifications/log"
import { entryMeta, entryTitle } from "./model"
import "./NotificationsPanel.css"

export const NOTIFICATIONS_PANEL_TITLE = "Notifications"

export interface NotificationsPanelProps {
  ctx: PanelCtx
}

function openThread(ctx: PanelCtx, threadId: string): void {
  // Same direct-line invocation the agent's open_widget tool uses; chat.html
  // reads the `thread` param on boot (see chat/wiring.ts). Swallowing the
  // rejection matches every other panel's off-Tauri convention.
  ctx.invoke("open_widget", { kind: "chat", params: { thread: threadId } }).catch(() => {})
}

function Row({
  entry,
  unread,
  ctx,
  now,
}: {
  entry: NotificationEntry
  unread: boolean
  ctx: PanelCtx
  now: number
}) {
  const title = entryTitle(entry)
  const meta = entryMeta(entry, now)
  const openable = Boolean(entry.threadId)
  return (
    <div className={"nt-row" + (unread ? " unread" : "")} data-notification-id={entry.id}>
      <span className={"nt-dot" + (unread ? " unread" : "")} aria-hidden="true" />
      <div className="nt-row-info">
        <div className="nt-row-title">{title}</div>
        <div className="nt-row-preview">{entry.preview}</div>
        {meta && <div className="nt-row-meta">{meta}</div>}
      </div>
      {openable && (
        <Button
          className="nt-open-btn"
          variant="primary"
          size="sm"
          label={`Open the conversation for ${title}`}
          onClick={() => openThread(ctx, entry.threadId as string)}
        >
          Open
        </Button>
      )}
    </div>
  )
}

export function NotificationsPanel({ ctx }: NotificationsPanelProps) {
  const [entries, setEntries] = useState<NotificationEntry[]>(() => readNotificationLog())
  // Frozen at mount: which rows were unread when this panel was opened. See
  // READ SEMANTICS above.
  const seenWatermarkRef = useRef<number>(0)
  if (seenWatermarkRef.current === 0) seenWatermarkRef.current = readNotificationWatermark()
  // Single render-time clock so every row's "12m ago" is consistent, and so
  // tests can reason about the output without racing Date.now().
  const now = Date.now()

  const refresh = useCallback(() => {
    const next = readNotificationLog()
    setEntries(next)
    markNotificationsRead(next)
  }, [])

  useEffect(() => {
    // Clear the unread badge for what's already on screen at mount.
    markNotificationsRead(entries)
    const onStorage = (e: StorageEvent) => {
      // Only the hub writes the log key; anything else is another panel's
      // business (appearance, watermark) and must not trigger a re-read.
      if (!e || e.key !== NOTIFICATION_LOG_KEY) return
      refresh()
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
    // Mount-only: `entries` is read for the initial mark, and `refresh` is
    // stable. Re-subscribing on every list change would churn the listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh])

  const onClear = useCallback(() => {
    clearNotificationLog()
    seenWatermarkRef.current = Date.now()
    setEntries([])
  }, [])

  return (
    <div className="nt-panel">
      <div className="nt-toolbar">
        <div className="nt-count">
          {entries.length === 0 ? "" : `${entries.length} recent`}
        </div>
        <Button
          className="nt-clear-btn"
          variant="ghost"
          size="sm"
          label="Clear all notifications"
          onClick={onClear}
          isDisabled={entries.length === 0}
        >
          Clear
        </Button>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          className="nt-empty"
          isCompact
          title="Nothing yet"
          description="Results from scheduled jobs, workflows and accepted suggested actions land here."
        />
      ) : (
        entries.map((entry) => (
          <Row
            key={entry.id}
            entry={entry}
            unread={entry.ts > seenWatermarkRef.current}
            ctx={ctx}
            now={now}
          />
        ))
      )}
    </div>
  )
}
