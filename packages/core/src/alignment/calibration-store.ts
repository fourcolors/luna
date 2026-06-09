/**
 * CalibrationStore — append-only `calibration_log` for Slice A calibration
 * instrumentation (MEASURE-ONLY). Mirrors AlignmentStore's two-layer shape:
 * a Ref-backed `Memory` layer for tests and a bun:sqlite `makeLayer(dbPath)`
 * for prod, requiring Clock + LunaSqliteBootstrap.
 *
 *   - `calibration_log` is append-only and idempotent on a deterministic id
 *     derived from (dreamId, targetId) ONLY — `cal-<dreamId>-<targetId>` —
 *     via INSERT OR IGNORE, so a re-proposal over the same window collapses
 *     (FIRST-WRITE-WINS).
 *
 * HARD invariant (spec §HARD): this is pure, write-only instrumentation. The
 * recorded `confidence` is the EXISTING verbalized Dream confidence (Slice A
 * placeholder; sampling deferred to Slice B) and `detectability` is a trivial
 * heuristic over DreamOpKind. Nothing here is ever read back into scoring /
 * injection / activation / cadence / belief strength. The pure `calculateEce`
 * is measure-only — it NEVER gates and NEVER throws.
 */
import { Data, Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"
// `Tier` is imported as a TYPE only (no value/re-export) so that an
// `export * from "./tier-classifier.js"` in index.ts cannot collide with a
// `Tier` symbol exported from here. See tier-classifier.ts for the HARD
// MEASURE-ONLY invariant — `tier` is write-only and never read back.
import type { Tier } from "./tier-classifier.js"

// ── bun:sqlite minimal shape ─────────────────────────────────────────────────

interface BunDb {
  run: (sql: string) => void
  query: (sql: string) => BunStmt
  close: () => void
}
interface BunStmt {
  get: (...p: unknown[]) => unknown
  all: (...p: unknown[]) => unknown[]
  run: (...p: unknown[]) => { changes: number }
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** Migration-ladder component key for the calibration table. */
export const CALIBRATION_COMPONENT = "calibration"

/**
 * Insert shape — `id` is derived from (dreamId, targetId) ONLY (not confidence
 * / proposalAt / etc.), so a re-proposal over the same window collapses.
 */
export interface CalibrationRowInput {
  readonly dreamId: string
  readonly targetId: string
  readonly beliefId: string
  readonly proposalAt: number
  /** Verbalized 0..1 placeholder (Slice A; NOT sampling). */
  readonly confidence: number
  /**
   * Slice B MEASURE-ONLY sampling-agreement confidence (SelfCheckGPT-style):
   * the fraction of N reasoning passes that agreed on this belief. Logged
   * SIDE-BY-SIDE with the verbalized `confidence` above for offline ECE
   * comparison. OPTIONAL/nullable so Slice-A callers (and old rows) stay green;
   * WRITE-ONLY — NEVER read back into scoring / injection / activation /
   * cadence / belief strength (HARD invariant).
   */
  readonly sampledConfidence?: number | null
  /** Trivial heuristic over DreamOpKind: belief_candidate→1, memory_dedup→0. */
  readonly detectability: number
  /** Placeholder (=1 in Slice A; Slice B will vary). */
  readonly sampleCount: number
  /**
   * Slice 3 MEASURE-ONLY autonomy tier (0|1|2) from classifyTier — OPTIONAL so
   * callers that omit it (e.g. calibration-store.test.ts's `rec()` helper) stay
   * green. WRITE-ONLY: recorded to learn whether the tier boundaries are sane;
   * NEVER read back into scoring / injection / activation / cadence / belief
   * strength (HARD invariant, see tier-classifier.ts).
   */
  readonly tier?: Tier | null
}

/** One persisted calibration-log row. */
export interface CalibrationRow extends CalibrationRowInput {
  readonly id: string
}

/**
 * Verdict shape for the temporal join. beliefs/types.ts BeliefValidation is
 * {at, verdict, via} with NO beliefId, so joinVerdicts callers MUST add the
 * beliefId — hence this input type carries it.
 */
export interface JoinVerdictInput {
  readonly beliefId: string
  readonly at: number
  readonly verdict: "confirmed" | "corrected" | "rejected"
  readonly via: "survey" | "outreach"
}

/**
 * One verdict-joined calibration record. The verdict→outcome map lives HERE
 * (in joinVerdicts), so calculateEce is pure binning over {confidence, outcome}.
 */
export interface JoinedRecord {
  readonly beliefId: string
  readonly confidence: number
  readonly outcome: 0 | 1
}

export class CalibrationError extends Data.TaggedError("CalibrationError")<{
  readonly op: string
  readonly message: string
  readonly cause?: unknown
}> {}

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS calibration_log (
    id           TEXT NOT NULL PRIMARY KEY,
    dream_id     TEXT NOT NULL,
    belief_id    TEXT NOT NULL,
    proposal_at  INTEGER NOT NULL,
    confidence   REAL NOT NULL,
    detectability REAL NOT NULL,
    sample_count INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_calibration_log_belief ON calibration_log(belief_id, proposal_at);
`

/**
 * Slice 3 MEASURE-ONLY: add a nullable `tier` column. Old (v1) rows tolerate
 * NULL. Recording mechanism chosen over a sibling write (DECISION NEEDING
 * CONFIRMATION, tier-classifier.feature.md §(4)) — fewer surfaces, and `tier`
 * is never read back into behavior.
 */
const SCHEMA_V2 = `ALTER TABLE calibration_log ADD COLUMN tier INTEGER`

/**
 * Slice B MEASURE-ONLY: add a nullable `sampled_confidence` column (the
 * SelfCheckGPT-style agreement fraction), logged ALONGSIDE the verbalized
 * `confidence` for offline ECE comparison. Old (v1/v2) rows tolerate NULL.
 * Same pattern as the v2 `tier` column; never read back into behavior.
 */
const SCHEMA_V3 = `ALTER TABLE calibration_log ADD COLUMN sampled_confidence REAL`

/**
 * Deterministic idempotency id — depends on (dreamId, targetId) ONLY. A
 * re-proposal over the same window regenerates the same id, so INSERT OR
 * IGNORE collapses duplicates (FIRST-WRITE-WINS).
 */
export const deriveCalId = (i: CalibrationRowInput): string =>
  `cal-${i.dreamId}-${i.targetId}`

// ── Store API ───────────────────────────────────────────────────────────────

export interface CalibrationStoreApi {
  /** Idempotent on (dreamId, targetId); same id twice = 1 row. Returns id. */
  readonly record: (input: CalibrationRowInput) => Effect.Effect<string, CalibrationError>
  readonly list: () => Effect.Effect<ReadonlyArray<CalibrationRow>, CalibrationError>
}

export class CalibrationStore extends Effect.Tag("luna/CalibrationStore")<
  CalibrationStore,
  CalibrationStoreApi
>() {
  /** Ref-backed in-memory layer for tests. No SQLite. */
  static readonly Memory: Layer.Layer<CalibrationStore, never, Clock> = Layer.effect(
    CalibrationStore,
    Effect.gen(function* () {
      const rows = yield* Ref.make<ReadonlyArray<CalibrationRow>>([])

      const record: CalibrationStoreApi["record"] = (input) =>
        Effect.gen(function* () {
          const id = deriveCalId(input)
          const existing = yield* Ref.get(rows)
          // FIRST-WRITE-WINS: bail before the update so the first payload sticks.
          if (existing.some((r) => r.id === id)) return id // INSERT OR IGNORE
          const r: CalibrationRow = { id, ...input }
          yield* Ref.update(rows, (rs) => [...rs, r])
          return id
        })

      const list: CalibrationStoreApi["list"] = () => Ref.get(rows)

      return { record, list } satisfies CalibrationStoreApi
    }),
  )

  /**
   * SQLite-backed Layer. `dbPath` may be `":memory:"` for ephemeral use.
   * Requires `Clock` and `LunaSqliteBootstrap` in the environment.
   */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<CalibrationStore, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.scoped(
      CalibrationStore,
      Effect.gen(function* () {
        // Pull bootstrap marker BEFORE opening any Database so the
        // process-wide setCustomSQLite swap has run.
        yield* LunaSqliteBootstrap

        const clock = yield* Clock

        // Dynamic import — insulates stock-node vitest from hard-failing
        // at module load.
        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "calibration-store",
              key: "bun:sqlite",
              message: `failed to import bun:sqlite: ${String(cause)}`,
            }),
        })
        const Database = (mod as { Database?: unknown }).Database as
          | (new (p: string) => BunDb)
          | undefined
        if (!Database) {
          return yield* Effect.fail(
            new ConfigError({
              module: "calibration-store",
              key: "bun:sqlite",
              message: "bun:sqlite module has no `Database` export",
            }),
          )
        }

        const db = new Database(dbPath)

        // Pragmas before any writes.
        db.run("PRAGMA journal_mode = WAL")
        db.run("PRAGMA synchronous = NORMAL")
        db.run("PRAGMA foreign_keys = ON")

        // §5.2 migration ladder — NEW component 'calibration'.
        const nowMs = yield* clock.nowMs()
        ensureSchemaVersions(db)
        applyMigration(db, CALIBRATION_COMPONENT, 1, SCHEMA_V1, nowMs)
        // Slice 3 MEASURE-ONLY: bump to v2 to add the nullable `tier` column.
        applyMigration(db, CALIBRATION_COMPONENT, 2, SCHEMA_V2, nowMs)
        // Slice B MEASURE-ONLY: bump to v3 to add nullable `sampled_confidence`.
        applyMigration(db, CALIBRATION_COMPONENT, 3, SCHEMA_V3, nowMs)

        // §3.4 #4 LIFO: register db.close finalizer FIRST.
        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // Prepared statements.
        const insertStmt = db.query(`
          INSERT OR IGNORE INTO calibration_log
            (id, dream_id, belief_id, proposal_at, confidence, detectability, sample_count, tier, sampled_confidence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        const rowToCal = (r: Record<string, unknown>): CalibrationRow => ({
          id: r.id as string,
          dreamId: r.dream_id as string,
          // targetId is NOT a column; it is recoverable from id (cal-<dreamId>-<targetId>)
          // but we only need it on the input path, so reconstruct deterministically.
          targetId: String(r.id).slice(`cal-${r.dream_id}-`.length),
          beliefId: r.belief_id as string,
          proposalAt: r.proposal_at as number,
          confidence: r.confidence as number,
          detectability: r.detectability as number,
          sampleCount: r.sample_count as number,
          // MEASURE-ONLY: null on old (v1) rows; never read back into behavior.
          tier: ((r.tier as number | null) ?? null) as Tier | null,
          // Slice B MEASURE-ONLY: null on old (v1/v2) rows; never read back.
          sampledConfidence: (r.sampled_confidence as number | null) ?? null,
        })

        const wrap = <A>(op: string, f: () => A) =>
          Effect.try({
            try: f,
            catch: (cause) =>
              new CalibrationError({ op, message: `sqlite ${op} failed: ${String(cause)}`, cause }),
          })

        const record: CalibrationStoreApi["record"] = (input) =>
          wrap("record", () => {
            const id = deriveCalId(input)
            insertStmt.run(
              id,
              input.dreamId,
              input.beliefId,
              input.proposalAt,
              input.confidence,
              input.detectability,
              input.sampleCount,
              // MEASURE-ONLY tier (write-only); null when the caller omits it.
              input.tier ?? null,
              // Slice B MEASURE-ONLY sampled_confidence (write-only); null when omitted.
              input.sampledConfidence ?? null,
            )
            return id
          })

        const list: CalibrationStoreApi["list"] = () =>
          wrap("list", () => {
            const stmt = db.query(`SELECT * FROM calibration_log ORDER BY proposal_at ASC`)
            return (stmt.all() as Array<Record<string, unknown>>).map(rowToCal)
          })

        return { record, list } satisfies CalibrationStoreApi
      }),
    )
  }
}

