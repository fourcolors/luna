/**
 * Luna SqliteVectorBackend vs QMD — head-to-head benchmark.
 *
 * Why this is interesting:
 *   - QMD currently runs BM25-only (hasVectorIndex: false on the local index)
 *   - Luna runs naive cosine over our StubEmbedder (bag-of-tokens hash sketch)
 *   - Same corpus, same queries → which approach surfaces the right doc?
 *
 * Run: `bun packages/memory/bench/qmd-vs-luna.ts`
 *
 * What we measure:
 *   - ingest latency (Luna only — QMD already indexed)
 *   - per-query search latency
 *   - top-K results from Luna (printed for human eyeball comparison vs QMD)
 *
 * QMD side: this script prints the queries + Luna results, so the operator
 * (you) can run the same query through QMD via MCP and eyeball the diff.
 * A fully-automated comparison would need an MCP client in-process; that's
 * out of scope for the v1 harness.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { Effect, Layer, Stream } from "effect"
import { StubEmbedderLayer, makeStubEmbedderLayer } from "@luna/core"
import { SqliteVectorBackend } from "../src/backends/sqlite-vector.js"
import { LunaSqliteBootstrapLive } from "../src/backends/vectorlite-bootstrap.js"
import { makeRecord } from "../src/types.js"

const CORPUS_DIR = "<local-memory-corpus>"
const MAX_DOC_BYTES = 10240 // QMD's default ceiling
const TOP_K = 5

const QUERIES: { q: string; intent: string }[] = [
  {
    q: "qmd cli broken better-sqlite3",
    intent: "find the lesson about node25 incompatibility",
  },
  {
    q: "discord table rendering pipe markdown",
    intent: "lesson about discord chat formatting",
  },
  {
    q: "librarian subagent cost",
    intent: "the librarian-cost lesson",
  },
  {
    q: "memory provider middleware abstraction",
    intent: "memory provider project notes",
  },
  {
    q: "context fork isolation inheritance",
    intent: "specific lesson about subagent context",
  },
  {
    q: "how does luna's sql persistence work",
    intent: "natural-language query about luna architecture",
  },
  {
    q: "supermemory hydration pipeline",
    intent: "memory pipeline notes",
  },
  {
    q: "vector search vs keyword search tradeoffs",
    intent: "generic concept query",
  },
]

function loadCorpus(): { id: string; path: string; text: string }[] {
  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".md"))
  const out: { id: string; path: string; text: string }[] = []
  for (const f of files) {
    const path = join(CORPUS_DIR, f)
    const stat = statSync(path)
    if (stat.size > MAX_DOC_BYTES) continue
    const text = readFileSync(path, "utf8")
    out.push({ id: basename(f, ".md"), path, text })
  }
  return out
}

const program = Effect.gen(function* () {
  const corpus = loadCorpus()
  console.log(`📚 Corpus: ${corpus.length} docs from ${CORPUS_DIR}\n`)

  // Use a 256-dim stub embedder (4× wider than the test default — better
  // resolution at this corpus size). Default 64 has too many hash collisions.
  const wideStub = makeStubEmbedderLayer({ dimension: 256 })
  const layer = Layer.provideMerge(
    SqliteVectorBackend.fromPath(":memory:"),
    Layer.merge(wideStub, LunaSqliteBootstrapLive),
  )

  yield* Effect.scoped(
    Effect.gen(function* () {
      const b = yield* SqliteVectorBackend

      // ─── Ingest ────────────────────────────────────────────────────────
      const ingestStart = performance.now()
      for (const doc of corpus) {
        yield* b.put(
          makeRecord({
            id: doc.id,
            namespace: "sol-agent",
            kind: "note",
            content: { text: doc.text, path: doc.path },
          }),
        )
      }
      const ingestMs = performance.now() - ingestStart
      console.log(
        `✅ Ingested ${corpus.length} docs in ${ingestMs.toFixed(0)}ms ` +
          `(avg ${(ingestMs / corpus.length).toFixed(2)}ms/doc)\n`,
      )

      // ─── Query loop ───────────────────────────────────────────────────
      const latencies: number[] = []
      for (const { q, intent } of QUERIES) {
        console.log(`──────────────────────────────────────────────────`)
        console.log(`🔎 query: "${q}"`)
        console.log(`   intent: ${intent}`)
        const t0 = performance.now()
        const results = yield* Stream.runCollect(
          b.search({ queryText: q, namespace: "sol-agent", topK: TOP_K }),
        )
        const dt = performance.now() - t0
        latencies.push(dt)
        const arr = Array.from(results)
        console.log(`   luna: ${dt.toFixed(1)}ms`)
        if (arr.length === 0) {
          console.log(`     (no results)`)
        } else {
          for (let i = 0; i < arr.length; i++) {
            const r = arr[i]!
            console.log(
              `     ${i + 1}. ${r.score.toFixed(3)}  ${r.record.id}`,
            )
          }
        }
        console.log()
      }

      latencies.sort((a, b) => a - b)
      const p50 = latencies[Math.floor(latencies.length * 0.5)]!
      const p95 = latencies[Math.floor(latencies.length * 0.95)]!
      const avg =
        latencies.reduce((a, b) => a + b, 0) / latencies.length
      console.log(`──────────────────────────────────────────────────`)
      console.log(`📊 Luna latency over ${QUERIES.length} queries:`)
      console.log(`   avg ${avg.toFixed(1)}ms · p50 ${p50.toFixed(1)}ms · p95 ${p95.toFixed(1)}ms`)
      console.log()
      console.log(`Next: run the same queries through QMD for comparison:`)
      for (const { q } of QUERIES) {
        console.log(`   qmd: ${q}`)
      }
    }).pipe(Effect.provide(layer)),
  )
})

Effect.runPromise(program).catch((err) => {
  console.error("benchmark failed:", err)
  process.exit(1)
})
