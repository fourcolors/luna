// @vitest-environment jsdom
//
// The notification log (frontend-react/src/notifications/log.ts) plus the one
// wiring that fills it: the hub window's `result-delivered` frame handler.
//
// Why these two live in one file: the store is only trustworthy if the hub is
// actually its writer. Testing the pure functions alone would pass just as
// happily with the registration deleted, which is the exact regression that
// would silently empty the notification center while every other Moon test
// stayed green.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  NOTIFICATION_LOG_CAP,
  NOTIFICATION_LOG_KEY,
  NOTIFICATION_PREVIEW_CAP,
  NOTIFICATION_READ_KEY,
  appendEntry,
  appendNotification,
  clearNotificationLog,
  countUnread,
  markNotificationsRead,
  normalizeDelivery,
  parseEntries,
  readNotificationLog,
  readNotificationWatermark,
  unreadNotificationCount,
  type NotificationEntry,
} from "../frontend-react/src/notifications/log"
import { HubController } from "../frontend-react/src/hub/hubEngines"

function delivery(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result-delivered",
    threadId: "thr_abc",
    source: "background-job",
    label: "daily-brief",
    preview: "Brief is ready.",
    ts: 1_700_000_000_000,
    ...over,
  }
}

/**
 * HubController.createFrameRegistry() builds on the REAL vendor
 * LunaWS.createFrameRegistry() (see hubEngines.ts's module doc - the hub
 * keeps its own bespoke transport). Load the actual vendor script rather
 * than hand-rolling a registry stand-in, the same way
 * hub-engines-construction-error.test.ts loads moon-protocol.js, so these
 * tests exercise the dispatch path that really ships.
 */
function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, "../frontend/vendor", file), "utf8")
  new Function("globalThis", src)(target)
}

beforeEach(() => {
  localStorage.clear()
  loadVendorInto(window, "moon-ws.js")
})

afterEach(() => {
  localStorage.clear()
  delete (window as any).LunaWS
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("normalizeDelivery", () => {
  it("maps a result-delivered frame onto a versioned entry", () => {
    const entry = normalizeDelivery(delivery())
    expect(entry).not.toBeNull()
    expect(entry).toMatchObject({
      v: 1,
      threadId: "thr_abc",
      source: "background-job",
      label: "daily-brief",
      preview: "Brief is ready.",
      ts: 1_700_000_000_000,
    })
  })

  it("is deterministic: the same frame twice yields the same id", () => {
    expect(normalizeDelivery(delivery())!.id).toBe(normalizeDelivery(delivery())!.id)
  })

  it("distinguishes different deliveries at the same timestamp", () => {
    const a = normalizeDelivery(delivery({ preview: "one" }))!
    const b = normalizeDelivery(delivery({ preview: "two" }))!
    expect(a.id).not.toBe(b.id)
  })

  it("keeps a delivery that carries no preview - the job still finished", () => {
    const entry = normalizeDelivery(delivery({ preview: "" }))
    expect(entry).not.toBeNull()
    expect(entry!.preview).toBe("A background task finished.")
  })

  it("truncates an oversized preview on a char boundary", () => {
    // Multi-byte on purpose: a byte-slice would split a char here.
    const entry = normalizeDelivery(delivery({ preview: "é".repeat(1000) }))!
    expect(Array.from(entry.preview)).toHaveLength(NOTIFICATION_PREVIEW_CAP + 1)
    expect(entry.preview.endsWith("…")).toBe(true)
  })

  it("falls back to `now` when the server sent no usable timestamp", () => {
    expect(normalizeDelivery(delivery({ ts: 0 }), 42)!.ts).toBe(42)
    expect(normalizeDelivery(delivery({ ts: "nope" }), 42)!.ts).toBe(42)
  })

  it("returns null for a non-object frame", () => {
    expect(normalizeDelivery(null)).toBeNull()
    expect(normalizeDelivery("result-delivered")).toBeNull()
  })
})

describe("appendEntry", () => {
  const at = (ts: number, id = `id-${ts}`): NotificationEntry => ({
    v: 1,
    id,
    threadId: null,
    source: null,
    label: null,
    preview: "",
    ts,
  })

  it("keeps entries newest-first regardless of arrival order", () => {
    let list: NotificationEntry[] = []
    list = appendEntry(list, at(100))
    list = appendEntry(list, at(300))
    list = appendEntry(list, at(200))
    expect(list.map((e) => e.ts)).toEqual([300, 200, 100])
  })

  it("replaces rather than duplicates a re-delivered entry", () => {
    const first = at(100, "same")
    const again = { ...at(100, "same"), preview: "updated" }
    const list = appendEntry(appendEntry([], first), again)
    expect(list).toHaveLength(1)
    expect(list[0].preview).toBe("updated")
  })

  it("enforces the retention cap, dropping the oldest", () => {
    let list: NotificationEntry[] = []
    for (let i = 0; i < NOTIFICATION_LOG_CAP + 10; i++) list = appendEntry(list, at(i))
    expect(list).toHaveLength(NOTIFICATION_LOG_CAP)
    expect(list[0].ts).toBe(NOTIFICATION_LOG_CAP + 9)
    expect(list[list.length - 1].ts).toBe(10)
  })
})

describe("parseEntries", () => {
  it("returns [] for absent, non-JSON, or non-array payloads", () => {
    expect(parseEntries(null)).toEqual([])
    expect(parseEntries("{not json")).toEqual([])
    expect(parseEntries('{"a":1}')).toEqual([])
  })

  it("drops rows missing the fields the panel renders", () => {
    const raw = JSON.stringify([{ id: "ok", ts: 5 }, { id: "no-ts" }, { ts: 9 }, null, "nope"])
    expect(parseEntries(raw).map((e) => e.id)).toEqual(["ok"])
  })

  it("keeps a row written by a NEWER schema version rather than discarding history", () => {
    const raw = JSON.stringify([{ v: 99, id: "future", ts: 5, preview: "hi" }])
    expect(parseEntries(raw)).toHaveLength(1)
    expect(parseEntries(raw)[0].v).toBe(99)
  })
})

describe("unread accounting", () => {
  it("counts only entries strictly newer than the watermark", () => {
    const list: NotificationEntry[] = [300, 200, 100].map((ts) => ({
      v: 1,
      id: `id-${ts}`,
      threadId: null,
      source: null,
      label: null,
      preview: "",
      ts,
    }))
    expect(countUnread(list, 0)).toBe(3)
    expect(countUnread(list, 200)).toBe(1)
    expect(countUnread(list, 300)).toBe(0)
  })

  it("markNotificationsRead advances the watermark to the newest entry", () => {
    appendNotification(delivery({ ts: 1000, preview: "a" }))
    appendNotification(delivery({ ts: 2000, preview: "b" }))
    expect(unreadNotificationCount()).toBe(2)
    markNotificationsRead()
    expect(readNotificationWatermark()).toBe(2000)
    expect(unreadNotificationCount()).toBe(0)
  })

  it("never moves the watermark backwards", () => {
    appendNotification(delivery({ ts: 5000 }))
    markNotificationsRead()
    // A stale caller passing an older list must not un-read newer rows.
    markNotificationsRead([{ v: 1, id: "old", threadId: null, source: null, label: null, preview: "", ts: 10 }])
    expect(readNotificationWatermark()).toBe(5000)
  })

  it("a newly appended delivery becomes unread again", () => {
    appendNotification(delivery({ ts: 1000 }))
    markNotificationsRead()
    appendNotification(delivery({ ts: 3000, preview: "later" }))
    expect(unreadNotificationCount()).toBe(1)
  })
})

describe("storage failure is never fatal", () => {
  it("readNotificationLog returns [] when localStorage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked")
    })
    expect(readNotificationLog()).toEqual([])
    expect(unreadNotificationCount()).toBe(0)
  })

  it("appendNotification returns null (not a throw) when setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded")
    })
    expect(() => appendNotification(delivery())).not.toThrow()
    expect(appendNotification(delivery())).toBeNull()
  })
})

