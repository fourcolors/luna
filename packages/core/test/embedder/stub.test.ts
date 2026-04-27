/**
 * EmbedderService.StubEmbedder — unit tests.
 *
 * The stub embedder is a deterministic bag-of-tokens hash sketch.
 * These tests pin its three contractual properties:
 *   1. Determinism: same text → same vector.
 *   2. Distinctness: different texts → different vectors (with overwhelming probability).
 *   3. Ranking monotonicity: shared tokens → higher cosine similarity.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  EmbedderService,
  StubEmbedderLayer,
  cosineSimilarity,
  float32ToBuffer,
  bufferToFloat32,
  makeStubEmbedderLayer,
} from "../../src/embedder/index.js"

const run = <A, E>(eff: Effect.Effect<A, E, EmbedderService>) =>
  Effect.runPromise(eff.pipe(Effect.provide(StubEmbedderLayer)))

describe("StubEmbedder", () => {
  it("returns a Float32Array of declared dimension", async () => {
    const v = await run(
      Effect.gen(function* () {
        const e = yield* EmbedderService
        return yield* e.embed("hello world")
      }),
    )
    expect(v).toBeInstanceOf(Float32Array)
    expect(v.length).toBe(64)
  })

  it("is deterministic", async () => {
    const [a, b] = await Promise.all([
      run(Effect.flatMap(EmbedderService, (e) => e.embed("cats and dogs"))),
      run(Effect.flatMap(EmbedderService, (e) => e.embed("cats and dogs"))),
    ])
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it("produces distinct vectors for distinct inputs", async () => {
    const [a, b] = await Promise.all([
      run(Effect.flatMap(EmbedderService, (e) => e.embed("submarine"))),
      run(Effect.flatMap(EmbedderService, (e) => e.embed("torpedo"))),
    ])
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })

  it("ranks lexically-overlapping texts higher under cosine", async () => {
    const target = await run(
      Effect.flatMap(EmbedderService, (e) => e.embed("cats")),
    )
    const overlapping = await run(
      Effect.flatMap(EmbedderService, (e) => e.embed("cats and dogs")),
    )
    const unrelated = await run(
      Effect.flatMap(EmbedderService, (e) => e.embed("submarines and torpedoes")),
    )
    const simHit = cosineSimilarity(target, overlapping)
    const simMiss = cosineSimilarity(target, unrelated)
    expect(simHit).toBeGreaterThan(simMiss)
    // Overlapping shares "cats" → strictly positive overlap.
    expect(simHit).toBeGreaterThan(0)
  })

  it("supports custom dimension", async () => {
    const layer = makeStubEmbedderLayer({ dimension: 16 })
    const v = await Effect.runPromise(
      Effect.flatMap(EmbedderService, (e) => e.embed("xyz")).pipe(
        Effect.provide(layer),
      ),
    )
    expect(v.length).toBe(16)
  })

  it("Float32 ↔ BLOB round-trip preserves bytes", async () => {
    const v = await run(
      Effect.flatMap(EmbedderService, (e) => e.embed("round trip")),
    )
    const buf = float32ToBuffer(v)
    expect(buf.byteLength).toBe(v.length * 4)
    const back = bufferToFloat32(buf)
    expect(back.length).toBe(v.length)
    for (let i = 0; i < v.length; i++) {
      expect(back[i]).toBe(v[i])
    }
  })

  it("returns a non-NaN unit vector for empty/whitespace text", async () => {
    const v = await run(Effect.flatMap(EmbedderService, (e) => e.embed("   ")))
    let mag = 0
    for (let i = 0; i < v.length; i++) mag += v[i] * v[i]
    expect(Number.isFinite(mag)).toBe(true)
    expect(mag).toBeGreaterThan(0)
  })
})
