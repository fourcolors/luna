# Alignment Loop — Phase 1: Dream Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Dream engine's deterministic core — an incremental, idempotent batch reasoner that walks recent sessions, proposes change-ops via an injectable reasoner port, auto-applies *only* exact-duplicate memory dedup (with undo), logs every op, and advances a persisted watermark — scheduled nightly by cron.

**Architecture:** A plain Effect program (no `WorkflowRuntime` — its `WorkflowState` is in-memory and can't deliver cross-restart durability). Durability comes from a persisted SQLite **watermark**: a crashed dream re-runs the same window on the next tick. Idempotency is guaranteed by (a) a **deterministic `dreamId` derived from the window bounds**, (b) `dream_audit` rows being `INSERT OR IGNORE` on `UNIQUE(dream_id, target_id, op)`, and (c) memory ops being **idempotent state-sets** (`set X to Y` / delete), never deltas. This makes a cross-store atomic transaction unnecessary — re-running over the same window is a no-op everywhere. The reasoning step is an **injectable port** (`DreamReasoner`) so the whole pipeline is testable with a fake.

**Tech Stack:** Effect-TS v3, Bun, `bun:sqlite` (via `LunaSqliteBootstrap` + `schema-versions` migration ladder), `@luna/memory` router, `@luna/core` `SessionStore` / `TriggerAgent` / `Clock`. Tests: Vitest with Ref-backed `Memory` layers (no Bun) + one Bun-gated SQLite test.

**Source-of-truth spec:** `docs/superpowers/specs/2026-05-28-luna-alignment-loop-design.md` (§3.1, §3.1.1, §5.2, §7 Phase 1).

---

## Spec deltas locked by this plan (refinements made concrete here)

1. **`dream_audit` carries a `status` column** (`applied` | `proposed` | `reverted`) plus `rationale`, `applied_at`. The spec's §5.2 `dream_audit` is this table; "the audit subset" = rows where `status='applied'`. Held (non-auto-applied) ops live in the same table as `status='proposed'` and are what the Phase 3 survey will consume.
2. **Idempotency mechanism** = deterministic `dreamId` + `INSERT OR IGNORE` + idempotent state-set ops, *not* a cross-store atomic transaction (two separate SQLite stores — memory and dream — make a single txn impossible; deterministic re-run achieves the same safety property).
3. **Phase 1 auto-apply set = `{ memory_dedup }` only.** All other op kinds are logged `proposed` and held.

---

## File structure

All new files under `packages/core/src/dream/` (mirrors the `session-history/` module — same db helpers, Clock, finalizer discipline):

- `packages/core/src/dream/types.ts` — `DreamOp`, `DreamOpKind`, `DreamAuditRow`(+`Input`), `DreamAuditQuery`, `DreamInputs`, `DreamReasonerApi`, `DreamError`. One responsibility: data shapes + port interface.
- `packages/core/src/dream/dream-store.ts` — `DreamStore` service: the `dream_audit` op-ledger + `dream_state` watermark. `Memory` (Ref) + `makeLayer(dbPath)` (sqlite) layers.
- `packages/core/src/dream/reasoner.ts` — `DreamReasoner` Tag + `FakeReasoner` (returns injected ops) for tests/wiring.
- `packages/core/src/dream/dream.ts` — `deriveDreamId`, `gatherInputs`, `applyOps`, `revert`, `runDream`, `registerDreamCron`. The orchestration.
- `packages/core/src/dream/index.ts` — barrel exports.

Tests:
- `packages/core/src/dream/dream-store.test.ts` — Memory-layer store behavior (no Bun).
- `packages/core/src/dream/dream.test.ts` — applyOps / revert / gatherInputs / runDream / idempotency (Memory layers, fake reasoner).
- `packages/core/test/dream/sqlite.test.ts` — Bun-gated SQLite store test.

---

## Task 1: DreamStore types + error

**Files:**
- Create: `packages/core/src/dream/types.ts`

- [ ] **Step 1: Write the types file**

```typescript
// packages/core/src/dream/types.ts
import type { Effect } from "effect"
import { Data } from "effect"
import type { MemoryRecord } from "@luna/memory"
import type { SessionSummary } from "../session/types.js"
import type { StoredMessage } from "../messages.js"

/** The change a reasoner proposes. `after` is an idempotent desired end-state. */
export type DreamOpKind =
  | "memory_dedup" // exact-duplicate removal — the ONLY auto-applied kind in Phase 1
  | "memory_staleness" // proposed + held until Phase 3 survey
  | "memory_contradiction" // proposed + held
  | "belief_candidate" // proposed + held (beliefs are Phase 2)

export interface DreamOp {
  readonly kind: DreamOpKind
  /** The memory record id this op concerns. */
  readonly targetId: string
  /** Snapshot of the target before the op (for undo). null when target is new. */
  readonly before: unknown
  /** Idempotent desired end-state. `null` means "delete the target". */
  readonly after: unknown
  /** Why the reasoner proposed this. Stored verbatim for the survey + training. */
  readonly rationale: string
}

export type DreamAuditStatus = "applied" | "proposed" | "reverted"

export interface DreamAuditRow {
  readonly id: string
  readonly dreamId: string
  readonly at: number
  readonly op: DreamOpKind
  readonly targetId: string
  readonly before: unknown
  readonly after: unknown
  readonly rationale: string
  readonly status: DreamAuditStatus
  readonly appliedAt: number | null
  readonly revertedAt: number | null
}

/** Insert shape — `id` is generated; `revertedAt` starts null. */
export interface DreamAuditRowInput {
  readonly dreamId: string
  readonly at: number
  readonly op: DreamOpKind
  readonly targetId: string
  readonly before: unknown
  readonly after: unknown
  readonly rationale: string
  readonly status: DreamAuditStatus
  readonly appliedAt: number | null
}

export interface DreamAuditQuery {
  readonly dreamId?: string
  readonly status?: DreamAuditStatus
  readonly targetId?: string
  readonly limit?: number
}

/** Everything the reasoner reads for one dream cycle. */
export interface DreamInputs {
  readonly sessions: ReadonlyArray<{
    readonly summary: SessionSummary
    readonly messages: ReadonlyArray<StoredMessage>
  }>
  readonly memories: ReadonlyArray<MemoryRecord>
}

export interface DreamReasonerApi {
  readonly reason: (
    inputs: DreamInputs,
  ) => Effect.Effect<ReadonlyArray<DreamOp>, DreamError>
}

export class DreamError extends Data.TaggedError("DreamError")<{
  readonly op: string
  readonly message: string
  readonly cause?: unknown
}> {}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx tsc -b packages/core --pretty false 2>&1 | head -20`
Expected: no errors referencing `dream/types.ts`. (If `@luna/memory` is not yet a dep of `@luna/core`, see Task 2 Step 0.)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/dream/types.ts
git commit -m "feat(dream): op model, audit row, and reasoner port types"
```

---

## Task 2: DreamStore — Memory (Ref) layer

**Files:**
- Create: `packages/core/src/dream/dream-store.ts`
- Test: `packages/core/src/dream/dream-store.test.ts`

- [ ] **Step 0: Ensure `@luna/memory` is a dependency of `@luna/core`**

Run: `cd /Users/fourcolors/Projects/1_active/luna && grep '"@luna/memory"' packages/core/package.json || echo MISSING`
If `MISSING`, add it:

```bash
cd /Users/fourcolors/Projects/1_active/luna
# add "@luna/memory": "workspace:*" to dependencies of packages/core/package.json
```
Edit `packages/core/package.json` dependencies to include `"@luna/memory": "workspace:*"`, then `bun install`.

- [ ] **Step 1: Write the failing test (Memory layer)**

```typescript
// packages/core/src/dream/dream-store.test.ts
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Clock } from "../clock.js"
import { DreamStore } from "./dream-store.js"
import type { DreamAuditRowInput } from "./types.js"

