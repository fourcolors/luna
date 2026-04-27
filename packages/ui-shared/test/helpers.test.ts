import { describe, expect, it } from "vitest"
import {
  countLines,
  deriveTitle,
  formatBytes,
  truncate,
} from "../src/helpers.js"
import type { ThreadView } from "../src/reducer.js"
import type { ChatMessage, SessionSummary } from "../src/wire.js"

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "t1",
  parentId: null,
  title: null,
  tags: [],
  createdAt: 0,
  endedAt: null,
  model: "m",
  status: "active",
  lastMessageAt: null,
  lastMessagePreview: null,
  ...over,
})

const msg = (role: "user" | "assistant", text: string): ChatMessage => ({
  id: `m-${role}-${text.slice(0, 4)}`,
  seq: 0,
  ts: 0,
  role,
  text,
  toolUses: [],
  attachments: [],
})

const view = (messages: ReadonlyArray<ChatMessage>): ThreadView => ({
  summary: summary(),
  messages,
  throughSeq: messages.length - 1,
  inFlight: null,
  lastError: null,
  artifacts: [],
})

describe("truncate", () => {
  it("returns the string unchanged when ≤ n", () => {
    expect(truncate("hello", 10)).toBe("hello")
    expect(truncate("hello", 5)).toBe("hello")
  })
  it("truncates long strings with an ellipsis", () => {
    expect(truncate("hello world", 8)).toBe("hello w…")
  })
  it("trims trailing whitespace before the ellipsis", () => {
    expect(truncate("hi there friend", 5)).toBe("hi t…")
  })
})

describe("formatBytes", () => {
  it("formats bytes", () => expect(formatBytes(0)).toBe("0 B"))
  it("formats KB at 1024", () => expect(formatBytes(1024)).toBe("1.0 KB"))
  it("formats KB midrange", () => expect(formatBytes(2048)).toBe("2.0 KB"))
  it("formats MB", () =>
    expect(formatBytes(1024 * 1024 * 3)).toBe("3.0 MB"))
})

describe("countLines", () => {
  it("returns 0 for empty string", () => expect(countLines("")).toBe(0))
  it("counts a single line", () => expect(countLines("hello")).toBe(1))
  it("counts multiple lines", () =>
    expect(countLines("a\nb\nc")).toBe(3))
  it("ignores a trailing newline", () =>
    expect(countLines("a\nb\nc\n")).toBe(3))
  it("counts blank lines in the middle", () =>
    expect(countLines("a\n\nb")).toBe(3))
})

describe("deriveTitle", () => {
  it("returns the explicit title when present", () => {
    const s = summary({ title: "  My thread  " })
    expect(deriveTitle(s, undefined)).toBe("My thread")
  })

  it("falls back to first user message when title is null", () => {
    const s = summary({ title: null })
    const v = view([
      msg("assistant", "I'll help"),
      msg("user", "Hello sol, can you help me?"),
      msg("assistant", "Yes"),
    ])
    expect(deriveTitle(s, v)).toBe("Hello sol, can you help me?")
  })

  it("collapses internal whitespace in the user message", () => {
    const s = summary({ title: null })
    const v = view([msg("user", "Hello\n\n  world\t!")])
    expect(deriveTitle(s, v)).toBe("Hello world !")
  })

  it("truncates long user messages to 50 chars with ellipsis", () => {
    const s = summary({ title: null })
    const v = view([
      msg("user", "a".repeat(80)),
    ])
    const out = deriveTitle(s, v)
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThanOrEqual(50)
    expect(out!.endsWith("…")).toBe(true)
  })

  it("falls back to lastMessagePreview when no user message", () => {
    const s = summary({
      title: null,
      lastMessagePreview: "Assistant said hi",
    })
    expect(deriveTitle(s, view([]))).toBe("Assistant said hi")
  })

  it("returns null when nothing to show", () => {
    const s = summary({ title: null, lastMessagePreview: null })
    expect(deriveTitle(s, view([]))).toBeNull()
  })

  it("ignores empty/whitespace title and falls through", () => {
    const s = summary({ title: "   ", lastMessagePreview: "hi" })
    expect(deriveTitle(s, undefined)).toBe("hi")
  })

  it("ignores empty user message text", () => {
    const s = summary({ title: null, lastMessagePreview: "preview" })
    const v = view([msg("user", "   ")])
    expect(deriveTitle(s, v)).toBe("preview")
  })

  it("handles undefined ThreadView (sidebar before subscribe)", () => {
    const s = summary({ title: null, lastMessagePreview: "preview" })
    expect(deriveTitle(s, undefined)).toBe("preview")
  })
})
