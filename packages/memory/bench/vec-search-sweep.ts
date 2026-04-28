/**
 * vec-search-sweep — Phase 27 micro-bench for SqliteVectorBackend.
 *
 * Builds N ∈ {100, 500, 1000, 5000} stub-embedded records, then measures
 * `search()` latency (p50, p95) per N. Reports a markdown table.
 *
 * NOT a vitest. Run via:
 *   bun packages/memory/bench/vec-search-sweep.ts
 *
 * The bench uses StubEmbedder (64-dim, deterministic, zero I/O) so the
 * measurement isolates the vector-search pipeline (SQL + Vectorlite KNN).
 */
import { Effect, Layer, Stream } from "effect"
import { StubEmbedderLayer } from "@luna/core"
import { SqliteVectorBackend } from "../src/backends/sqlite-vector.js"
import { initVectorlite } from "../src/backends/vectorlite-init.js"
import { makeRecord } from "../src/types.js"

const SWEEP_SIZES = [100, 500, 1_000, 5_000]
const QUERIES_PER_SIZE = 50

interface Row {
  readonly n: number
  readonly p50: number
  readonly p95: number
  readonly maxMs: number
}

async function benchOne(N: number): Promise<Row> {
  const layer = Layer.provideMerge(
    SqliteVectorBackend.fromPath(":memory:"),
    StubEmbedderLayer,
  )

  const lats = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        for (let i = 0; i < N; i++) {
          yield* b.put(
            makeRecord({
              id: `r-${i}`,
              namespace: "bench",
              kind: "note",
              content: {
                text: `record ${i} payload alpha beta gamma delta epsilon ${
                  i % 13
                } zeta`,
              },
            }),
          )
        }
        const out: number[] = []
        for (let q = 0; q < QUERIES_PER_SIZE; q++) {
          const t0 = performance.now()
          yield* Stream.runCollect(
            b.search({
              queryText: `record ${q * 7} payload`,
              namespace: "bench",
              topK: 10,
            }),
          )
          out.push(performance.now() - t0)
        }
        return out
      }),
    ).pipe(Effect.provide(layer)),
  )

  lats.sort((a, b) => a - b)
  const p50 = lats[Math.floor(lats.length * 0.5)]!
  const p95 = lats[Math.floor(lats.length * 0.95)]!
  const maxMs = lats[lats.length - 1]!
  return { n: N, p50, p95, maxMs }
}

async function main(): Promise<void> {
  const init = initVectorlite()
  // eslint-disable-next-line no-console
  console.log(
    init.ok
      ? `# vec-search-sweep — Vectorlite HNSW path (${init.path})`
      : `# vec-search-sweep — fallback NAIVE cosine path (${init.reason})`,
  )

  const rows: Row[] = []
  for (const N of SWEEP_SIZES) {
    // eslint-disable-next-line no-console
    console.error(`  …running N=${N.toLocaleString()}`)
    rows.push(await benchOne(N))
  }

  // Markdown table.
  // eslint-disable-next-line no-console
  console.log(``)
  console.log(`| N | p50 (ms) | p95 (ms) | max (ms) |`)
  console.log(`|---:|---:|---:|---:|`)
  for (const r of rows) {
    console.log(
      `| ${r.n.toLocaleString().padStart(5)} | ${r.p50.toFixed(2).padStart(6)} | ${r.p95
        .toFixed(2)
        .padStart(6)} | ${r.maxMs.toFixed(2).padStart(6)} |`,
    )
  }
}

await main()
