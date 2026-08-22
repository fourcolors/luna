/**
 * ObsEvent Schema validation at the emit boundary.
 *
 * Locks the contract: emit() validates the payload at runtime; malformed
 * events are dropped and replaced with a synthetic Error event tagged
 * `ObsSchemaViolation`. Caller never sees a failure (observability must
 * not poison the host).
 */
import { describe, expect, it } from "vitest"
import { Chunk, Duration, Effect, Fiber, Layer, Stream } from "effect"
import { Clock } from "../src/clock.js"
import {
  ObservabilityService,
  decodeObsEvent,
} from "../src/observability/index.js"
import { Result } from "effect"

const makeLayer = () =>
  ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(Clock.Default),
  )

const run = <A, E>(prog: Effect.Effect<A, E, ObservabilityService | Clock>) =>
  Effect.runPromise(
    Effect.scoped(prog.pipe(Effect.provide(makeLayer()))),
  )

describe("ObsEvent schema validation", () => {
  it("decodeObsEvent rejects ToolCall with legacy `tool` field", () => {
    const bad = {
      ts: new Date().toISOString(),
      kind: "ToolCall",
      level: "info",
      tool: "bash", // wrong — should be `toolName`
      durationMs: 1,
      status: "ok", // wrong — should be "success" | "error" | "permission_denied"
    }
    const result = decodeObsEvent(bad)
    expect(Result.isFailure(result)).toBe(true)
  })

  it("decodeObsEvent accepts a well-formed ToolCall", () => {
    const good = {
      ts: new Date().toISOString(),
      kind: "ToolCall",
      level: "info",
      toolName: "bash",
      durationMs: 1,
      status: "success",
    }
    const result = decodeObsEvent(good)
    expect(Result.isSuccess(result)).toBe(true)
  })

  it("emit() drops a malformed event and emits a synthetic ObsSchemaViolation Error", async () => {
    const collected = await run(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const stream = yield* obs.subscribeEvents
        const fiber = yield* Effect.forkChild(
          stream.pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        )
        yield* Effect.sleep(Duration.millis(10))

        // Cast through unknown to bypass TS — simulates producer drift.
        yield* obs.emit({
          ts: new Date().toISOString(),
          kind: "ToolCall",
          level: "info",
          tool: "bash",
          durationMs: 1,
          status: "ok",
        } as never)

        return yield* Fiber.join(fiber)
      }),
    )
    expect(collected).toHaveLength(1)
    const ev = collected[0]
    expect(ev?.kind).toBe("Error")
    if (ev?.kind === "Error") {
      expect(ev.errorTag).toBe("ObsSchemaViolation")
      expect(ev.context?.["offendingKind"]).toBe("ToolCall")
    }
  })

  it("decodeObsEvent rejects RetrievalCall missing embedderModel", () => {
    const bad = {
      ts: new Date().toISOString(),
      kind: "RetrievalCall",
      level: "info",
      mode: "hybrid",
      queryDigest: "abc123",
      embedderProvider: "ollama",
      // embedderModel missing — required
      embedderDimension: 768,
      candidateCount: 3,
      durationMs: 12,
      status: "success",
    }
    expect(Result.isFailure(decodeObsEvent(bad))).toBe(true)
  })

  it("decodeObsEvent accepts a well-formed RetrievalCall", () => {
    const good = {
      ts: new Date().toISOString(),
      kind: "RetrievalCall",
      level: "info",
      mode: "hybrid",
      queryDigest: "abc123",
      embedderProvider: "ollama",
      embedderModel: "embeddinggemma",
      embedderDimension: 768,
      candidateCount: 3,
      topScore: 0.87,
      durationMs: 12,
      status: "success",
    }
    expect(Result.isSuccess(decodeObsEvent(good))).toBe(true)
  })

  it("decodeObsEvent accepts a well-formed rerank-stage RetrievalCall (no embedder fields)", () => {
    const good = {
      ts: new Date().toISOString(),
      kind: "RetrievalCall",
      level: "info",
      mode: "hybrid",
      candidateCount: 20,
      durationMs: 42,
      status: "success",
      reranked: true,
      rerankMs: 42,
      kept: 5,
      dropped: 12,
    }
    expect(Result.isSuccess(decodeObsEvent(good))).toBe(true)
  })

  it("decodeObsEvent rejects a RetrievalCall with reranked:true but missing rerank stats", () => {
    const bad = {
      ts: new Date().toISOString(),
      kind: "RetrievalCall",
      level: "info",
      mode: "hybrid",
      candidateCount: 20,
      durationMs: 42,
      status: "success",
      reranked: true,
      // rerankMs / kept / dropped missing - and no embedder fields either,
      // so it satisfies neither union member.
    }
    expect(Result.isFailure(decodeObsEvent(bad))).toBe(true)
  })

  it("emit() passes through a well-formed event unchanged", async () => {
    const collected = await run(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const stream = yield* obs.subscribeEvents
        const fiber = yield* Effect.forkChild(
          stream.pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        )
        yield* Effect.sleep(Duration.millis(10))

        yield* obs.emit({
          ts: new Date().toISOString(),
          kind: "ToolCall",
          level: "info",
          toolName: "bash",
          durationMs: 1,
          status: "success",
        })

        return yield* Fiber.join(fiber)
      }),
    )
    expect(collected).toHaveLength(1)
    expect(collected[0]?.kind).toBe("ToolCall")
  })
})
