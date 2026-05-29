import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer } from "effect"
import {
  EmbedderService,
  StubEmbedderLayer,
  makeOllamaEmbedderLayer,
  type EmbedderError,
} from "@luna/core"
import { getMemoryVectorStatus, reembedMemoryVectors } from "@luna/memory"

export interface MemoryCommandResult {
  readonly exitCode: 0 | 1 | 2
  readonly stdout: string
  readonly stderr: string
}

export interface MemoryCommandOptions {
  readonly env: Record<string, string | undefined>
}

interface ParsedFlags {
  readonly flags: Record<string, string | boolean>
  readonly unknown: ReadonlyArray<string>
}

const HELP = `\
usage: luna memory <subcommand> [options]

subcommands:
  status                      audit vector metadata and compatibility
  reembed --dry-run           report stale rows that would be rebuilt
  reembed --force             rebuild stale rows

common options:
  --db-path <path>             override ~/.luna/memory.db
  --namespace <name>           restrict reembed to namespace
  --limit <n>                  cap rows processed by reembed

embedder env:
  LUNA_EMBEDDER=ollama|stub
  LUNA_OLLAMA_BASE_URL / OLLAMA_HOST
  LUNA_OLLAMA_EMBED_MODEL
  LUNA_OLLAMA_EMBED_DIMENSION
  LUNA_OLLAMA_PROBE_TIMEOUT_MS
`

function parsePositiveIntegerEnv(
  env: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const value = env[name]
  if (value === undefined || value.trim() === "") return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function parsePositiveIntegerFlag(
  value: string | boolean | undefined,
  name: string,
): { readonly value?: number; readonly error?: string } {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return { error: `${name} must be a positive integer` }
  }
  return { value: Number(value) }
}

export function selectMemoryEmbedderLayer(
  env: Record<string, string | undefined>,
): Layer.Layer<EmbedderService, EmbedderError> {
  const choice = env["LUNA_EMBEDDER"]?.toLowerCase()
  if (choice === "ollama") {
    const dimension = parsePositiveIntegerEnv(env, "LUNA_OLLAMA_EMBED_DIMENSION")
    const probeTimeoutMs = parsePositiveIntegerEnv(
      env,
      "LUNA_OLLAMA_PROBE_TIMEOUT_MS",
    )
    return makeOllamaEmbedderLayer({
      ...(env["LUNA_OLLAMA_EMBED_MODEL"] !== undefined
        ? { model: env["LUNA_OLLAMA_EMBED_MODEL"] }
        : {}),
      ...(env["LUNA_OLLAMA_BASE_URL"] !== undefined
        ? { baseUrl: env["LUNA_OLLAMA_BASE_URL"] }
        : env["OLLAMA_HOST"] !== undefined
          ? { baseUrl: env["OLLAMA_HOST"] }
          : {}),
      ...(dimension !== undefined ? { dimension } : {}),
      ...(probeTimeoutMs !== undefined ? { probeTimeoutMs } : {}),
    })
  }
  return StubEmbedderLayer
}

function defaultDbPath(env: Record<string, string | undefined>): string {
  const path =
    env["LUNA_MEMORY_DB"] && env["LUNA_MEMORY_DB"].length > 0
      ? env["LUNA_MEMORY_DB"]
      : join(homedir(), ".luna", "memory.db")
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  }
  return path
}

function parseFlags(argv: ReadonlyArray<string>): ParsedFlags {
  const flags: Record<string, string | boolean> = {}
  const unknown: string[] = []
  const takesValue = new Set(["--db-path", "--namespace", "--limit"])
  const bools = new Set(["--dry-run", "--force"])

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    const eq = token.indexOf("=")
    const key = eq > 0 ? token.slice(0, eq) : token
    if (bools.has(key)) {
      flags[key.slice(2)] = true
      continue
    }
    if (!takesValue.has(key)) {
      unknown.push(token)
      continue
    }
    if (eq > 0) {
      const value = token.slice(eq + 1)
      if (value.length === 0) unknown.push(`${key} requires a value`)
      else {
        flags[
          key.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
        ] = value
      }
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      unknown.push(`${key} requires a value`)
      continue
    }
    flags[
      key.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    ] = value
    i++
  }
  return { flags, unknown }
}

export function formatStatus(
  status: Awaited<ReturnType<typeof readStatus>>,
  dbPath: string,
): string {
  const lines: string[] = []
  lines.push(`Memory DB: ${dbPath}`)
  lines.push(
    `Active embedder: provider=${status.active.provider} model=${status.active.model} dimension=${status.active.dimension} format=${status.active.embeddingFormat}`,
  )
  lines.push(
    `Vectors: total=${status.totalVectors} stale=${status.staleVectors}`,
  )
  if (!status.hnsw.present) {
    lines.push("HNSW: not present")
  } else {
    // The HNSW v-table is dimension-typed (float32[dim]) and can only ever
    // hold rows at the active embedder dimension, so the denominator is the
    // count of active-dimension vectors — NOT totalVectors (which spans every
    // dimension). Using totalVectors would render a perfectly populated index
    // as "N/total" on any store that still holds rows from a previous
    // embedding dimension.
    //
    // getMemoryVectorStatus rebuilds this connection's (memory-only) graph
    // before counting, so indexedCount reflects how many active-dimension rows
    // are indexable: it equals `expected` when healthy, or null when the index
    // could not be probed/rebuilt (extension missing, capacity exceeded, a
    // busy DB, or a dimension mismatch) — rendered as "unknown". There is no
    // separate empty/stale banner: a fresh maintenance connection's graph is
    // always rebuilt, so "empty" is not an observable state here; "unknown" is
    // the signal that the index could not be read.
    const expected = status.groups
      .filter((group) => group.dimension === status.active.dimension)
      .reduce((sum, group) => sum + group.count, 0)
    const indexed =
      status.hnsw.indexedCount === null
        ? "unknown"
        : `${status.hnsw.indexedCount}/${expected}`
    lines.push(
      `HNSW: dimension=${status.hnsw.dimension ?? "unknown"} compatible=${status.hnsw.compatible ? "yes" : "no"} indexed=${indexed}`,
    )
  }
  lines.push("Groups:")
  if (status.groups.length === 0) {
    lines.push("  none")
  } else {
    for (const group of status.groups) {
      lines.push(
        `  count=${group.count} dimension=${group.dimension} provider=${group.embeddingProvider} model=${group.embeddingModel} format=${group.embeddingFormat} compatible=${group.compatible ? "yes" : "no"}`,
      )
    }
  }
  const staleRows = status.rows.filter((row) => row.stale)
  lines.push("Stale rows:")
  if (staleRows.length === 0) {
    lines.push("  none")
  } else {
    for (const row of staleRows) {
      lines.push(
        `  ${row.id} namespace=${row.namespace} reasons=${row.reasons.join(",")}`,
      )
    }
  }
  return `${lines.join("\n")}\n`
}

