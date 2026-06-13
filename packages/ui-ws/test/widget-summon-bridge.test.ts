/**
 * WidgetSummonBridge — summon-by-name semantics (widget-system.md):
 * last-announcer-wins, directory-validated kinds, stale-close safety.
 */
import { describe, expect, it } from "vitest"
import { createWidgetSummonBridge } from "../src/widget-summon-bridge.js"
import type {
  OpenArtifactWidgetFrame,
  WidgetOpenFrame,
} from "../src/protocol.js"

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

describe("widget-summon-bridge — openArtifact (content tier)", () => {
  it("no host connected → openArtifact fails gracefully", () => {
    const b = createWidgetSummonBridge()
    const r = b.openArtifact("widget:x", "X", "widget")
    expect(r.ok).toBe(false)
    expect(r.message).toContain("No widget-capable client")
  })

  it("sends an open-artifact-widget frame to the registered host (no directory gate)", () => {
    const sent: Array<WidgetOpenFrame | OpenArtifactWidgetFrame> = []
    const b = createWidgetSummonBridge()
    // Register with an EMPTY directory — content artifacts are not registry
    // kinds, so openArtifact must not consult the directory at all.
    b.registerClient("c1", (f) => sent.push(f), [])
    const r = b.openArtifact("widget:pr-99-tracker", "PR #99", "widget")
    expect(r.ok).toBe(true)
    expect(r.message).toContain("PR #99")
    expect(sent).toEqual([
      {
        type: "open-artifact-widget",
        artifactId: "widget:pr-99-tracker",
        title: "PR #99",
        kind: "widget",
      },
    ])
  })

  it("rides the same single host slot as open (last-announcer-wins)", () => {
    const sentA: Array<WidgetOpenFrame | OpenArtifactWidgetFrame> = []
    const sentB: Array<WidgetOpenFrame | OpenArtifactWidgetFrame> = []
    const b = createWidgetSummonBridge()
    b.registerClient("a", (f) => sentA.push(f), DIR)
    b.registerClient("b", (f) => sentB.push(f), DIR)
    expect(b.openArtifact("mcp-app:dash", "Dash", "mcp-app").ok).toBe(true)
    expect(sentB).toHaveLength(1)
    expect(sentA).toHaveLength(0)
  })

  it("a throwing send surfaces as a clean failure", () => {
    const b = createWidgetSummonBridge()
    b.registerClient("c1", () => { throw new Error("socket gone") }, DIR)
    const r = b.openArtifact("widget:x", "X", "widget")
    expect(r.ok).toBe(false)
    expect(r.message).toContain("connection failed")
  })
})

describe("widget-summon-bridge — open-intent replay (mid-reconnect)", () => {
  it("buffers an open issued with no host, then replays it to the next host", () => {
    const sent: Array<WidgetOpenFrame | OpenArtifactWidgetFrame> = []
    const b = createWidgetSummonBridge()

    // No host connected yet (Moon mid-reconnect during a long turn).
    const r = b.openArtifact("widget:pr-99", "PR #99", "widget")
    expect(r.ok).toBe(false)
    expect(r.message).toContain("queued")
    expect(sent).toHaveLength(0)

    // The host reconnects and announces → the queued open is replayed.
    b.registerClient("c1", (f) => sent.push(f), [])
    expect(sent).toEqual([
      { type: "open-artifact-widget", artifactId: "widget:pr-99", title: "PR #99", kind: "widget" },
    ])
  })

  it("dedups by artifactId — an iterate-then-reopen loop replays only the latest", () => {
    const sent: Array<WidgetOpenFrame | OpenArtifactWidgetFrame> = []
    const b = createWidgetSummonBridge()
    b.openArtifact("widget:x", "old title", "widget")
    b.openArtifact("widget:x", "new title", "widget")
    b.registerClient("c1", (f) => sent.push(f), [])
    expect(sent).toEqual([
      { type: "open-artifact-widget", artifactId: "widget:x", title: "new title", kind: "widget" },
    ])
  })

  it("flushes exactly once — a second register with no new opens replays nothing", () => {
    const sentA: Array<WidgetOpenFrame | OpenArtifactWidgetFrame> = []
    const sentB: Array<WidgetOpenFrame | OpenArtifactWidgetFrame> = []
    const b = createWidgetSummonBridge()
    b.openArtifact("widget:x", "X", "widget")
    b.registerClient("a", (f) => sentA.push(f), [])
    expect(sentA).toHaveLength(1)
    // A fresh reconnect (no opens in between) must NOT re-pop the window.
    b.registerClient("b", (f) => sentB.push(f), [])
    expect(sentB).toHaveLength(0)
  })

  it("does NOT buffer opens issued while a host is connected", () => {
    const sentA: Array<WidgetOpenFrame | OpenArtifactWidgetFrame> = []
    const sentB: Array<WidgetOpenFrame | OpenArtifactWidgetFrame> = []
    const b = createWidgetSummonBridge()
    b.registerClient("a", (f) => sentA.push(f), [])
    expect(b.openArtifact("widget:x", "X", "widget").ok).toBe(true)
    expect(sentA).toHaveLength(1)
    // The next host to register inherits NO replay — the open already happened.
    b.registerClient("b", (f) => sentB.push(f), [])
    expect(sentB).toHaveLength(0)
  })

  it("bounds the buffer — only the most recent opens survive", () => {
    const sent: Array<WidgetOpenFrame | OpenArtifactWidgetFrame> = []
    const b = createWidgetSummonBridge()
    // Issue more distinct opens than the bound (8) while disconnected.
    for (let i = 0; i < 12; i++) {
      b.openArtifact(`widget:a${i}`, `A${i}`, "widget")
    }
    b.registerClient("c1", (f) => sent.push(f), [])
    // Bounded to the 8 most-recent; the 4 oldest (a0..a3) are dropped.
    expect(sent).toHaveLength(8)
    const ids = sent.map((f) => (f as OpenArtifactWidgetFrame).artifactId)
    expect(ids).toEqual([
      "widget:a4", "widget:a5", "widget:a6", "widget:a7",
      "widget:a8", "widget:a9", "widget:a10", "widget:a11",
    ])
  })
})