const provide = <A, E>(eff: Effect.Effect<A, E, DreamStore | Clock>) =>
  eff.pipe(Effect.provide(DreamStore.Memory), Effect.provide(Clock.Default))

const baseInput = (over: Partial<DreamAuditRowInput> = {}): DreamAuditRowInput => ({
  dreamId: "dream-0-100",
  at: 50,
  op: "memory_dedup",
  targetId: "mem-1",
  before: { id: "mem-1" },
  after: null,
  rationale: "exact duplicate of mem-2",
  status: "applied",
  appliedAt: 50,
  ...over,
})

describe("DreamStore (Memory)", () => {
  it("records an op and reads it back by id", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* DreamStore
          const id = yield* store.record(baseInput())
          const row = yield* store.get(id)
          return { id, row }
        }),
      ),
    )
    expect(typeof out.id).toBe("string")
    expect(out.row?.op).toBe("memory_dedup")
    expect(out.row?.status).toBe("applied")
    expect(out.row?.revertedAt).toBeNull()
  })

  it("INSERT OR IGNORE: same (dreamId,targetId,op) recorded twice yields one row", async () => {
    const rows = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* DreamStore
          yield* store.record(baseInput())
          yield* store.record(baseInput()) // identical key → ignored
          return yield* store.list({ dreamId: "dream-0-100" })
        }),
      ),
    )
    expect(rows).toHaveLength(1)
  })

  it("filters by status", async () => {
    const rows = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* DreamStore
          yield* store.record(baseInput({ targetId: "a", op: "memory_dedup", status: "applied" }))
          yield* store.record(baseInput({ targetId: "b", op: "memory_staleness", status: "proposed", appliedAt: null }))
          return yield* store.list({ status: "proposed" })
        }),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.targetId).toBe("b")
  })

  it("markReverted flips status and sets revertedAt", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* DreamStore
          const id = yield* store.record(baseInput())
          const ok = yield* store.markReverted(id, 999)
          const row = yield* store.get(id)
          return { ok, row }
        }),
      ),
    )
    expect(out.ok).toBe(true)
    expect(out.row?.status).toBe("reverted")
    expect(out.row?.revertedAt).toBe(999)
  })

  it("watermark round-trips; defaults to null", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* DreamStore
          const before = yield* store.getWatermark
          yield* store.setWatermark(12345)
          const after = yield* store.getWatermark
          return { before, after }
        }),
      ),
    )
    expect(out.before).toBeNull()
    expect(out.after).toBe(12345)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream/dream-store.test.ts`
Expected: FAIL — `Cannot find module './dream-store.js'`.

- [ ] **Step 3: Write the Memory layer**

```typescript
// packages/core/src/dream/dream-store.ts
import { Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import type {
  DreamAuditQuery,
  DreamAuditRow,
  DreamAuditRowInput,
} from "./types.js"
import { DreamError } from "./types.js"

const randomUuid = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `dream-${Math.floor(Math.random() * 1e9)}`

export interface DreamStoreApi {
  readonly record: (input: DreamAuditRowInput) => Effect.Effect<string, DreamError>
  readonly list: (
    q: DreamAuditQuery,
  ) => Effect.Effect<ReadonlyArray<DreamAuditRow>, DreamError>
  readonly get: (id: string) => Effect.Effect<DreamAuditRow | null, DreamError>
  readonly markReverted: (
    id: string,
    at: number,
  ) => Effect.Effect<boolean, DreamError>
  readonly getWatermark: Effect.Effect<number | null, DreamError>
  readonly setWatermark: (ms: number) => Effect.Effect<void, DreamError>
}

export class DreamStore extends Effect.Tag("luna/DreamStore")<
  DreamStore,
  DreamStoreApi
>() {
  /** Ref-backed in-memory layer for tests. No SQLite. */
  static readonly Memory: Layer.Layer<DreamStore, never, Clock> = Layer.effect(
    DreamStore,
    Effect.gen(function* () {
      const rows = yield* Ref.make<ReadonlyArray<DreamAuditRow>>([])
      const watermark = yield* Ref.make<number | null>(null)

      const key = (r: { dreamId: string; targetId: string; op: string }) =>
        `${r.dreamId} ${r.targetId} ${r.op}`

      const record: DreamStoreApi["record"] = (input) =>
        Effect.gen(function* () {
          const existing = yield* Ref.get(rows)
          const dup = existing.find((r) => key(r) === key(input))
          if (dup) return dup.id // INSERT OR IGNORE semantics
          const id = randomUuid()
          const row: DreamAuditRow = {
            id,
            dreamId: input.dreamId,
            at: input.at,
            op: input.op,
            targetId: input.targetId,
            before: input.before,
            after: input.after,
            rationale: input.rationale,
            status: input.status,
            appliedAt: input.appliedAt,
            revertedAt: null,
          }
          yield* Ref.update(rows, (rs) => [...rs, row])
          return id
        })

      const list: DreamStoreApi["list"] = (q) =>
        Ref.get(rows).pipe(
          Effect.map((rs) => {
            let out = rs
            if (q.dreamId !== undefined) out = out.filter((r) => r.dreamId === q.dreamId)
            if (q.status !== undefined) out = out.filter((r) => r.status === q.status)
            if (q.targetId !== undefined) out = out.filter((r) => r.targetId === q.targetId)
            if (q.limit !== undefined) out = out.slice(0, q.limit)
            return out
          }),
        )

      const get: DreamStoreApi["get"] = (id) =>
        Ref.get(rows).pipe(Effect.map((rs) => rs.find((r) => r.id === id) ?? null))

      const markReverted: DreamStoreApi["markReverted"] = (id, at) =>
        Effect.gen(function* () {
          const rs = yield* Ref.get(rows)
          if (!rs.some((r) => r.id === id)) return false
          yield* Ref.set(
            rows,
            rs.map((r) =>
              r.id === id ? { ...r, status: "reverted" as const, revertedAt: at } : r,
            ),
          )
          return true
        })

      const getWatermark: DreamStoreApi["getWatermark"] = Ref.get(watermark)
      const setWatermark: DreamStoreApi["setWatermark"] = (ms) =>
        Ref.set(watermark, ms)

      return {
        record,
        list,
        get,
        markReverted,
        getWatermark,
        setWatermark,
      } satisfies DreamStoreApi
    }),
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream/dream-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dream/dream-store.ts packages/core/src/dream/dream-store.test.ts packages/core/package.json
git commit -m "feat(dream): DreamStore Memory layer (op-ledger + watermark)"
```

---

## Task 3: DreamStore — SQLite layer

**Files:**
- Modify: `packages/core/src/dream/dream-store.ts` (add `makeLayer`)
- Test: `packages/core/test/dream/sqlite.test.ts`

- [ ] **Step 1: Write the failing Bun-gated SQLite test**

```typescript
// packages/core/test/dream/sqlite.test.ts
import { describe, expect, it } from "vitest"
import { Effect, Layer, Scope } from "effect"
import { Clock } from "../../src/clock.js"
import { LunaSqliteBootstrap } from "../../src/db/sqlite-bootstrap.js"
import { DreamStore } from "../../src/dream/dream-store.js"
import type { DreamAuditRowInput } from "../../src/dream/types.js"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const d = isBun ? describe : describe.skip

const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "core test — bootstrap stub",
} as const)

const makeFullLayer = (dbPath: string) => {
  const clockL = Clock.Default
  const storeL = DreamStore.makeLayer(dbPath).pipe(
    Layer.provide(clockL),
    Layer.provide(bootstrapStubL),
  )
  return Layer.mergeAll(storeL, clockL)
}

const run = <A, E>(
  prog: Effect.Effect<A, E, DreamStore | Clock | Scope.Scope>,
  dbPath = ":memory:",
) =>
  Effect.runPromise(
    Effect.scoped(prog).pipe(Effect.provide(makeFullLayer(dbPath))) as Effect.Effect<A, E, never>,
  )

const input = (over: Partial<DreamAuditRowInput> = {}): DreamAuditRowInput => ({
  dreamId: "dream-0-100",
  at: 50,
  op: "memory_dedup",
  targetId: "mem-1",
  before: { id: "mem-1" },
  after: null,
  rationale: "dup",
  status: "applied",
  appliedAt: 50,
  ...over,
})

d("DreamStore (sqlite)", () => {
  it("records, reads back, and round-trips before/after JSON", async () => {
    const row = await run(
      Effect.gen(function* () {
        const store = yield* DreamStore
        const id = yield* store.record(input({ before: { a: 1 }, after: null }))
        return yield* store.get(id)
      }),
    )
    expect(row?.op).toBe("memory_dedup")
    expect(row?.before).toEqual({ a: 1 })
    expect(row?.after).toBeNull()
  })

  it("INSERT OR IGNORE on (dream_id,target_id,op)", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const store = yield* DreamStore
        yield* store.record(input())
        yield* store.record(input())
        return yield* store.list({ dreamId: "dream-0-100" })
      }),
    )
    expect(rows).toHaveLength(1)
  })

  it("markReverted + watermark persist", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* DreamStore
        const id = yield* store.record(input())
        const ok = yield* store.markReverted(id, 999)
        yield* store.setWatermark(777)
        return { ok, row: yield* store.get(id), wm: yield* store.getWatermark }
      }),
    )
    expect(out.ok).toBe(true)
    expect(out.row?.status).toBe("reverted")
    expect(out.wm).toBe(777)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun test packages/core/test/dream/sqlite.test.ts 2>&1 | tail -20`
(Run with `bun` so `bun:sqlite` exists.) Expected: FAIL — `DreamStore.makeLayer is not a function`.

- [ ] **Step 3: Add `makeLayer` to dream-store.ts**

Add these imports at the top of `packages/core/src/dream/dream-store.ts`:

```typescript
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"

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

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS dream_audit (
    id           TEXT NOT NULL PRIMARY KEY,
    dream_id     TEXT NOT NULL,
    at           INTEGER NOT NULL,
    op           TEXT NOT NULL,
    target_id    TEXT NOT NULL,
    before_json  TEXT,
    after_json   TEXT,
    rationale    TEXT NOT NULL,
    status       TEXT NOT NULL CHECK(status IN ('applied','proposed','reverted')),
    applied_at   INTEGER,
    reverted_at  INTEGER,
    UNIQUE(dream_id, target_id, op)
  );
  CREATE INDEX IF NOT EXISTS idx_dream_audit_dream ON dream_audit(dream_id);
  CREATE INDEX IF NOT EXISTS idx_dream_audit_target ON dream_audit(target_id);
  CREATE INDEX IF NOT EXISTS idx_dream_audit_status ON dream_audit(status);

  CREATE TABLE IF NOT EXISTS dream_state (
    k TEXT NOT NULL PRIMARY KEY,
    v TEXT NOT NULL
  );
