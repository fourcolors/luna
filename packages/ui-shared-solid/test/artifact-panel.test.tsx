// @vitest-environment jsdom
/**
 * ArtifactPanel kind-aware render tests (Slice 3).
 *
 * Pins the security-critical render dispatch:
 *   - kind=html   → a sandboxed <iframe> (allow-scripts, NO allow-same-origin),
 *                   srcdoc carries a strict CSP + the content, NO luna.* bridge
 *   - kind=widget → a sandboxed <iframe> WITH the luna.* bridge in its srcdoc
 *   - kind=markdown → the formatted MarkdownView (.markdown), never an iframe
 *   - kind=code   → the code view, never an iframe
 *   - an ephemeral html artifact (lang=html) renders LIVE (derived kind)
 *   - focusSignal selects + previews the named artifact
 */
import { describe, expect, it } from "vitest"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import type { ArtifactKind, ObsEvent, PinnedArtifactItem } from "@luna/ui-shared/core"
import { ArtifactPanel, widgetEventsToForward, type WebMcpRelay } from "../src/ArtifactPanel.jsx"

const stubMcp = (): WebMcpRelay => ({
  readResource: async () => ({ ok: true, text: "<p>app</p>" }),
  callTool: async () => ({ ok: true, result: {} }),
})

const pin = (overrides: Partial<PinnedArtifactItem> = {}): PinnedArtifactItem => ({
  id: "doc:x",
  kind: "code" as ArtifactKind,
  title: "X",
  lang: null,
  content: "content",
  origin: null,
  version: 1,
  pinnedAt: 0,
  updatedAt: 0,
  ...overrides,
})

interface Rig {
  container: HTMLElement
  setPinned: (p: ReadonlyArray<PinnedArtifactItem>) => void
  setFocus: (f: { id: string; nonce: number } | null) => void
  dispose: () => void
}

