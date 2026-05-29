/**
 * Pure unit tests for `formatStatus` — the `luna memory status` renderer.
 *
 * These run under the normal (vitest) runner: no `bun:sqlite` / vectorlite
 * dependency, so they execute in CI on every push (unlike the vectorlite
 * integration tests, which only run under `bun test`). They guard the HNSW
 * line against the dimension-scope false-"empty/stale" regression.
 */
import { describe, expect, it } from "vitest"
import { formatStatus } from "../src/memory.js"

type Status = Parameters<typeof formatStatus>[0]

function makeStatus(over: {
  readonly activeDimension: number
  readonly totalVectors: number
  readonly hnswDimension: number
  readonly compatible: boolean
  readonly indexedCount: number | null
  readonly groups: ReadonlyArray<{ dimension: number; count: number }>
}): Status {
  return {
    active: {
      provider: "stub",
      model: "stub",
      dimension: over.activeDimension,
      embeddingFormat: "memory-note-v1",
    },
    totalVectors: over.totalVectors,
    staleVectors: 0,
    hnsw: {
      present: true,
      dimension: over.hnswDimension,
      compatible: over.compatible,
      indexedCount: over.indexedCount,
    },
    groups: over.groups.map((g) => ({
      count: g.count,
      dimension: g.dimension,
      embeddingProvider: "stub",
      embeddingModel: "stub",
      embeddingFormat: "memory-note-v1",
      compatible: g.dimension === over.activeDimension,
    })),
    rows: [],
  } as Status
}

function hnswLine(out: string): string {
  return out.split("\n").find((l) => l.startsWith("HNSW:"))!
}

describe("formatStatus HNSW line", () => {
  it("uses the active-dimension count as the denominator, not totalVectors", () => {
    // 2 active-dim (64) rows, both indexed; 1 leftover 128-dim row pending
    // reembed. The 128-dim row physically cannot live in a float32[64]
    // v-table, so the index is COMPLETE at 2/2 — it must not render 2/3 nor
    // flag the index as empty/stale.
    const line = hnswLine(
      formatStatus(
        makeStatus({
          activeDimension: 64,
          totalVectors: 3,
          hnswDimension: 64,
          compatible: true,
          indexedCount: 2,
          groups: [
            { dimension: 64, count: 2 },
            { dimension: 128, count: 1 },
          ],
        }),
        "/tmp/memory.db",
      ),
    )
    expect(line).toContain("indexed=2/2")
    expect(line).not.toContain("/3")
    expect(line).not.toContain("empty/stale")
  })

  it("renders the full count for a single-dimension store", () => {
    const line = hnswLine(
      formatStatus(
        makeStatus({
          activeDimension: 64,
          totalVectors: 3,
          hnswDimension: 64,
          compatible: true,
          indexedCount: 3,
          groups: [{ dimension: 64, count: 3 }],
        }),
        "/tmp/memory.db",
      ),
    )
    expect(line).toContain("indexed=3/3")
    expect(line).not.toContain("empty/stale")
  })

  it("renders 'unknown' when the index could not be probed (compatible but null)", () => {
    // Reachable when the rebuild probe throws — extension missing, capacity
    // exceeded, or a busy DB after the busy_timeout.
    const line = hnswLine(
      formatStatus(
        makeStatus({
          activeDimension: 64,
          totalVectors: 2,
          hnswDimension: 64,
          compatible: true,
          indexedCount: null,
          groups: [{ dimension: 64, count: 2 }],
        }),
        "/tmp/memory.db",
      ),
    )
    expect(line).toContain("indexed=unknown")
  })

  it("renders 'unknown' on a dimension mismatch", () => {
    const line = hnswLine(
      formatStatus(
        makeStatus({
          activeDimension: 64,
          totalVectors: 1,
          hnswDimension: 128,
          compatible: false,
          indexedCount: null,
          groups: [{ dimension: 128, count: 1 }],
        }),
        "/tmp/memory.db",
      ),
    )
    expect(line).toContain("compatible=no")
    expect(line).toContain("indexed=unknown")
  })
})