`
```

Then add the `makeLayer` static to the `DreamStore` class (after `Memory`):

```typescript
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<DreamStore, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.scoped(
      DreamStore,
      Effect.gen(function* () {
        yield* LunaSqliteBootstrap
        const clock = yield* Clock

        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "dream-store",
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
              module: "dream-store",
              key: "bun:sqlite",
              message: "bun:sqlite module has no `Database` export",
            }),
          )
        }

        const db = new Database(dbPath)
        db.run("PRAGMA journal_mode = WAL")
        db.run("PRAGMA synchronous = NORMAL")
        db.run("PRAGMA foreign_keys = ON")

        const nowMs = yield* clock.nowMs()
        ensureSchemaVersions(db)
        applyMigration(db, "dream", 1, SCHEMA_V1, nowMs)

        // LIFO: register close finalizer FIRST.
        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        const insertStmt = db.query(`
          INSERT OR IGNORE INTO dream_audit
            (id, dream_id, at, op, target_id, before_json, after_json,
             rationale, status, applied_at, reverted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `)
        const selectById = db.query(`SELECT * FROM dream_audit WHERE id = ?`)
        const selectKey = db.query(
          `SELECT id FROM dream_audit WHERE dream_id = ? AND target_id = ? AND op = ?`,
        )
        const revertStmt = db.query(
          `UPDATE dream_audit SET status = 'reverted', reverted_at = ? WHERE id = ?`,
        )
        const getWmStmt = db.query(`SELECT v FROM dream_state WHERE k = 'last_dream_at'`)
        const setWmStmt = db.query(
          `INSERT INTO dream_state (k, v) VALUES ('last_dream_at', ?)
           ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
        )

        const rowToAudit = (r: Record<string, unknown>): DreamAuditRow => ({
          id: r.id as string,
          dreamId: r.dream_id as string,
          at: r.at as number,
          op: r.op as DreamAuditRow["op"],
          targetId: r.target_id as string,
          before: r.before_json == null ? null : JSON.parse(r.before_json as string),
          after: r.after_json == null ? null : JSON.parse(r.after_json as string),
          rationale: r.rationale as string,
          status: r.status as DreamAuditRow["status"],
          appliedAt: (r.applied_at as number | null) ?? null,
          revertedAt: (r.reverted_at as number | null) ?? null,
        })

        const wrap = <A>(op: string, f: () => A) =>
          Effect.try({
            try: f,
            catch: (cause) =>
              new DreamError({ op, message: `sqlite ${op} failed: ${String(cause)}`, cause }),
          })

        const record: DreamStoreApi["record"] = (input) =>
          wrap("record", () => {
            insertStmt.run(
              randomUuid(),
              input.dreamId,
              input.at,
              input.op,
              input.targetId,
              input.before == null ? null : JSON.stringify(input.before),
              input.after == null ? null : JSON.stringify(input.after),
              input.rationale,
              input.status,
              input.appliedAt,
            )
            // Whether inserted or ignored, return the canonical row id.
            const row = selectKey.get(input.dreamId, input.targetId, input.op) as
              | { id: string }
              | undefined
            return row?.id ?? ""
          })

        const list: DreamStoreApi["list"] = (q) =>
          wrap("list", () => {
            const clauses: string[] = []
            const params: unknown[] = []
            if (q.dreamId !== undefined) { clauses.push("dream_id = ?"); params.push(q.dreamId) }
            if (q.status !== undefined) { clauses.push("status = ?"); params.push(q.status) }
            if (q.targetId !== undefined) { clauses.push("target_id = ?"); params.push(q.targetId) }
            const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
            const limit = q.limit !== undefined ? `LIMIT ${Number(q.limit)}` : ""
            const stmt = db.query(`SELECT * FROM dream_audit ${where} ORDER BY at ASC ${limit}`)
            return (stmt.all(...params) as Array<Record<string, unknown>>).map(rowToAudit)
          })

        const get: DreamStoreApi["get"] = (id) =>
          wrap("get", () => {
            const r = selectById.get(id) as Record<string, unknown> | undefined
            return r ? rowToAudit(r) : null
          })

        const markReverted: DreamStoreApi["markReverted"] = (id, at) =>
          wrap("markReverted", () => revertStmt.run(at, id).changes > 0)

        const getWatermark: DreamStoreApi["getWatermark"] = wrap("getWatermark", () => {
          const r = getWmStmt.get() as { v: string } | undefined
          return r ? Number(r.v) : null
        })

        const setWatermark: DreamStoreApi["setWatermark"] = (ms) =>
          wrap("setWatermark", () => { setWmStmt.run(String(ms)) }).pipe(Effect.asVoid)

        return { record, list, get, markReverted, getWatermark, setWatermark } satisfies DreamStoreApi
      }),
    )
  }
