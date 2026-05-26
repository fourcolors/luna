import { describe, expect, it } from "vitest"
import { Effect, Stream } from "effect"
import { runMemorySearch } from "../src/tui/memory-search.js"

const makeFakeRouter = (results: Array<{ id: string; kind: string; content: string; score: number }>) => ({
  search: (_args: { queryText: string; topK?: number }) =>
    Stream.fromIterable(
      results.map((r) => ({
        record: {
          id: r.id,
          namespace: "default",
          kind: r.kind,
          content: r.content,
          schemaVersion: 1,
          createdAt: 0,
          updatedAt: 0,
          tags: [],
        },
        score: r.score,
      }))
    ),
}) as Parameters<typeof runMemorySearch>[0]

describe("runMemorySearch", () => {
  it("returns ready with hits on success", async () => {
    const router = makeFakeRouter([
      { id: "m1", kind: "feedback", content: "hello", score: 0.9 },
      { id: "m2", kind: "project", content: "world", score: 0.7 },
    ])
    const result = await runMemorySearch(router, "hello world", 10)
    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error("unreachable")
    expect(result.hits.length).toBe(2)
    expect(result.hits[0]).toEqual({ id: "m1", kind: "feedback", content: "hello", score: 0.9 })
    expect(result.query).toBe("hello world")
  })

  it("returns ready with empty hits when no results", async () => {
    const router = makeFakeRouter([])
    const result = await runMemorySearch(router, "nothing", 10)
    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error("unreachable")
    expect(result.hits.length).toBe(0)
  })

  it("returns error with message when search Effect fails", async () => {
    const failingRouter = {
      search: (_args: { queryText: string; topK?: number }) =>
        Stream.fail(new Error("backend down")) as ReturnType<ReturnType<typeof makeFakeRouter>["search"]>,
    } as Parameters<typeof runMemorySearch>[0]
    const result = await runMemorySearch(failingRouter, "x", 10)
    expect(result.status).toBe("error")
    if (result.status !== "error") throw new Error("unreachable")
    expect(result.message).toContain("backend down")
  })

  it("returns idle for empty query", async () => {
    const router = makeFakeRouter([])
    const result = await runMemorySearch(router, "  ", 10)
    expect(result.status).toBe("idle")
  })
})
