/**
 * Shared plumbing for the LongMemEval scripts (run.ts = QA smoke,
 * sweep.ts = retrieval-config sweep): a fresh in-memory store per
 * question, and error helpers for fail-closed exits.
 */
import { Clock, ObservabilityService, makeOllamaEmbedderLayer } from "@luna/core"
import { Effect, Layer } from "effect"
import { SqliteVectorBackend } from "../../backends/sqlite-vector.js"
import { LunaSqliteBootstrapLive } from "../../backends/vectorlite-bootstrap.js"
import { MemoryLayer } from "../../layer.js"
import type { ExpansionSidecar, SearchConfig } from "../../search-config.js"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const EXPANSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../bench/expansion")

/** Does `e` (or anything on its `cause` chain) carry this Effect error tag? */
export function hasErrorTag(e: unknown, tag: string, depth = 0): boolean {
  if (depth > 8 || e === null || typeof e !== "object") return false
  if ((e as { _tag?: unknown })._tag === tag) return true
  return hasErrorTag((e as { cause?: unknown }).cause, tag, depth + 1)
}

export function describeError(e: unknown, depth = 0): string {
  if (depth > 8 || e === null || e === undefined) return ""
  const tag = typeof e === "object" && "_tag" in e ? String((e as { _tag: unknown })._tag) : ""
  const message = e instanceof Error ? e.message : String(e)
  const self = tag && (message === "" || message === tag) ? tag : tag ? `${tag}: ${message}` : message
  const cause = typeof e === "object" ? describeError((e as { cause?: unknown }).cause, depth + 1) : ""
  return `${self}${cause ? ` <- ${cause}` : ""}`
}

/** A fresh in-memory store per question: no shared index, no order effects. */
export function makeQuestionLayer(embedModel: string, baseUrl: string) {
  const supportLayer = Layer.mergeAll(
    ObservabilityService.Default.pipe(Layer.provide(Clock.Default)),
    makeOllamaEmbedderLayer({ model: embedModel, baseUrl }),
    Clock.Default,
    LunaSqliteBootstrapLive,
  )
  return Layer.unwrap(
    Effect.gen(function* () {
      const backend = yield* SqliteVectorBackend
      return MemoryLayer({ rules: [{ pattern: "*", backend }] })
    }),
  ).pipe(
    Layer.provideMerge(SqliteVectorBackend.fromPath(":memory:")),
    Layer.provideMerge(supportLayer),
  )
}

/**
 * Expansion-keyword sidecars (bench/expansion/longmemeval-<model>.json,
 * written by bench/expand-queries.ts) for every model the configs name.
 * A missing or mismatched file is an error: a config asking for keywords
 * must never silently run without them.
 */
export function loadExpansionSidecars(
  configs: ReadonlyArray<SearchConfig>,
): ReadonlyMap<string, ExpansionSidecar> {
  const out = new Map<string, ExpansionSidecar>()
  for (const c of configs) {
    const model = c.expansion?.model
    if (model === undefined || out.has(model)) continue
    const path = resolve(EXPANSION_DIR, `longmemeval-${model}.json`)
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ExpansionSidecar
    if (parsed.source !== "longmemeval" || parsed.model !== model) {
      throw new Error(`${path}: expected source "longmemeval" and model "${model}"`)
    }
    out.set(model, parsed)
  }
  return out
}
