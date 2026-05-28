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
        `${r.dreamId} ${r.targetId} ${r.op}`

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
