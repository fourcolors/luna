/**
 * queueTray.test.ts - the Queue + Steer tray draws exactly what the server's
 * queue-update frames say, for the active thread only, and Steer sends a
 * `steer` frame without touching the list itself.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import { createQueueTray } from "./queueTray"

describe("queueTray", () => {
  let host: HTMLElement
  let active: string | null
  let sent: Array<Record<string, unknown>>
  let tray: ReturnType<typeof createQueueTray>

  beforeEach(() => {
    document.body.innerHTML = '<form><div id="queue-tray" hidden></div></form>'
    host = document.getElementById("queue-tray")!
    active = "thr-a"
    sent = []
    tray = createQueueTray({
      host,
      getActiveThreadId: () => active,
      send: (f) => sent.push(f),
    })
  })

  const rows = () =>
    Array.from(host.querySelectorAll(".queue-tray-text")).map((e) => e.textContent)

  it("is hidden until something is queued, then lists it with a count", () => {
    tray.render()
    expect(host.hidden).toBe(true)
    tray.applyUpdate({
      threadId: "thr-a",
      queued: [
        { userMessageId: "u1", text: "add a test" },
        { userMessageId: "u2", text: "skip archived repos" },
      ],
    })
    expect(host.hidden).toBe(false)
    expect(rows()).toEqual(["add a test", "skip archived repos"])
    expect(host.querySelector(".queue-tray-count")!.textContent).toBe("2")
  })

  it("replaces the list wholesale and hides on an empty update", () => {
    tray.applyUpdate({ threadId: "thr-a", queued: [{ userMessageId: "u1", text: "x" }] })
    tray.applyUpdate({ threadId: "thr-a", queued: [] })
    expect(host.hidden).toBe(true)
    expect(rows()).toEqual([])
  })

  it("Steer sends a steer frame, disables the button, and leaves the row to the server", () => {
    tray.applyUpdate({ threadId: "thr-a", queued: [{ userMessageId: "u1", text: "x" }] })
    const btn = host.querySelector<HTMLButtonElement>(".queue-tray-steer")!
    expect(btn.type).toBe("button") // never submits the composer form
    btn.click()
    expect(sent).toEqual([{ type: "steer", threadId: "thr-a", userMessageId: "u1" }])
    expect(btn.disabled).toBe(true)
    expect(rows()).toEqual(["x"])
  })

  it("only shows the active thread's queue, and keeps others for a switch", () => {
    tray.applyUpdate({ threadId: "thr-b", queued: [{ userMessageId: "u9", text: "other" }] })
    expect(host.hidden).toBe(true)
    active = "thr-b"
    tray.render()
    expect(rows()).toEqual(["other"])
  })

  it("a thread snapshot clears that thread's queue", () => {
    tray.applyUpdate({ threadId: "thr-a", queued: [{ userMessageId: "u1", text: "x" }] })
    tray.clearThread("thr-a")
    expect(host.hidden).toBe(true)
    expect(tray._queued("thr-a")).toEqual([])
  })

  it("renders message text as text, never HTML", () => {
    tray.applyUpdate({
      threadId: "thr-a",
      queued: [{ userMessageId: "u1", text: "<img src=x onerror=alert(1)>" }],
    })
    expect(host.querySelector("img")).toBeNull()
    expect(rows()).toEqual(["<img src=x onerror=alert(1)>"])
  })
})