function formatReembed(result: Awaited<ReturnType<typeof runReembed>>): string {
  const lines: string[] = []
  if (result.dryRun) {
    lines.push(`Dry run: ${result.staleRows} stale row(s)`)
  } else {
    lines.push(`Re-embedded: ${result.reembedded}`)
    lines.push(`Skipped: ${result.skipped}`)
  }
  lines.push(`Scanned: ${result.scannedRows}`)
  for (const row of result.rows) {
    const skip = row.skipReason !== undefined ? ` skip=${row.skipReason}` : ""
    lines.push(
      `  ${row.id} namespace=${row.namespace} reasons=${row.reasons.join(",")}${skip}`,
    )
  }
  return `${lines.join("\n")}\n`
}

async function readStatus(
  dbPath: string,
  env: Record<string, string | undefined>,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const embedder = yield* EmbedderService
      return yield* getMemoryVectorStatus({ dbPath, embedder })
    }).pipe(Effect.provide(selectMemoryEmbedderLayer(env))),
  )
}

async function runReembed(
  dbPath: string,
  env: Record<string, string | undefined>,
  args: {
    readonly dryRun: boolean
    readonly namespace?: string
    readonly limit?: number
  },
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const embedder = yield* EmbedderService
      return yield* reembedMemoryVectors({
        dbPath,
        embedder,
        dryRun: args.dryRun,
        ...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      })
    }).pipe(Effect.provide(selectMemoryEmbedderLayer(env))),
  )
}

export async function runMemoryCommand(
  argv: ReadonlyArray<string>,
  opts: MemoryCommandOptions,
): Promise<MemoryCommandResult> {
  const sub = argv[0]
  if (sub === undefined || sub === "-h" || sub === "--help") {
    return {
      exitCode: sub === undefined ? 2 : 0,
      stdout: sub === undefined ? "" : HELP,
      stderr: sub === undefined ? `error: missing memory subcommand\n${HELP}` : "",
    }
  }
  const parsed = parseFlags(argv.slice(1))
  if (parsed.unknown.length > 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `error: ${parsed.unknown.join(", ")}\n`,
    }
  }
  const dbPath =
    typeof parsed.flags["dbPath"] === "string"
      ? parsed.flags["dbPath"]
      : defaultDbPath(opts.env)

  if (sub === "status") {
    try {
      const status = await readStatus(dbPath, opts.env)
      const hnswMismatch =
        status.hnsw.present && status.hnsw.compatible === false
      return {
        exitCode: hnswMismatch ? 2 : 0,
        stdout: formatStatus(status, dbPath),
        stderr: hnswMismatch
          ? "error: active HNSW dimension does not match configured embedder\n"
          : "",
      }
    } catch (cause) {
      return { exitCode: 2, stdout: "", stderr: `error: ${String(cause)}\n` }
    }
  }

  if (sub === "reembed") {
    const limit = parsePositiveIntegerFlag(parsed.flags["limit"], "--limit")
    if (limit.error !== undefined && parsed.flags["limit"] !== undefined) {
      return { exitCode: 1, stdout: "", stderr: `error: ${limit.error}\n` }
    }
    const dryRun = parsed.flags["dry-run"] === true
    const force = parsed.flags["force"] === true
    if (dryRun === force) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "error: reembed requires exactly one of --dry-run or --force\n",
      }
    }
    try {
      const status = await readStatus(dbPath, opts.env)
      if (status.hnsw.present && status.hnsw.compatible === false) {
        return {
          exitCode: 2,
          stdout: "",
          stderr:
            "error: active HNSW dimension does not match configured embedder\n",
        }
      }
      const result = await runReembed(dbPath, opts.env, {
        dryRun,
        ...(typeof parsed.flags["namespace"] === "string"
          ? { namespace: parsed.flags["namespace"] }
          : {}),
        ...(limit.value !== undefined ? { limit: limit.value } : {}),
      })
      return {
        exitCode: 0,
        stdout: formatReembed(result),
        stderr: "",
      }
    } catch (cause) {
      return { exitCode: 2, stdout: "", stderr: `error: ${String(cause)}\n` }
    }
  }

  return {
    exitCode: 2,
    stdout: "",
    stderr: `error: unknown memory subcommand "${sub}"\n${HELP}`,
  }
}
