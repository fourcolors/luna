// @vitest-environment jsdom
/**
 * MessageList.test.tsx - behavioral coverage for the React reconciler +
 * legacy ChatState/ChatLoop bridge (mountMessageList). Loads the REAL vendor
 * moon-markdown.js into window.LunaMarkdown (same technique as
 * luna-markdown.parity.test.ts) so text/timeline rendering exercises the
 * actual frozen sanitizer, not a stub.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { act } from "react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createChatModelStore, type ChatModelStore } from "./chatModel"
import { mountMessageList, WELCOME_ITEM, type ChatMessageListMount } from "./MessageList"
import type { LunaMarkdownApi } from "./luna-markdown"

// Tells React this jsdom environment is a synchronous-act test environment
// (matches chat-chrome.test.tsx's precedent).
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../../../frontend/vendor/moon-markdown.js"),
    "utf8",
  )
  const g = {} as { LunaMarkdown?: LunaMarkdownApi }
  new Function("globalThis", src)(g)
  if (!g.LunaMarkdown) throw new Error("vendor IIFE did not expose LunaMarkdown")
  ;(window as unknown as { LunaMarkdown: LunaMarkdownApi }).LunaMarkdown = g.LunaMarkdown
})

let container: HTMLDivElement | null = null
let store: ChatModelStore
let mount: ChatMessageListMount | null
let onOpenAgentsPanel: ReturnType<typeof vi.fn>

// chat.html's buildMessageMeta lives outside the S15 conversion scope (see
// MessageList.tsx's module doc) - stubbed here just enough to prove
// MessageList calls it correctly at the right sites, mirroring its real
// shape (a `.msg-meta` row: optional `.msg-delivery` chip, then `.msg-copy`,
// then an optional `.msg-time`).
function stubBuildMessageMeta(
  text: string,
  ts: number | undefined,
  delivery: { label?: string } | null,
): HTMLElement {
  const row = document.createElement("div")
  row.className = "msg-meta"
  if (delivery) {
    const chip = document.createElement("span")
    chip.className = "msg-delivery"
    const label = document.createElement("span")
    label.className = "label"
    label.textContent = delivery.label ? `from ${delivery.label}` : "from a background task"
    chip.appendChild(label)
    row.appendChild(chip)
  }
  const copy = document.createElement("button")
  copy.className = "msg-copy"
  row.appendChild(copy)
  if (typeof ts === "number" && Number.isFinite(ts)) {
    const time = document.createElement("span")
    time.className = "msg-time"
    row.appendChild(time)
  }
  return row
}

function setup(grouped = true) {
  container = document.createElement("div")
  container.id = "chat-messages"
  document.body.appendChild(container)
  store = createChatModelStore()
  onOpenAgentsPanel = vi.fn()
  // Stubs window.LunaChatHost (stack23 S16c-host) rather than __MoonInternals -
  // getBuildMessageMeta() reads through getChatHost()?.buildMessageMeta now.
  // A partial object is fine here: this suite never calls any OTHER host
  // member, and this file doesn't go through chat.html's classic script (no
  // Object.freeze), so a plain assignment is enough.
  ;(window as unknown as { LunaChatHost: { buildMessageMeta: typeof stubBuildMessageMeta } }).LunaChatHost = {
    buildMessageMeta: stubBuildMessageMeta,
  }
  act(() => {
    mount = mountMessageList(container, {
      store,
      getGrouped: () => grouped,
      onOpenAgentsPanel,
    })
  })
}

beforeEach(() => {
  setup()
})

afterEach(() => {
  if (container) container.remove()
  container = null
  mount = null
  document.body.innerHTML = ""
  delete (window as unknown as { LunaChatHost?: unknown }).LunaChatHost
  vi.restoreAllMocks()
})

describe("mountMessageList", () => {
  it("degrades to a no-op mount (returns null) when the container is missing", () => {
    const result = mountMessageList(null, { getGrouped: () => true, onOpenAgentsPanel: () => {} })
    expect(result).toBeNull()
  })

  it("mounts with zero turns rendering nothing when the caller passes no emptyStateItem", () => {
    expect(container?.children).toHaveLength(0)
  })

  it("renders the caller-supplied emptyStateItem in place of a genuinely empty transcript, and drops it once real content lands", () => {
    const welcomeContainer = document.createElement("div")
    document.body.appendChild(welcomeContainer)
    let welcomeMount: ChatMessageListMount | null = null
    act(() => {
      welcomeMount = mountMessageList(welcomeContainer, {
        store: createChatModelStore(),
        getGrouped: () => true,
        onOpenAgentsPanel: () => {},
        emptyStateItem: WELCOME_ITEM,
      })
    })
    expect(welcomeContainer.children).toHaveLength(1)
    expect(welcomeContainer.querySelector(".msg-body")?.textContent).toContain("native macOS Luna companion")
    expect(welcomeContainer.children[0]?.getAttribute("data-msg-key")).toBe("welcome")

    act(() => {
      welcomeMount?.ChatState.appendUser("hi", null, 1)
      welcomeMount?.ChatLoop.flush()
    })
    // The welcome item is gone (not left as an extra sibling) once a real
    // turn exists - the orphan-prune's keyed lookup drops it like any other
    // stale item.
    expect(welcomeContainer.children).toHaveLength(1)
    expect(welcomeContainer.querySelector(".msg.user")).toBeTruthy()
    expect(welcomeContainer.textContent).not.toContain("native macOS Luna companion")

    welcomeContainer.remove()
  })
})

describe("ChatState/ChatLoop bridge - streaming render", () => {
  it("appendUser + flush paints one .msg.user bubble synchronously (flushSync)", () => {
    act(() => {
      mount?.ChatState.appendUser("hello there", null, 1000)
      mount?.ChatLoop.flush()
    })
    const msg = container?.querySelector(".msg.user")
    expect(msg).toBeTruthy()
    expect(msg?.querySelector(".msg-body")?.textContent).toBe("hello there")
    expect(msg?.getAttribute("data-msg-key")).toMatch(/^u-1000-0\|u$/)
  })

  it("streaming deltas render through the REAL sanitizer and re-render in place without duplicating the bubble", () => {
    act(() => {
      mount?.ChatState.applyDelta("t1", "Hel")
      mount?.ChatLoop.flush()
    })
    expect(container?.querySelectorAll(".msg.assistant")).toHaveLength(1)
    expect(container?.querySelector(".msg-body")?.innerHTML).toContain("Hel")

    act(() => {
      mount?.ChatState.applyDelta("t1", "Hello **world**")
      mount?.ChatLoop.flush()
    })
    // Still exactly one bubble (same data-msg-key, reconciled in place) and
    // the markdown bold survived the real renderMarkdownStreaming call.
    expect(container?.querySelectorAll(".msg.assistant")).toHaveLength(1)
    expect(container?.querySelector(".msg-body strong")?.textContent).toBe("world")

    act(() => {
      mount?.ChatState.finishTurn("t1", "", 42)
      mount?.ChatLoop.flush()
    })
    // Settled text gets the meta row (copy button + time) appended via the
    // window.LunaChatHost.buildMessageMeta bridge.
    expect(container?.querySelector(".msg-copy")).toBeTruthy()
  })

  it("a typing placeholder renders typing-dots, then is replaced by real content", () => {
    act(() => {
      mount?.ChatState.beginPendingAssistant()
      mount?.ChatLoop.flush()
    })
    expect(container?.querySelector(".typing-dots")).toBeTruthy()

    act(() => {
      mount?.ChatState.applyDelta("t1", "hi")
      mount?.ChatLoop.flush()
    })
    expect(container?.querySelector(".typing-dots")).toBeNull()
    expect(container?.querySelector(".msg-body")?.textContent).toContain("hi")
  })

  it("sanitizes a script tag through the real vendor pipeline (XSS regression guard)", () => {
    act(() => {
      mount?.ChatState.applyDelta("t1", "<script>alert(1)</script>")
      mount?.ChatState.finishTurn("t1", "", 1)
      mount?.ChatLoop.flush()
    })
    const body = container?.querySelector(".msg-body")
    expect(body?.innerHTML).not.toMatch(/<script/i)
    expect(body?.innerHTML).toContain("&lt;script&gt;")
  })
})

describe("tool calls -> activity timeline", () => {
  it("a tool call collapses into a timeline with a ToolCard step, then shows the answer bubble below", () => {
    act(() => {
      mount?.ChatState.applyDelta("t1", "checking")
      mount?.ChatState.applyToolCall("t1", "c1", "Bash", { cmd: "ls" })
      mount?.ChatState.applyToolResult("c1", true, "file.txt", false)
      mount?.ChatState.applyDelta("t1", "checkingdone")
      mount?.ChatState.finishTurn("t1", "", 1)
      // Deliberately NOT markRunSettled() here - a settled run auto-collapses
      // (see the next test), which would hide .timeline-body and its
      // .tool-call-card. This asserts the still-expanded (in-flight) shape.
      mount?.ChatLoop.flush()
    })
    const timeline = container?.querySelector(".timeline")
    expect(timeline).toBeTruthy()
    expect(timeline?.querySelector(".tool-call-card")).toBeTruthy()
    expect(timeline?.querySelector(".tool-card-status-ok")).toBeTruthy()
    expect(timeline?.querySelector(".tool-card-input")?.textContent).toContain('"cmd": "ls"')
    expect(timeline?.querySelector(".tool-card-output")?.textContent).toBe("file.txt")
    // Answer bubble (text after the last tool) renders as its own sibling.
    expect(container?.querySelector(".msg.assistant .msg-body")?.textContent).toContain("done")
  })

  it("clicking the timeline summary toggles collapse via ChatState.toggleTimelineCollapsed", () => {
    act(() => {
      mount?.ChatState.applyToolCall("t1", "c1", "Bash", {})
      mount?.ChatState.finishTurn("t1", "", 1)
      mount?.ChatState.markRunSettled()
      mount?.ChatLoop.flush()
    })
    const timeline = container?.querySelector(".timeline") as HTMLElement
    expect(timeline.classList.contains("collapsed")).toBe(true) // settled -> auto-collapsed

    const turnKey = timeline.dataset.turnKey as string
    act(() => {
      mount?.ChatState.toggleTimelineCollapsed(turnKey, true)
      mount?.ChatLoop.flush()
    })
    const timelineAfter = container?.querySelector(".timeline") as HTMLElement
    expect(timelineAfter.classList.contains("collapsed")).toBe(false)
    expect(timelineAfter.querySelector(".timeline-body")).toBeTruthy()
  })

  it("the Agent 'view ↗' link calls onOpenAgentsPanel without toggling the details element", () => {
    act(() => {
      mount?.ChatState.applyToolCall("t1", "c1", "Agent", { description: "do research" })
      mount?.ChatLoop.flush()
    })
    const link = container?.querySelector(".agent-view-link") as HTMLButtonElement
    expect(link).toBeTruthy()
    act(() => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    })
    expect(onOpenAgentsPanel).toHaveBeenCalledTimes(1)
  })
})

describe("S15c: tool-call/text interleaving parity (mirrors chat-window.test.ts's oracle scenarios)", () => {
  it("a delta after a tool-call-card carries data-stream-raw on the BUBBLE itself (not just its .msg-body child) - matches vanilla _paintText", () => {
    act(() => {
      mount?.ChatState.applyToolCall("t1", "c1", "Read", { path: "/etc/hosts" })
      mount?.ChatState.applyDelta("t1", "Here is what I found.")
      mount?.ChatLoop.flush()
    })
    const bubbles = container?.querySelectorAll(".msg.assistant")
    expect(bubbles).toHaveLength(1)
    const bubble = bubbles?.[0] as HTMLElement
    expect(bubble.classList.contains("tool-call-card")).toBe(false)
    expect(bubble.dataset.streamRaw).toBe("Here is what I found.")
    expect(bubble.dataset.turnId).toBe("t1")
  })

  it("a stray non-React DOM child left in the container (e.g. static pre-mount markup) is pruned on the next paint, not left as an extra sibling", () => {
    // Simulates a node the React root never created - the vanilla renderer's
    // ChatRenderer.render() unconditionally dropped any child whose
    // data-msg-key wasn't in its current plan (see chat.html git history);
    // this pins that same guarantee for the React reconciler's container.
    const stray = document.createElement("div")
    stray.className = "msg assistant"
    stray.innerHTML = '<div class="typing-dots"><div class="dot"></div></div>'
    container?.appendChild(stray)
    expect(container?.children).toHaveLength(1)

    act(() => {
      mount?.ChatState.applyDelta("x", "Hello.")
      mount?.ChatLoop.flush()
    })
    // The stray node is gone; only the real, keyed bubble remains.
    expect(container?.children).toHaveLength(1)
    expect(container?.querySelector(".typing-dots")).toBeNull()
    const bubble = container?.children[0] as HTMLElement
    expect(bubble.dataset.msgKey).toBeTruthy()
    expect(bubble.textContent).toContain("Hello.")
  })
})

describe("banners / errors / delivered turns", () => {
  it("appendBanner renders a plain-text bubble (no markdown)", () => {
    act(() => {
      mount?.ChatState.appendBanner("<b>raw</b> not markdown")
      mount?.ChatLoop.flush()
    })
    const body = container?.querySelector(".msg.assistant .msg-body")
    expect(body?.textContent).toBe("<b>raw</b> not markdown")
    expect(body?.querySelector("b")).toBeNull()
  })

  it("failTurn renders an error bubble", () => {
    act(() => {
      mount?.ChatState.applyDelta("t1", "partial")
      mount?.ChatState.failTurn("t1", "boom")
      mount?.ChatLoop.flush()
    })
    expect(container?.querySelector(".msg.assistant.error")?.textContent).toContain("boom")
  })

  it("appendDelivered renders a standalone bubble carrying the delivery chip", () => {
    act(() => {
      mount?.ChatState.appendDelivered({ text: "background result", ts: 1, delivery: { label: "nightly" } })
      mount?.ChatLoop.flush()
    })
    expect(container?.querySelector(".msg-delivery .label")?.textContent).toContain("nightly")
  })
})

describe("hasVisibleStreamingPlaceholder / dropPendingAssistant bridge parity", () => {
  it("reflects the pure selector against the live store", () => {
    expect(mount?.ChatState.hasVisibleStreamingPlaceholder()).toBe(false)
    act(() => {
      mount?.ChatState.beginPendingAssistant()
    })
    expect(mount?.ChatState.hasVisibleStreamingPlaceholder()).toBe(true)
    act(() => {
      mount?.ChatState.dropPendingAssistant()
    })
    expect(mount?.ChatState.hasVisibleStreamingPlaceholder()).toBe(false)
    expect(mount?.ChatState.turns).toHaveLength(0)
  })

  it("is also true while a trailing activity timeline is unsettled (its summary now shows a live constellation rather than .typing-dots)", () => {
    act(() => {
      mount?.ChatState.applyToolCall("t1", "c1", "Bash", { cmd: "ls" })
      mount?.ChatLoop.flush()
    })
    // The dots in the timeline summary were replaced by the constellation. The
    // PREDICATE is unchanged - hasVisibleStreamingPlaceholder is computed from
    // the turns, never from a DOM query - so this asserts the new marker while
    // pinning the same logical behaviour the vanilla handler relied on.
    expect(container?.querySelector(".timeline .typing-dots")).toBeNull()
    expect(container?.querySelector(".constellation-row .constellation")).toBeTruthy()
    expect(container?.querySelector(".constellation-row .constellation.rest")).toBeNull()
    expect(container?.querySelector(".constellation-row .star-new")).toBeTruthy()
    expect(mount?.ChatState.hasVisibleStreamingPlaceholder()).toBe(true)

    act(() => {
      mount?.ChatState.finishTurn("t1", "", 1)
      mount?.ChatState.markRunSettled()
      mount?.ChatLoop.flush()
    })
    // Settled: the record moves INTO the collapsed timeline-summary bar - the
    // trailing .constellation-row is gone entirely, not just resting.
    expect(container?.querySelector(".constellation-row")).toBeNull()
    expect(container?.querySelector(".timeline-summary .constellation.rest")).toBeTruthy()
    expect(container?.querySelector(".timeline-summary .star-new")).toBeNull()
    expect(mount?.ChatState.hasVisibleStreamingPlaceholder()).toBe(false)
  })

  it("a settled turn's star map stays in the summary bar even when the user manually re-expands the timeline", () => {
    act(() => {
      mount?.ChatState.applyToolCall("t1", "c1", "Bash", { cmd: "ls" })
      mount?.ChatState.finishTurn("t1", "", 1)
      mount?.ChatState.markRunSettled()
      mount?.ChatLoop.flush()
    })
    const timeline = container?.querySelector(".timeline") as HTMLElement
    expect(timeline.classList.contains("collapsed")).toBe(true)
    expect(container?.querySelector(".timeline-summary .constellation")).toBeTruthy()

    const turnKey = timeline.dataset.turnKey as string
    act(() => {
      mount?.ChatState.toggleTimelineCollapsed(turnKey, true)
      mount?.ChatLoop.flush()
    })
    const timelineAfter = container?.querySelector(".timeline") as HTMLElement
    expect(timelineAfter.classList.contains("collapsed")).toBe(false)
    expect(timelineAfter.querySelector(".timeline-body")).toBeTruthy()
    // Still there - the summary is a persistent header, not gated on collapse.
    expect(container?.querySelector(".timeline-summary .constellation")).toBeTruthy()
    // Exactly one star map exists anywhere - no stale trailing row left behind
    // by the re-expand, and no duplicate render.
    expect(container?.querySelectorAll(".constellation").length).toBe(1)
    expect(container?.querySelector(".constellation-row")).toBeNull()
  })

  it("a settled turn whose only tool calls are subagent-nested renders no star map at all (starsFor legitimately returns zero)", () => {
    act(() => {
      // parentToolUseId set - starsFor folds this into its parent Agent star
      // and never counts it as a top-level call, so the top-level count is
      // zero even though a tool call happened and a timeline is planned.
      mount?.ChatState.applyToolCall("t1", "c1", "Bash", { cmd: "ls" }, "parent-1")
      mount?.ChatState.finishTurn("t1", "", 1)
      mount?.ChatState.markRunSettled()
      mount?.ChatLoop.flush()
    })
    const timeline = container?.querySelector(".timeline") as HTMLElement
    expect(timeline).toBeTruthy()
    expect(timeline.classList.contains("collapsed")).toBe(true)
    // Same net result as before this PR's placement change: nothing renders.
    expect(container?.querySelector(".timeline-summary .constellation")).toBeNull()
    expect(container?.querySelector(".constellation-row")).toBeNull()
  })

  it("clicking a star does not toggle the timeline's collapsed state (the row's whole-bar toggle must not swallow inspecting a star)", () => {
    act(() => {
      mount?.ChatState.applyToolCall("t1", "c1", "Bash", { cmd: "ls" })
      mount?.ChatState.finishTurn("t1", "", 1)
      mount?.ChatState.markRunSettled()
      mount?.ChatLoop.flush()
    })
    const timeline = container?.querySelector(".timeline") as HTMLElement
    expect(timeline.classList.contains("collapsed")).toBe(true)
    const star = container?.querySelector(".timeline-summary .star") as SVGPathElement
    expect(star).toBeTruthy()

    act(() => {
      star.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    })
    // React's onClick stops the event before it bubbles to wiring.ts's
    // delegated .timeline-summary listener, so the row stays collapsed.
    expect((container?.querySelector(".timeline") as HTMLElement).classList.contains("collapsed")).toBe(true)
  })
})

describe("ChatLoop.schedule() rAF coalescing", () => {
  it("multiple schedule() calls within a frame coalesce into a single render", () => {
    let rafCb: FrameRequestCallback | null = null
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCb = cb
      return 1
    })

    act(() => {
      mount?.ChatState.appendBanner("one")
      mount?.ChatLoop.schedule()
      mount?.ChatState.appendBanner("two")
      mount?.ChatLoop.schedule() // idempotent within the frame - only one rAF requested
    })
    expect(rafSpy).toHaveBeenCalledTimes(1)
    expect(container?.children).toHaveLength(0) // not yet flushed

    act(() => {
      rafCb?.(0)
    })
    expect(container?.querySelectorAll(".msg.assistant")).toHaveLength(2)
  })

  it("flush() cancels a pending scheduled frame and renders synchronously instead", () => {
    let cancelled: number | null = null
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7)
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      cancelled = id
    })

    act(() => {
      mount?.ChatState.appendBanner("scheduled")
      mount?.ChatLoop.schedule()
      mount?.ChatLoop.flush()
    })
    expect(cancelled).toBe(7)
    expect(container?.querySelectorAll(".msg.assistant")).toHaveLength(1)
  })
})

describe("scroll anchoring", () => {
  function setScrollMetrics(el: HTMLElement, { scrollHeight, scrollTop, clientHeight }: Record<string, number>) {
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight })
    Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight })
    let top = scrollTop
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v) => {
        top = v
      },
    })
  }

  it("auto-scrolls to bottom when the container was already near the bottom", () => {
    const el = container as HTMLElement
    setScrollMetrics(el, { scrollHeight: 500, scrollTop: 480, clientHeight: 30 }) // 500-480-30=-10 <=40
    act(() => {
      el.dispatchEvent(new Event("scroll"))
    })
    act(() => {
      mount?.ChatState.appendBanner("x")
      mount?.ChatLoop.flush()
    })
    expect(el.scrollTop).toBe(500)
  })

  it("does NOT auto-scroll when the container was scrolled away from the bottom", () => {
    const el = container as HTMLElement
    setScrollMetrics(el, { scrollHeight: 1000, scrollTop: 0, clientHeight: 30 }) // far from bottom
    // jsdom never fires 'scroll' synthetically from a property write (real
    // browsers do - see MessageList.tsx's scroll-anchoring comment) - fire
    // it explicitly to simulate the user having scrolled away.
    act(() => {
      el.dispatchEvent(new Event("scroll"))
    })
    act(() => {
      mount?.ChatState.appendBanner("x")
      mount?.ChatLoop.flush()
    })
    expect(el.scrollTop).toBe(0)
  })
})