// ── Pure: temporal verdict join (NOT equijoin on `at`) ───────────────────────

/**
 * Temporal join. Per beliefId, for each `via==='survey'` verdict:
 *   - candidate calibration rows = those with same beliefId AND
 *     proposal_at < verdict.at;
 *   - the match is the LATEST such (max proposal_at < verdict.at). Earlier
 *     proposals are unmatched; a re-proposal with proposal_at > verdict.at is
 *     never a candidate (must not steal the verdict).
 *   - `via!=='survey'` verdicts are IGNORED (no JoinedRecord).
 *   - outcome map: confirmed→1, corrected→0, rejected→0.
 *
 * Iterates verdicts (one JoinedRecord per matched survey verdict), matches 1:1.
 */
export const joinVerdicts = (
  calibrationRows: ReadonlyArray<CalibrationRowInput | CalibrationRow>,
  verdicts: ReadonlyArray<JoinVerdictInput>,
): ReadonlyArray<JoinedRecord> => {
  const out: JoinedRecord[] = []
  for (const v of verdicts) {
    if (v.via !== "survey") continue
    // Candidate rows for this belief whose proposal predates the verdict.
    const candidates = calibrationRows.filter(
      (r) => r.beliefId === v.beliefId && r.proposalAt < v.at,
    )
    if (candidates.length === 0) continue
    // LATEST proposal before the verdict.
    const match = candidates.reduce((best, r) =>
      r.proposalAt > best.proposalAt ? r : best,
    )
    const outcome: 0 | 1 = v.verdict === "confirmed" ? 1 : 0
    out.push({ beliefId: v.beliefId, confidence: match.confidence, outcome })
  }
  return out
}