const mount = (
  pinned: ReadonlyArray<PinnedArtifactItem> = [],
  artifacts: ReadonlyArray<never> = [],
  mcp?: WebMcpRelay,
): Rig => {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const [pinnedS, setPinned] = createSignal<ReadonlyArray<PinnedArtifactItem>>(pinned)
  const [focus, setFocus] = createSignal<{ id: string; nonce: number } | null>(null)
  const dispose = render(
    () => (
      <ArtifactPanel
        artifacts={artifacts}
        pinned={pinnedS()}
        artifactsCapable={true}
        focusSignal={focus()}
        obsEvents={[]}
        mcp={mcp}
      />
    ),
    container,
  )
  return {
    container,
    setPinned,
    setFocus,
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

const iframe = (c: HTMLElement) => c.querySelector<HTMLIFrameElement>("iframe.artifact-iframe")

describe("ArtifactPanel — kind-aware render", () => {
  it("kind=html → sandboxed iframe (allow-scripts, NO allow-same-origin), no luna bridge", () => {
    const rig = mount([pin({ id: "doc:h", kind: "html", title: "Preview", content: "<h1>live</h1>" })])
    const f = iframe(rig.container)
    expect(f).toBeTruthy()
    expect(f!.getAttribute("sandbox")).toBe("allow-scripts")
    expect(f!.getAttribute("sandbox")).not.toContain("allow-same-origin")
    const srcdoc = f!.getAttribute("srcdoc") || ""
    expect(srcdoc).toContain("<h1>live</h1>")
    expect(srcdoc).toContain("default-src 'none'")
    expect(srcdoc).not.toContain("window.luna") // a preview has no live-data door
    rig.dispose()
  })

  it("kind=widget → sandboxed iframe WITH the luna.* bridge in its srcdoc", () => {
    const rig = mount([
      pin({ id: "widget:w", kind: "widget", title: "W", content: "<div>w</div>", bridgeCaps: ["obs:*"] }),
    ])
    const f = iframe(rig.container)
    expect(f).toBeTruthy()
    expect(f!.getAttribute("sandbox")).toBe("allow-scripts")
    const srcdoc = f!.getAttribute("srcdoc") || ""
    expect(srcdoc).toContain("window.luna")
    expect(srcdoc).toContain("<div>w</div>")
    rig.dispose()
  })

  it("kind=markdown → formatted (.markdown), never an iframe", () => {
    const rig = mount([pin({ id: "doc:m", kind: "markdown", title: "M", content: "# Hello" })])
    expect(rig.container.querySelector(".markdown")).toBeTruthy()
    expect(iframe(rig.container)).toBeNull()
    rig.dispose()
  })

  it("kind=code → never an iframe (source view)", () => {
    const rig = mount([pin({ id: "doc:c", kind: "code", title: "C", lang: "ts", content: "const x = 1" })])
    expect(iframe(rig.container)).toBeNull()
    rig.dispose()
  })

  it("kind=mcp-app WITH mcp relay → live sandboxed iframe", () => {
    const rig = mount(
      [pin({ id: "mcp-app:dash", kind: "mcp-app", title: "Dash", content: "<div>app</div>" })],
      [],
      stubMcp(),
    )
    const f = iframe(rig.container)
    expect(f).toBeTruthy()
    expect(f!.getAttribute("sandbox")).toBe("allow-scripts")
    rig.dispose()
  })

  it("kind=mcp-app WITHOUT mcp relay → source fallback (no iframe)", () => {
    const rig = mount([pin({ id: "mcp-app:dash", kind: "mcp-app", title: "Dash", content: "<div>app</div>" })])
    expect(iframe(rig.container)).toBeNull()
    rig.dispose()
  })

  it("an ephemeral html artifact (lang=html) renders LIVE in a sandboxed iframe", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const dispose = render(
      () => (
        <ArtifactPanel
          artifacts={[{ id: "e1", source: "code-fence", path: null, lang: "html", title: "E", content: "<p>e</p>" }]}
          pinned={[]}
          artifactsCapable={true}
        />
      ),
      container,
    )
    const f = container.querySelector<HTMLIFrameElement>("iframe.artifact-iframe")
    expect(f).toBeTruthy()
    expect(f!.getAttribute("sandbox")).toBe("allow-scripts")
    expect((f!.getAttribute("srcdoc") || "")).toContain("<p>e</p>")
    dispose()
    container.remove()
  })

  it("focusSignal selects + previews the named artifact", () => {
    const rig = mount([
      pin({ id: "doc:a", kind: "code", title: "A", content: "aaa" }),
      pin({ id: "widget:b", kind: "widget", title: "B", content: "<b>bbb</b>" }),
    ])
    // 'a' (code) seeds first → no iframe yet.
    expect(iframe(rig.container)).toBeNull()
    // Focus the widget → it becomes selected and renders its iframe.
    rig.setFocus({ id: "widget:b", nonce: 1 })
    const f = iframe(rig.container)
    expect(f).toBeTruthy()
    expect((f!.getAttribute("srcdoc") || "")).toContain("<b>bbb</b>")
    rig.dispose()
  })
})

describe("widgetEventsToForward (luna.* obs-event relay)", () => {
  // The store keeps events NEWEST-FIRST and capped; the helper must forward
  // only the not-yet-seen ones, cap-gated, in chronological (oldest-first)
  // order. Minimal ObsEvent stand-ins — the helper only reads `.kind` + identity.
  const ev = (kind: string) => ({ kind }) as unknown as ObsEvent

  it("returns events newer than lastSeen, chronological, when caps allow all", () => {
    const a = ev("A"), b = ev("B"), c = ev("C")
    // newest-first store [c, b, a]; already saw a → forward b then c.
    expect(widgetEventsToForward([c, b, a], a, ["obs:*"])).toEqual([b, c])
  })

  it("lastSeen=null → all events, chronological (oldest-first)", () => {
    const a = ev("A"), b = ev("B")
    expect(widgetEventsToForward([b, a], null, ["obs:*"])).toEqual([a, b])
  })

  it("forwards the NEWLY-PREPENDED event, never a stale tail (the fixed bug)", () => {
    const a = ev("A"), b = ev("B")
    // subscribe anchored lastSeen=a (newest then); a new event b is PREPENDED.
    expect(widgetEventsToForward([b, a], a, ["obs:*"])).toEqual([b])
  })

  it("cap-gates by kind and FAILS CLOSED on null/empty caps", () => {
    const tool = ev("ToolCall"), other = ev("Other")
    expect(widgetEventsToForward([other, tool], null, ["obs:ToolCall"])).toEqual([tool])
    expect(widgetEventsToForward([other, tool], null, null)).toEqual([])
    expect(widgetEventsToForward([other, tool], null, [])).toEqual([])
  })

  it("returns [] when nothing is newer than lastSeen", () => {
    const a = ev("A")
    expect(widgetEventsToForward([a], a, ["obs:*"])).toEqual([])
  })
})
