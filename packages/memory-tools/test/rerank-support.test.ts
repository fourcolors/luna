import { describe, expect, it, beforeEach } from "vitest"
import { Effect, Logger } from "effect"
import { RerankError } from "@luna/core"
import {
  DEFAULT_RERANK_THRESHOLD,
  emitRerankObservability,
  logRerankFailureOnce,
  rerankFlagEnabled,
  resetRerankFailureLogState,
  resolveRerankThreshold,
} from "../src/rerank-support.js"

describe("resolveRerankThreshold", () => {
  it("defaults to 40 when unset", () => {
    expect(resolveRerankThreshold({})).toBe(DEFAULT_RERANK_THRESHOLD)
  })

  it("reads a valid override", () => {
    expect(resolveRerankThreshold({ LUNA_RERANK_THRESHOLD: "60" })).toBe(60)
  })

  it("falls back to default on a non-numeric value", () => {
    expect(resolveRerankThreshold({ LUNA_RERANK_THRESHOLD: "not-a-number" })).toBe(
      DEFAULT_RERANK_THRESHOLD,
    )
  })

  it("falls back to default on an out-of-[0,100] value", () => {
    expect(resolveRerankThreshold({ LUNA_RERANK_THRESHOLD: "150" })).toBe(
      DEFAULT_RERANK_THRESHOLD,
    )
    expect(resolveRerankThreshold({ LUNA_RERANK_THRESHOLD: "-5" })).toBe(
      DEFAULT_RERANK_THRESHOLD,
    )
  })

  it("accepts 0 and 100 as valid boundary values", () => {
    expect(resolveRerankThreshold({ LUNA_RERANK_THRESHOLD: "0" })).toBe(0)
    expect(resolveRerankThreshold({ LUNA_RERANK_THRESHOLD: "100" })).toBe(100)
  })
})

describe("rerankFlagEnabled", () => {
  it("is false when unset", () => {
    expect(rerankFlagEnabled("LUNA_MEMORY_RERANK", {})).toBe(false)
  })

  it("is true only for the literal '1'", () => {
    expect(rerankFlagEnabled("LUNA_MEMORY_RERANK", { LUNA_MEMORY_RERANK: "1" })).toBe(true)
    expect(rerankFlagEnabled("LUNA_MEMORY_RERANK", { LUNA_MEMORY_RERANK: "true" })).toBe(false)
    expect(rerankFlagEnabled("LUNA_MEMORY_RERANK", { LUNA_MEMORY_RERANK: "yes" })).toBe(false)
    expect(rerankFlagEnabled("LUNA_MEMORY_RERANK", { LUNA_MEMORY_RERANK: "0" })).toBe(false)
  })
})

describe("logRerankFailureOnce", () => {
  beforeEach(() => resetRerankFailureLogState())

  const captureLogger = (messages: string[]) =>
    Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message }) => {
        messages.push(String(message))
      }),
    )

  it("logs the first failure on a lane and suppresses subsequent ones", async () => {
    const messages: string[] = []
    const err = new RerankError({ op: "timeout", message: "boom" })
    const prog = Effect.gen(function* () {
      yield* logRerankFailureOnce("memory_search", err)
      yield* logRerankFailureOnce("memory_search", err)
      yield* logRerankFailureOnce("memory_search", err)
    }).pipe(Effect.provide(captureLogger(messages)))
    await Effect.runPromise(prog)
    expect(messages.length).toBe(1)
  })

  it("different lanes are logged independently", async () => {
    const messages: string[] = []
    const err = new RerankError({ op: "parse", message: "boom" })
    const prog = Effect.gen(function* () {
      yield* logRerankFailureOnce("memory_search", err)
      yield* logRerankFailureOnce("recallForTurn", err)
    }).pipe(Effect.provide(captureLogger(messages)))
    await Effect.runPromise(prog)
    expect(messages.length).toBe(2)
  })
})

describe("emitRerankObservability", () => {
  it("is a no-op (Effect.void) when obs is undefined", async () => {
    await Effect.runPromise(
      emitRerankObservability(undefined, {
        queryText: "q",
        mode: "hybrid",
        rerankMs: 10,
        kept: 3,
        dropped: 5,
      }),
    )
    // No throw = pass; there's nothing else to assert against a true no-op.
  })

  it("emits a well-formed RetrievalCallRerankEvent", async () => {
    const emitted: unknown[] = []
    const obs = {
      emit: (event: unknown) => {
        emitted.push(event)
        return Effect.void
      },
      recordCost: () => Effect.void,
      events: undefined as never,
      subscribeEvents: undefined as never,
    }
    await Effect.runPromise(
      emitRerankObservability(obs as never, {
        queryText: "what do I like",
        namespace: "notes",
        mode: "hybrid",
        rerankMs: 123,
        kept: 4,
        dropped: 16,
      }),
    )
    expect(emitted).toHaveLength(1)
    const ev = emitted[0] as Record<string, unknown>
    expect(ev["kind"]).toBe("RetrievalCall")
    expect(ev["reranked"]).toBe(true)
    expect(ev["rerankMs"]).toBe(123)
    expect(ev["kept"]).toBe(4)
    expect(ev["dropped"]).toBe(16)
    expect(ev["candidateCount"]).toBe(20)
    expect(ev["namespace"]).toBe("notes")
    expect(ev["embedderProvider"]).toBeUndefined()
    expect(typeof ev["queryDigest"]).toBe("string")
  })
})