// ── Pure: Expected Calibration Error (MEASURE-ONLY; never gates, never throws) ─

/** Bin count for ECE. M=10 equal-width bins over [0,1]. */
const ECE_BINS = 10

/** Insufficient-data sentinel threshold: fewer than this → null. */
const ECE_MIN_RECORDS = 30

/**
 * Expected Calibration Error over {confidence, outcome} records.
 *
 * - records.length < 30 → null (not-enough-data sentinel; NEVER throws). [] → null.
 * - records.length >= 30 → a number in [0,1]; NEVER throws, NEVER gates.
 *
 * Standard ECE: sum over M equal-width bins of (|bin|/N) * |avg_conf − accuracy|.
 * The top-bin clamp (Math.min(M-1, …)) makes confidence 1.0 land in the last
 * bin so perfect calibration yields ECE 0.
 */
export const calculateEce = (
  records: ReadonlyArray<{ readonly confidence: number; readonly outcome: 0 | 1 }>,
): number | null => {
  const n = records.length
  if (n < ECE_MIN_RECORDS) return null

  const sums = new Array<number>(ECE_BINS).fill(0) // Σ confidence per bin
  const accs = new Array<number>(ECE_BINS).fill(0) // Σ outcome per bin
  const counts = new Array<number>(ECE_BINS).fill(0) // |bin|

  for (const r of records) {
    // Clamp confidence into [0,1], then bin; top clamp keeps conf=1.0 in last bin.
    const c = r.confidence < 0 ? 0 : r.confidence > 1 ? 1 : r.confidence
    const bin = Math.min(ECE_BINS - 1, Math.floor(c * ECE_BINS))
    sums[bin]! += c
    accs[bin]! += r.outcome
    counts[bin]! += 1
  }

  let ece = 0
  for (let b = 0; b < ECE_BINS; b++) {
    const k = counts[b]!
    if (k === 0) continue
    const avgConf = sums[b]! / k
    const accuracy = accs[b]! / k
    ece += (k / n) * Math.abs(avgConf - accuracy)
  }
  return ece
}
