/**
 * copy.test.ts — selectForCopy purity tests.
 *
 * Covers the three /copy targets against representative timelines, plus the
 * edge cases (empty timeline, tool blocks interleaved, no assistant text yet).
 */
import { describe, expect, it } from "vitest"
import type { Block, Timeline } from "./timeline.js"
import { selectForCopy } from "./copy.js"

const u = (text: string): Block => ({ kind: "user", text })
const a = (turnId: string, text: string, done = true): Block => ({
  kind: "assistant",
  turnId,
  text,
  done,
})
const t = (
  toolCallId: string,
  name: string,
  status: "running" | "ok" | "error" = "ok",
): Block => ({ kind: "tool", toolCallId, name, input: {}, status })

describe("selectForCopy", () => {
  it("empty timeline → empty string", () => {
    expect(selectForCopy([], { target: "last", count: 1 })).toBe("")
    expect(selectForCopy([], { target: "thread", count: 0 })).toBe("")
    expect(selectForCopy([], { target: "messages", count: 3 })).toBe("")
  })

  it("target=last copies the most recent assistant text only, no decoration", () => {
    const tl: Timeline = [
      u("hi"),
      a("t1", "first reply"),
      u("more"),
      a("t2", "second reply"),
    ]
    expect(selectForCopy(tl, { target: "last", count: 1 })).toBe("second reply")
  })

  it("target=last skips empty assistant blocks (still-streaming)", () => {
    const tl: Timeline = [
      u("hi"),
      a("t1", "done reply"),
      u("more"),
      a("t2", "", false), // streaming, no text yet
    ]
    expect(selectForCopy(tl, { target: "last", count: 1 })).toBe("done reply")
  })

  it("target=last with only user blocks → empty", () => {
    const tl: Timeline = [u("alone")]
    expect(selectForCopy(tl, { target: "last", count: 1 })).toBe("")
  })

  it("target=thread renders every block chronologically with labels", () => {
    const tl: Timeline = [
      u("hi"),
      a("t1", "hello back"),
      t("call1", "shell_run", "ok"),
    ]
    const out = selectForCopy(tl, { target: "thread", count: 0 })
    expect(out).toBe("> hi\n\nhello back\n\n[tool shell_run: ok]")
  })

  it("target=messages copies the last N blocks", () => {
    const tl: Timeline = [
      u("first"),
      a("t1", "1st reply"),
      u("second"),
      a("t2", "2nd reply"),
      u("third"),
    ]
    const out = selectForCopy(tl, { target: "messages", count: 2 })
    expect(out).toBe("2nd reply\n\n> third")
  })

  it("target=messages clamps N to timeline length", () => {
    const tl: Timeline = [u("only")]
    expect(selectForCopy(tl, { target: "messages", count: 99 })).toBe("> only")
  })

  it("target=thread summarizes tool blocks rather than dumping output", () => {
    const tl: Timeline = [
      a("t1", "running this"),
      t("c", "long_running_tool", "running"),
      t("c2", "errored_tool", "error"),
    ]
    const out = selectForCopy(tl, { target: "thread", count: 0 })
    expect(out).toContain("[tool long_running_tool: running]")
    expect(out).toContain("[tool errored_tool: error]")
  })
})
