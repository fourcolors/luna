import { describe, expect, it } from "vitest"
import { runMemorySearch } from "../src/tui/memory-search.js"
import type {
  MemorySearchResultFrame,
  MemorySearchErrorFrame,
} from "@luna/ui-ws"

type SessionLike = Parameters<typeof runMemorySearch>[0]

const makeFakeSession = (
  respond: (args: { queryText: string; topK?: number }) =>
    | MemorySearchResultFrame
    | MemorySearchErrorFrame,
): SessionLike => {
  return {
    searchMemory: async (args) => respond(args),
  } as SessionLike
}

describe("runMemorySearch (WS-mediated)", () => {
  it("returns ready with hits on success", async () => {
    const session = makeFakeSession((args) => ({
      type: "memory-search-result",
      queryText: args.queryText,
      hits: [
        { id: "m1", kind: "feedback", content: "hello", score: 0.9 },
        { id: "m2", kind: "project", content: "world", score: 0.7 },
      ],
    }))
    const result = await runMemorySearch(session, "hello world", 10)
    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error("unreachable")
    expect(result.hits.length).toBe(2)
    expect(result.hits[0]).toEqual({ id: "m1", kind: "feedback", content: "hello", score: 0.9 })
    expect(result.query).toBe("hello world")
  })

  it("returns ready with empty hits when server returns no matches", async () => {
    const session = makeFakeSession((args) => ({
      type: "memory-search-result",
      queryText: args.queryText,
      hits: [],
    }))
    const result = await runMemorySearch(session, "nothing", 10)
    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error("unreachable")
    expect(result.hits.length).toBe(0)
  })

  it("returns error when server replies with memory-search-error frame", async () => {
    const session = makeFakeSession((args) => ({
      type: "memory-search-error",
      queryText: args.queryText,
      message: "no vector backends registered",
      kind: "no-vector-backend",
    }))
    const result = await runMemorySearch(session, "x", 10)
    expect(result.status).toBe("error")
    if (result.status !== "error") throw new Error("unreachable")
    expect(result.message).toContain("no vector backends")
  })

  it("returns idle for empty query", async () => {
    let called = false
    const session = makeFakeSession((args) => {
      called = true
      return {
        type: "memory-search-result",
        queryText: args.queryText,
        hits: [],
      }
    })
    const result = await runMemorySearch(session, "  ", 10)
    expect(result.status).toBe("idle")
    expect(called).toBe(false) // empty query should NOT send a request
  })
})
