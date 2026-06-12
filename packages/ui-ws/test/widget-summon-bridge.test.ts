/**
 * WidgetSummonBridge — summon-by-name semantics (widget-system.md):
 * last-announcer-wins, directory-validated kinds, stale-close safety.
 */
import { describe, expect, it } from "vitest"
import { createWidgetSummonBridge } from "../src/widget-summon-bridge.js"
import type { WidgetOpenFrame } from "../src/protocol.js"

const DIR = [
  { kind: "settings.voice", title: "Voice", description: "Voice settings" },
  { kind: "settings.updates", title: "Updates", description: "App updates" },
]

describe("widget-summon-bridge", () => {
  it("no host connected → open fails with a helpful message", () => {
    const b = createWidgetSummonBridge()
    const r = b.open("settings.voice")
    expect(r.ok).toBe(false)
    expect(r.message).toContain("No widget-capable client")
    expect(b.directory()).toEqual([])
  })

  it("announced directory validates kinds and sends widget-open", () => {
    const sent: WidgetOpenFrame[] = []
    const b = createWidgetSummonBridge()
    b.registerClient("c1", (f) => sent.push(f), DIR)
    expect(b.directory().map((w) => w.kind)).toEqual(["settings.voice", "settings.updates"])

    const ok = b.open("settings.voice")
    expect(ok).toEqual({ ok: true, message: "Asked the app to open settings.voice." })
    expect(sent).toEqual([{ type: "widget-open", kind: "settings.voice" }])

    const bad = b.open("settings.nope")
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain("settings.voice") // lists what IS available
    expect(sent).toHaveLength(1) // nothing sent for the unknown kind
  })

  it("malformed directory entries are dropped (fail closed)", () => {
    const b = createWidgetSummonBridge()
    b.registerClient("c1", () => {}, [
      { kind: "ok.kind", title: "t", description: "d" },
      { kind: "", title: "t", description: "d" },
      // @ts-expect-error deliberately malformed wire input
      { title: "no-kind" },
      // @ts-expect-error deliberately malformed wire input
      null,
    ])
    expect(b.directory().map((w) => w.kind)).toEqual(["ok.kind"])
  })

  it("last announcer wins; a STALE close cannot wipe the live host", () => {
    const sentA: WidgetOpenFrame[] = []
    const sentB: WidgetOpenFrame[] = []
    const b = createWidgetSummonBridge()
    b.registerClient("a", (f) => sentA.push(f), DIR)
    b.registerClient("b", (f) => sentB.push(f), DIR)

    // The old connection closes AFTER the new one took over.
    b.unregisterClient("a")
    expect(b.open("settings.voice").ok).toBe(true)
    expect(sentB).toHaveLength(1)
    expect(sentA).toHaveLength(0)

    // The LIVE host closing does clear the bridge.
    b.unregisterClient("b")
    expect(b.open("settings.voice").ok).toBe(false)
  })

  it("a throwing send surfaces as a clean failure", () => {
    const b = createWidgetSummonBridge()
    b.registerClient("c1", () => { throw new Error("socket gone") }, DIR)
    const r = b.open("settings.voice")
    expect(r.ok).toBe(false)
    expect(r.message).toContain("connection failed")
  })
})
