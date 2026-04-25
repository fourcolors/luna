import { describe, expect, it } from "vitest"
import type { ChatMessage, ChatToolUse } from "@experiment-agent/core"
import { extractArtifacts } from "../src/artifacts.js"

const msg = (
  text: string,
  toolUses: ReadonlyArray<ChatToolUse> = [],
): ChatMessage => ({
  id: "m1",
  seq: 0,
  ts: 0,
  role: "assistant",
  text,
  toolUses,
})

const longBody = (lines: number) =>
  Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n")

describe("extractArtifacts — code fences", () => {
  it("returns nothing for short inline fences", () => {
    const m = msg(
      "Sure! Try `npm i` and:\n\n```bash\nnpm test\n```\n\ndone.",
    )
    expect(extractArtifacts(m)).toEqual([])
  })

  it("captures a fence ≥ 10 lines", () => {
    const body = longBody(12)
    const m = msg("Here you go:\n\n```ts\n" + body + "\n```")
    const arts = extractArtifacts(m)
    expect(arts).toHaveLength(1)
    expect(arts[0]!.source).toBe("code-fence")
    expect(arts[0]!.lang).toBe("ts")
    expect(arts[0]!.content).toBe(body)
    expect(arts[0]!.id).toBe("m1:0")
    expect(arts[0]!.path).toBeNull()
  })

  it("captures a fence ≥ 400 chars even if few lines", () => {
    const body = "x".repeat(420)
    const m = msg("```json\n" + body + "\n```")
    expect(extractArtifacts(m)).toHaveLength(1)
  })

  it("captures multiple fences in order", () => {
    const m = msg(
      "First:\n\n```ts\n" +
        longBody(11) +
        "\n```\n\nSecond:\n\n```json\n" +
        longBody(15) +
        "\n```",
    )
    const arts = extractArtifacts(m)
    expect(arts.map((a) => a.lang)).toEqual(["ts", "json"])
    expect(arts.map((a) => a.id)).toEqual(["m1:0", "m1:1"])
  })

  it("handles fence with no lang tag", () => {
    const m = msg("```\n" + longBody(11) + "\n```")
    const arts = extractArtifacts(m)
    expect(arts).toHaveLength(1)
    expect(arts[0]!.lang).toBeNull()
    expect(arts[0]!.title).toBe("code")
  })
})

describe("extractArtifacts — tool writes", () => {
  it("captures Write tool use", () => {
    const tu: ChatToolUse = {
      id: "tu-1",
      name: "Write",
      input: { file_path: "/tmp/foo.ts", content: "export const x = 1" },
    }
    const arts = extractArtifacts(msg("ok done", [tu]))
    expect(arts).toHaveLength(1)
    expect(arts[0]).toMatchObject({
      source: "tool-write",
      path: "/tmp/foo.ts",
      lang: "ts",
      title: "foo.ts",
      content: "export const x = 1",
    })
  })

  it("captures Edit tool use via new_string", () => {
    const tu: ChatToolUse = {
      id: "tu-2",
      name: "Edit",
      input: {
        file_path: "/a/b.py",
        old_string: "x = 1",
        new_string: "x = 2",
      },
    }
    const arts = extractArtifacts(msg("", [tu]))
    expect(arts[0]!.lang).toBe("python")
    expect(arts[0]!.content).toBe("x = 2")
  })

  it("ignores Read / non-write tool uses", () => {
    const tu: ChatToolUse = {
      id: "tu-3",
      name: "Read",
      input: { file_path: "/a/b.txt" },
    }
    expect(extractArtifacts(msg("hi", [tu]))).toEqual([])
  })

  it("returns nothing when input lacks path or content", () => {
    const tu: ChatToolUse = {
      id: "tu-4",
      name: "Write",
      input: { content: "no path" },
    }
    expect(extractArtifacts(msg("", [tu]))).toEqual([])
  })

  it("orders tool-writes before code fences and re-numbers ids", () => {
    const tu: ChatToolUse = {
      id: "tu-5",
      name: "Write",
      input: { file_path: "/x/y.json", content: "{}" },
    }
    const m = msg("Wrote it. Also:\n\n```ts\n" + longBody(12) + "\n```", [tu])
    const arts = extractArtifacts(m)
    expect(arts).toHaveLength(2)
    expect(arts[0]!.source).toBe("tool-write")
    expect(arts[0]!.id).toBe("m1:0")
    expect(arts[1]!.source).toBe("code-fence")
    expect(arts[1]!.id).toBe("m1:1")
  })
})