describe("clearNotificationLog", () => {
  it("empties the list and leaves nothing reading as unread", () => {
    appendNotification(delivery({ ts: 1000 }))
    appendNotification(delivery({ ts: 2000, preview: "b" }))
    clearNotificationLog(9999)
    expect(readNotificationLog()).toEqual([])
    expect(unreadNotificationCount()).toBe(0)
    expect(localStorage.getItem(NOTIFICATION_LOG_KEY)).toBe("[]")
    expect(localStorage.getItem(NOTIFICATION_READ_KEY)).toBe("9999")
  })
})

// ── The wiring: the hub window is the log's writer ─────────────────────────
describe("HubController accumulates result-delivered into the log", () => {
  it("registers a result-delivered handler at all", () => {
    const hub = new HubController(() => {})
    hub.createFrameRegistry()
    // handleFrame() delegates to the registry built above.
    hub.handleFrame(delivery())
    expect(readNotificationLog()).toHaveLength(1)
  })

  it("stores the delivery's fields and raises the unread pip count", () => {
    const actions: any[] = []
    const hub = new HubController((a: any) => actions.push(a))
    hub.createFrameRegistry()

    hub.handleFrame(delivery({ ts: 1000, label: "nightly-sync", preview: "12 rows" }))

    expect(readNotificationLog()[0]).toMatchObject({
      threadId: "thr_abc",
      label: "nightly-sync",
      preview: "12 rows",
      ts: 1000,
    })
    expect(actions).toContainEqual({ type: "notification-count", count: 1 })
  })

  it("accumulates several deliveries newest-first", () => {
    const hub = new HubController(() => {})
    hub.createFrameRegistry()
    hub.handleFrame(delivery({ ts: 1000, preview: "first" }))
    hub.handleFrame(delivery({ ts: 2000, preview: "second" }))
    expect(readNotificationLog().map((e) => e.preview)).toEqual(["second", "first"])
  })

  it("a storage failure inside the handler never escapes into frame dispatch", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded")
    })
    const hub = new HubController(() => {})
    hub.createFrameRegistry()
    expect(() => hub.handleFrame(delivery())).not.toThrow()
  })

  it("syncNotificationPip reports the unread count from disk (restart restore)", () => {
    appendNotification(delivery({ ts: 1000 }))
    appendNotification(delivery({ ts: 2000, preview: "b" }))
    const actions: any[] = []
    const hub = new HubController((a: any) => actions.push(a))
    hub.syncNotificationPip()
    expect(actions).toContainEqual({ type: "notification-count", count: 2 })
  })
})
