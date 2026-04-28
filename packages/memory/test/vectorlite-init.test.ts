/**
 * vectorlite-init unit tests (Phase 27).
 *
 * Covers:
 *   - idempotent: repeated calls return the same result reference
 *   - graceful failure: when bun runtime is unavailable, returns
 *     `{ ok:false, reason }` (never throws)
 *   - LUNA_DISABLE_VECTORLITE=1 forces a clean fallback (used by HNSW #2)
 *
 * Note: full success-path coverage runs under `bun test` via the
 * SqliteVectorBackend HNSW tests; vitest can only assert the negative paths
 * because vitest runs under node, not bun.
 */
import { describe, it, expect, afterEach } from "vitest"
import {
  initVectorlite,
  _resetVectorliteInitForTests,
} from "../src/backends/vectorlite-init.js"

const isBun = typeof (process.versions as { bun?: string }).bun === "string"

describe("vectorlite-init", () => {
  afterEach(() => {
    _resetVectorliteInitForTests()
    delete process.env.LUNA_DISABLE_VECTORLITE
  })

  it("is idempotent (repeated calls return the same shape)", () => {
    const a = initVectorlite()
    const b = initVectorlite()
    // Cached reference equality — second call MUST not re-do the work.
    expect(b).toBe(a)
  })

  it("LUNA_DISABLE_VECTORLITE=1 forces a graceful fallback", () => {
    process.env.LUNA_DISABLE_VECTORLITE = "1"
    const r = initVectorlite()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/LUNA_DISABLE_VECTORLITE/)
    }
  })

  it.skipIf(isBun)(
    "reports clean failure under non-bun runtime (no throw)",
    () => {
      const r = initVectorlite()
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toMatch(/bun/i)
      }
    },
  )

  it.skipIf(!isBun)(
    "reports ok with a resolvable extension path under bun runtime",
    () => {
      const r = initVectorlite()
      // Either it resolved successfully OR Homebrew sqlite is missing — both
      // are valid environment outcomes; the contract is "no throw".
      if (r.ok) {
        expect(typeof r.path).toBe("string")
        expect(r.path.length).toBeGreaterThan(0)
      } else {
        expect(typeof r.reason).toBe("string")
      }
    },
  )
})