```

Add `DreamAuditRow` to the type import at the top: `import type { DreamAuditQuery, DreamAuditRow, DreamAuditRowInput } from "./types.js"` and import the error value: `import { DreamError } from "./types.js"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bun test packages/core/test/dream/sqlite.test.ts 2>&1 | tail -20`
Expected: PASS (3 tests). Also re-run the Memory test to confirm no regression: `bunx vitest run packages/core/src/dream/dream-store.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dream/dream-store.ts packages/core/test/dream/sqlite.test.ts
git commit -m "feat(dream): DreamStore sqlite layer (dream_audit + dream_state, INSERT OR IGNORE)"
```

---

## Task 4: DreamReasoner port + FakeReasoner

**Files:**
- Create: `packages/core/src/dream/reasoner.ts`
- Test: covered in Task 6 (`dream.test.ts`); a focused test here.
- Test: `packages/core/src/dream/reasoner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/dream/reasoner.test.ts
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { DreamReasoner, FakeReasoner } from "./reasoner.js"
import type { DreamOp } from "./types.js"

describe("FakeReasoner", () => {
  it("returns the injected ops verbatim", async () => {
    const ops: DreamOp[] = [
      { kind: "memory_dedup", targetId: "m1", before: { id: "m1" }, after: null, rationale: "dup" },
    ]
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const r = yield* DreamReasoner
        return yield* r.reason({ sessions: [], memories: [] })
      }).pipe(Effect.provide(FakeReasoner.of(ops))),
    )
    expect(out).toEqual(ops)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream/reasoner.test.ts`
Expected: FAIL — `Cannot find module './reasoner.js'`.

- [ ] **Step 3: Write the reasoner port + fake**

```typescript
// packages/core/src/dream/reasoner.ts
import { Effect, Layer } from "effect"
import type { DreamOp, DreamReasonerApi } from "./types.js"

export class DreamReasoner extends Effect.Tag("luna/DreamReasoner")<
  DreamReasoner,
  DreamReasonerApi
>() {}

/** Test/wiring double — returns a fixed op list, ignoring inputs. */
export const FakeReasoner = {
  of: (ops: ReadonlyArray<DreamOp>): Layer.Layer<DreamReasoner> =>
    Layer.succeed(DreamReasoner, { reason: () => Effect.succeed(ops) }),
} as const
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream/reasoner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dream/reasoner.ts packages/core/src/dream/reasoner.test.ts
git commit -m "feat(dream): DreamReasoner port + FakeReasoner double"
```

---

## Task 5: applyOps — auto-apply dedup, hold the rest

**Files:**
- Create: `packages/core/src/dream/dream.ts`
- Test: `packages/core/src/dream/dream.test.ts`

`applyOps` is the safety-critical function. Auto-apply set = `{ memory_dedup }`. A dedup op's `after === null` means "delete the duplicate record". Everything else is recorded `proposed` and NOT applied to memory.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/dream/dream.test.ts
import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { DreamStore } from "./dream-store.js"
import { applyOps } from "./dream.js"
import type { DreamOp } from "./types.js"

// Minimal Ref-backed memory router double (only the methods applyOps uses).
const FakeMemory = (initial: ReadonlyArray<MemoryRecord> = []) =>
  Layer.effect(
    MemoryRouterTag,
    Effect.gen(function* () {
      const store = yield* Ref.make<Map<string, MemoryRecord>>(
        new Map(initial.map((r) => [r.id, r])),
      )
      return {
        put: (rec: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(rec.id, rec)),
        get: (id: string) => Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
        delete: (id: string) =>
          Ref.modify(store, (m) => {
            const had = m.has(id)
            const next = new Map(m)
            next.delete(id)
            return [had, next]
          }),
        // unused by applyOps — provide inert stubs
        query: () => { throw new Error("unused") },
        search: () => { throw new Error("unused") },
      } as never
    }),
  )

const rec = (id: string): MemoryRecord => ({
  id, namespace: "operator", kind: "note", content: { id },
  schemaVersion: 1, createdAt: 0, updatedAt: 0, tags: [],
})

const provide = <A, E>(eff: Effect.Effect<A, E, any>, mem = FakeMemory([rec("dup-1")])) =>
  eff.pipe(Effect.provide(DreamStore.Memory), Effect.provide(mem), Effect.provide(Clock.Default))

describe("applyOps", () => {
  it("auto-applies memory_dedup (deletes the duplicate) and logs it 'applied'", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const mem = yield* MemoryRouterTag
          const store = yield* DreamStore
          const ops: DreamOp[] = [
            { kind: "memory_dedup", targetId: "dup-1", before: rec("dup-1"), after: null, rationale: "exact dup of canon-1" },
          ]
          yield* applyOps("dream-0-100", ops)
          const stillThere = yield* mem.get("dup-1")
          const rows = yield* store.list({ dreamId: "dream-0-100" })
          return { stillThere, rows }
        }),
      ),
    )
    expect(out.stillThere).toBeNull() // deleted
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]?.status).toBe("applied")
    expect(out.rows[0]?.appliedAt).not.toBeNull()
  })

  it("does NOT apply non-dedup ops; logs them 'proposed' and leaves memory untouched", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const mem = yield* MemoryRouterTag
          const store = yield* DreamStore
          const ops: DreamOp[] = [
            { kind: "memory_staleness", targetId: "dup-1", before: rec("dup-1"), after: { ...rec("dup-1"), content: { updated: true } }, rationale: "stale" },
            { kind: "belief_candidate", targetId: "new-belief", before: null, after: { statement: "x" }, rationale: "pattern" },
          ]
          yield* applyOps("dream-0-100", ops)
          const untouched = yield* mem.get("dup-1")
          const rows = yield* store.list({ dreamId: "dream-0-100" })
          return { untouched, rows }
        }),
      ),
    )
    expect(out.untouched).not.toBeNull() // staleness was NOT applied
    expect(out.rows).toHaveLength(2)
    expect(out.rows.every((r) => r.status === "proposed")).toBe(true)
    expect(out.rows.every((r) => r.appliedAt === null)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream/dream.test.ts`
Expected: FAIL — `Cannot find module './dream.js'` (or `applyOps is not exported`).

- [ ] **Step 3: Write applyOps in dream.ts**

```typescript
// packages/core/src/dream/dream.ts
import { Effect } from "effect"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { Clock } from "../clock.js"
import { DreamStore } from "./dream-store.js"
import type { DreamOp, DreamOpKind } from "./types.js"

/** Phase 1: the ONLY op kind safe to auto-apply without survey/undo coverage. */
const AUTO_APPLY: ReadonlySet<DreamOpKind> = new Set<DreamOpKind>(["memory_dedup"])

/**
 * Apply a reasoner's ops. Auto-applies exact-dedup (idempotent state-set);
 * holds everything else as a 'proposed' audit row. Caller advances the
 * watermark AFTER this resolves (see runDream) — re-running over the same
 * window is a no-op because dreamId is deterministic and record() is
 * INSERT OR IGNORE, and memory ops are idempotent.
 */
export const applyOps = (dreamId: string, ops: ReadonlyArray<DreamOp>) =>
  Effect.gen(function* () {
    const store = yield* DreamStore
    const mem = yield* MemoryRouterTag
    const clock = yield* Clock
    const now = yield* clock.nowMs()

    for (const op of ops) {
      if (AUTO_APPLY.has(op.kind)) {
        // Idempotent state-set: null after = delete; else upsert to desired state.
        if (op.after === null) {
          yield* mem.delete(op.targetId)
        } else {
          yield* mem.put(op.after as MemoryRecord)
        }
        yield* store.record({
          dreamId, at: now, op: op.kind, targetId: op.targetId,
          before: op.before, after: op.after, rationale: op.rationale,
          status: "applied", appliedAt: now,
        })
      } else {
        yield* store.record({
          dreamId, at: now, op: op.kind, targetId: op.targetId,
          before: op.before, after: op.after, rationale: op.rationale,
          status: "proposed", appliedAt: null,
        })
      }
    }
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream/dream.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dream/dream.ts packages/core/src/dream/dream.test.ts
git commit -m "feat(dream): applyOps — auto-apply dedup, hold other ops as proposed"
```

---

## Task 6: revert(auditId) — undo an applied op

**Files:**
- Modify: `packages/core/src/dream/dream.ts` (add `revert`)
- Test: `packages/core/src/dream/dream.test.ts` (add cases)

`revert` restores the `before` snapshot to memory and flips the audit row to `reverted`. Only `applied` rows are revertible.

- [ ] **Step 1: Add the failing tests**

Append to `packages/core/src/dream/dream.test.ts`:

```typescript
import { revert } from "./dream.js"

describe("revert", () => {
  it("restores the before snapshot and marks the row reverted", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const mem = yield* MemoryRouterTag
          const store = yield* DreamStore
          // Apply a dedup that deletes dup-1 (before = the record).
          yield* applyOps("dream-0-100", [
            { kind: "memory_dedup", targetId: "dup-1", before: rec("dup-1"), after: null, rationale: "dup" },
          ])
          const rows = yield* store.list({ dreamId: "dream-0-100" })
          const ok = yield* revert(rows[0]!.id)
          const restored = yield* mem.get("dup-1")
          const row = yield* store.get(rows[0]!.id)
          return { ok, restored, row }
        }),
      ),
    )
    expect(out.ok).toBe(true)
    expect(out.restored).not.toBeNull() // before snapshot put back
    expect(out.row?.status).toBe("reverted")
  })

  it("refuses to revert a proposed (never-applied) row", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* DreamStore
          yield* applyOps("dream-0-100", [
            { kind: "memory_staleness", targetId: "dup-1", before: rec("dup-1"), after: rec("dup-1"), rationale: "stale" },
          ])
          const rows = yield* store.list({ dreamId: "dream-0-100" })
          return yield* revert(rows[0]!.id)
        }),
      ),
    )
    expect(out).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream/dream.test.ts`
Expected: FAIL — `revert is not exported`.

- [ ] **Step 3: Add `revert` to dream.ts**

```typescript
/**
 * Undo an applied op: restore the `before` snapshot to memory and mark the
 * audit row reverted. Returns false if the row is missing or not 'applied'.
 */
export const revert = (auditId: string) =>
  Effect.gen(function* () {
    const store = yield* DreamStore
    const mem = yield* MemoryRouterTag
    const clock = yield* Clock
    const row = yield* store.get(auditId)
    if (row === null || row.status !== "applied") return false
    // Reverse the idempotent state-set.
    if (row.before === null) {
      // op had created/kept nothing to restore by id; deletion of `after` target.
      yield* mem.delete(row.targetId)
    } else {
      yield* mem.put(row.before as MemoryRecord)
    }
    const now = yield* clock.nowMs()
    return yield* store.markReverted(auditId, now)
  })
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream/dream.test.ts`
Expected: PASS (4 tests total in file).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dream/dream.ts packages/core/src/dream/dream.test.ts
git commit -m "feat(dream): revert(auditId) — restore before-snapshot, mark reverted"
```

---

## Task 7: gatherInputs + deriveDreamId

**Files:**
- Modify: `packages/core/src/dream/dream.ts` (add `deriveDreamId`, `gatherInputs`)
- Test: `packages/core/src/dream/dream.test.ts` (add cases)

`gatherInputs` reads the window `(watermark, now]`: lists sessions with `lastMessageAt` in range, reads each one's messages, and pulls operator-namespace memories. `deriveDreamId` makes the id a pure function of the window so re-runs collide.

> Note: `SessionStore.list` has no `since` param (see session/types.ts `SessionQuery`). We list with `orderBy: "lastMessageAt"` and filter `lastMessageAt > watermark` in code.

- [ ] **Step 1: Add the failing test**

Append to `dream.test.ts`:

```typescript
import { deriveDreamId, gatherInputs } from "./dream.js"
import { SessionStore } from "../session/session-store.js"

describe("deriveDreamId", () => {
  it("is a pure function of the window bounds", () => {
    expect(deriveDreamId(0, 100)).toBe("dream-0-100")
    expect(deriveDreamId(0, 100)).toBe(deriveDreamId(0, 100))
  })
})
```

(Full `gatherInputs` integration is exercised in Task 8's `runDream` idempotency test, which wires real `SessionStore.Memory`. Keeping `deriveDreamId` as the unit here avoids duplicating SessionStore fixture setup.)

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream/dream.test.ts`
Expected: FAIL — `deriveDreamId is not exported`.

- [ ] **Step 3: Add `deriveDreamId` + `gatherInputs` to dream.ts**

Add imports:

```typescript
import { Stream } from "effect"
import { MemoryRouterTag } from "@luna/memory" // already imported
import { SessionStore } from "../session/session-store.js"
import type { DreamInputs } from "./types.js"
```

Add functions:

```typescript
export const deriveDreamId = (windowStart: number, windowEnd: number): string =>
  `dream-${windowStart}-${windowEnd}`

/**
 * Collect the dream window (watermark, now]: sessions whose lastMessageAt falls
 * in range, their messages, and operator-namespace memories.
 */
export const gatherInputs = (
  watermark: number,
  now: number,
): Effect.Effect<DreamInputs, never, SessionStore | MemoryRouterTag> =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore
    const mem = yield* MemoryRouterTag

    const summaries = yield* sessions
      .list({ orderBy: "lastMessageAt" })
      .pipe(
        Stream.filter(
          (s) => s.lastMessageAt !== null && s.lastMessageAt > watermark && s.lastMessageAt <= now,
        ),
        Stream.runCollect,
        Effect.map((c) => Array.from(c)),
      )

    const withMessages = yield* Effect.forEach(summaries, (summary) =>
      sessions
        .readMessages(summary.id)
        .pipe(
          Stream.runCollect,
          Effect.map((c) => ({ summary, messages: Array.from(c) })),
          Effect.catchAll(() => Effect.succeed({ summary, messages: [] as never[] })),
        ),
    )

    const memories = yield* mem
      .query({ namespace: "operator" })
      .pipe(Stream.runCollect, Effect.map((c) => Array.from(c)))

    return { sessions: withMessages, memories }
  })
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream/dream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dream/dream.ts packages/core/src/dream/dream.test.ts
git commit -m "feat(dream): deriveDreamId + gatherInputs (window walk over SessionStore + memory)"
```

---

## Task 8: runDream orchestration + idempotency

**Files:**
- Modify: `packages/core/src/dream/dream.ts` (add `runDream`)
- Test: `packages/core/src/dream/dream.test.ts` (add the end-to-end idempotency case)

`runDream` = read watermark → `gatherInputs` → `DreamReasoner.reason` → `applyOps` → advance watermark to `now`. Re-running with the same data must be a no-op (deterministic dreamId + INSERT OR IGNORE + idempotent ops).

- [ ] **Step 1: Add the failing end-to-end test**

Append to `dream.test.ts`:

```typescript
import { runDream } from "./dream.js"
import { FakeReasoner } from "./reasoner.js"

// This test uses an EMPTY SessionStore on purpose: the FakeReasoner ignores
// inputs and returns a fixed dedup op, so the assertion is about the
// apply + watermark + idempotency wiring, not about session content. (Seeding
// real sessions is exercised against the real reasoner in its own follow-on.)

describe("runDream (end-to-end, idempotent)", () => {
  it("applies dedup once; a second run over the same window is a no-op", async () => {
    const ops = [
      { kind: "memory_dedup" as const, targetId: "dup-1", before: rec("dup-1"), after: null, rationale: "dup" },
    ]
    const layers = Layer.mergeAll(
      DreamStore.Memory,
      SessionStore.Default, // in-memory SessionStore
      FakeMemory([rec("dup-1")]),
      FakeReasoner.of(ops),
      Clock.Default,
    )
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DreamStore
        yield* runDream(1000) // now = 1000
        const after1 = yield* store.list({})
        const wm1 = yield* store.getWatermark
        yield* runDream(1000) // same now → same dreamId → no-op
        const after2 = yield* store.list({})
        return { after1, after2, wm1 }
      }).pipe(Effect.provide(layers)) as Effect.Effect<any, any, never>,
    )
    expect(out.after1).toHaveLength(1)
    expect(out.after2).toHaveLength(1) // INSERT OR IGNORE → still one row
    expect(out.wm1).toBe(1000)
  })
})
```

> If `SessionStore.Default` requires dependencies (e.g. Clock), include them in the merged layer. Confirm the in-memory layer name with `grep -n "static readonly Default\|Default =" packages/core/src/session/session-store.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream/dream.test.ts`
Expected: FAIL — `runDream is not exported`.

- [ ] **Step 3: Add `runDream` to dream.ts**

```typescript
import { DreamReasoner } from "./reasoner.js"

/**
 * One dream cycle. `now` is injected (caller/cron supplies the clock reading)
 * so the function is deterministic in tests. Watermark is advanced LAST.
 */
export const runDream = (now: number) =>
  Effect.gen(function* () {
    const store = yield* DreamStore
    const reasoner = yield* DreamReasoner
    const watermark = (yield* store.getWatermark) ?? 0
    const dreamId = deriveDreamId(watermark, now)

    const inputs = yield* gatherInputs(watermark, now)
    const ops = yield* reasoner.reason(inputs)
    yield* applyOps(dreamId, ops)

    // Advance watermark LAST. A crash before this re-runs the same window
    // (same dreamId), which is a no-op thanks to INSERT OR IGNORE + idempotent ops.
    yield* store.setWatermark(now)
  })
```

Update the `Effect` requirements: `runDream` now needs `DreamStore | DreamReasoner | SessionStore | MemoryRouterTag | Clock`. No signature annotation is required (inferred), but ensure all are provided by callers.

- [ ] **Step 4: Run to verify pass**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream/dream.test.ts`
Expected: PASS (all cases). Then full core suite sanity: `bunx vitest run packages/core/src/dream` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dream/dream.ts packages/core/src/dream/dream.test.ts
git commit -m "feat(dream): runDream orchestration with watermark-last idempotency"
```

---

## Task 9: Cron wiring (registerDreamCron) — tested with TestClock

**Files:**
- Modify: `packages/core/src/dream/dream.ts` (add `registerDreamCron`)
- Test: `packages/core/src/dream/dream-cron.test.ts`

Kept as the final, discrete task so the reasoner core (Tasks 1–8) is tested independently of the clock. `registerDreamCron` registers a `TriggerAgent` cron that runs `runDream` with the current clock time.

- [ ] **Step 1: Confirm the TriggerAgent + TestClock pattern**

Run: `cd /Users/fourcolors/Projects/1_active/luna && sed -n '1,60p' packages/core/test/jobs/trigger-agent.test.ts`
Note how the test provides `TriggerAgentLayer.Default` + `JobSchedulerLayer.make(...)` and advances `TestClock`. Mirror it.

- [ ] **Step 2: Write the failing test**

```typescript
// packages/core/src/dream/dream-cron.test.ts
import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref, Stream, TestClock, TestContext } from "effect"
import { Clock } from "../clock.js"
import { JobSchedulerLayer } from "../jobs/job-scheduler.js"
import { TriggerAgent, TriggerAgentLayer } from "../jobs/trigger-agent.js"
import { DreamStore } from "./dream-store.js"
import { FakeReasoner } from "./reasoner.js"
import { SessionStore } from "../session/session-store.js"
import { MemoryRouterTag } from "@luna/memory"
import { registerDreamCron } from "./dream.js"
import type { MemoryRecord } from "@luna/memory"

const FakeMemoryEmpty = Layer.effect(
  MemoryRouterTag,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, MemoryRecord>>(new Map())
    return {
      put: (r: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(r.id, r)),
      get: (id: string) => Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
      delete: (id: string) => Ref.modify(store, (m) => { const had = m.has(id); const n = new Map(m); n.delete(id); return [had, n] }),
      query: () => Stream.empty,
      search: () => Stream.empty,
    } as never
  }),
)

describe("registerDreamCron", () => {
  it("runs a dream on the cron tick (advances the watermark)", async () => {
    const layers = Layer.mergeAll(
      DreamStore.Memory,
      SessionStore.Default,
      FakeMemoryEmpty,
      FakeReasoner.of([]),
      TriggerAgentLayer.Default,
      JobSchedulerLayer.make({ capacity: 4, offerPolicy: "block" }),
      Clock.Default,
    )
    const wm = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const trigger = yield* TriggerAgent
          const store = yield* DreamStore
          yield* registerDreamCron(trigger, "0 1 * * *") // nightly 01:00
          // advance virtual time past the next 01:00 tick
          yield* TestClock.adjust("25 hours")
          yield* Effect.sleep("10 millis")
          return yield* store.getWatermark
        }),
      ).pipe(Effect.provide(layers), Effect.provide(TestContext.TestContext)) as Effect.Effect<number | null, never, never>,
    )
    expect(wm).not.toBeNull()
  })
})
```

> The exact `JobSchedulerLayer.make` option keys (`capacity`, `offerPolicy`) and `TriggerAgentLayer.Default` are confirmed from `packages/core/src/jobs/*`. If `Clock.Default` is wall-clock and ignores `TestClock`, swap to the Effect `Clock` the TriggerAgent uses (it reads `EffectClock.currentTimeMillis`) — provide `TestContext.TestContext` which supplies the test clock. Verify in Step 1's output.

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream/dream-cron.test.ts`
Expected: FAIL — `registerDreamCron is not exported`.

- [ ] **Step 4: Add `registerDreamCron` to dream.ts**

```typescript
import type { TriggerAgentApi } from "../jobs/trigger-agent.js"
import { EffectClock } from "effect/Clock" // if needed; otherwise use Effect.clockWith

/**
 * Register a nightly (or custom cron) dream. Reads the wall/virtual clock at
 * fire time and runs one dream cycle. Returns the TriggerId.
 */
export const registerDreamCron = (trigger: TriggerAgentApi, expr: string) =>
  trigger.register({
    kind: "cron",
    expr,
    build: () => ({
      run: Effect.clockWith((clock) =>
        clock.currentTimeMillis.pipe(Effect.flatMap((now) => runDream(now))),
      ),
    }),
  })
```

> `Effect.clockWith` reads the ambient (test or live) clock, so the cron tick and the dream's `now` share one time source. Drop the unused `EffectClock` import if your editor flags it; the `clockWith` form is self-contained.

- [ ] **Step 5: Run to verify pass**

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream/dream-cron.test.ts`
Expected: PASS.

- [ ] **Step 6: Add barrel exports + final full-suite run**

Create `packages/core/src/dream/index.ts`:

```typescript
export * from "./types.js"
export * from "./dream-store.js"
export * from "./reasoner.js"
export * from "./dream.js"
```

Run: `cd /Users/fourcolors/Projects/1_active/luna && bunx vitest run packages/core/src/dream && bun test packages/core/test/dream`
Expected: ALL PASS. Then typecheck: `bunx tsc -b packages/core --pretty false 2>&1 | head -20` → no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/dream/
git commit -m "feat(dream): nightly cron wiring + barrel exports (Phase 1 complete)"
```

---

## Phase 1 done — what ships

- A scheduled, idempotent, watermark-driven Dream that walks recent sessions and current memories.
- Auto-applies **only** exact-duplicate dedup, with a working `revert(auditId)` undo.
- Logs **every** op to `dream_audit` (`applied` for dedup, `proposed` for the held kinds the Phase 3 survey will consume).
- Reasoner is an injectable port — the real model-backed reasoner is a separate follow-on (it only needs to satisfy `DreamReasonerApi`), so the entire pipeline is already tested end-to-end with a fake.

## Explicitly deferred (NOT in Phase 1)

- **Real model-backed `DreamReasoner`** — own task; implement `reason(inputs)` against `ChatService` (build prompt from `DreamInputs`, parse structured ops out). The deterministic prompt-build + output-parse are TDD-able; the model call is a thin adapter.
- **Observability/telemetry reading** — Phase 3 prerequisite (the service is write-only today; add a JSONL reader or query method).
- **Auto-applying staleness/contradiction/belief ops** — unlocked in Phase 3 once the survey + alignment governor exist.
- **Beliefs (Phase 2), Survey + cadence + alignment_log (Phase 3), Outreach (Phase 4).**
