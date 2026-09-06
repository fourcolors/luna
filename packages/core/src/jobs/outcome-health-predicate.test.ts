/**
 * Unit tests for outcome-health predicates (ADR 0001 Phase 2).
 * Tests each built-in predicate with happy path + fault injection,
 * plus the unknown-predicate validation failure path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  evalPredicate,
  extractHealthPayload,
  registerPredicate,
  type HealthPayload,
} from "./outcome-health-predicate.js"

// ── extractHealthPayload ────────────────────────────────────────────────────

describe("extractHealthPayload", () => {
  it("returns null for non-object payloads", () => {
    expect(extractHealthPayload(null)).toBeNull()
    expect(extractHealthPayload(undefined)).toBeNull()
    expect(extractHealthPayload("string")).toBeNull()
    expect(extractHealthPayload(42)).toBeNull()
  })

  it("returns null when health key is absent", () => {
    expect(extractHealthPayload({ label: "foo" })).toBeNull()
  })

  it("returns null when health is not an object", () => {
    expect(extractHealthPayload({ health: "string" })).toBeNull()
    expect(extractHealthPayload({ health: null })).toBeNull()
    expect(extractHealthPayload({ health: 42 })).toBeNull()
  })

  it("returns null when health.predicate is not a string", () => {
    expect(extractHealthPayload({ health: { predicate: 42 } })).toBeNull()
    expect(extractHealthPayload({ health: {} })).toBeNull()
  })

  it("returns the health object when valid", () => {
    const health = { predicate: "file_mtime_age", path: "/tmp/x", maxAgeDays: 1 }
    const result = extractHealthPayload({ label: "test", health })
    expect(result).toEqual(health)
  })
})

// ── unknown predicate ───────────────────────────────────────────────────────

describe("evalPredicate — unknown predicate", () => {
  it("returns ok=false with kind='unknown_predicate'", async () => {
    const health: HealthPayload = { predicate: "nonexistent_predicate_xyz" }
    const outcome = await evalPredicate(health)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("unknown_predicate")
      expect(outcome.error.message).toMatch("nonexistent_predicate_xyz")
    }
  })
})

// ── file_mtime_age ──────────────────────────────────────────────────────────
// vi.spyOn cannot replace ES module namespace bindings in vitest/Node.
// We test file_mtime_age with real filesystem operations instead.

import { writeFileSync, mkdirSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("file_mtime_age", () => {
  const tmp = join(tmpdir(), "outcome-health-test")
  beforeEach(() => {
    try { mkdirSync(tmp) } catch { /* already exists */ }
  })

  it("returns fresh when mtime is recent enough (within maxAgeDays)", async () => {
    const p = join(tmp, "fresh.txt")
    writeFileSync(p, "data")
    // mtime is just now — well within 1 day
    const health: HealthPayload = {
      predicate: "file_mtime_age",
      path: p,
      maxAgeDays: 1,
    }
    const outcome = await evalPredicate(health)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.state).toBe("fresh")
    }
  })

  it("returns stale when file mtime is older than maxAgeDays", async () => {
    const p = join(tmp, "stale.txt")
    writeFileSync(p, "data")
    // Back-date mtime by 3 days
    const atime = new Date(Date.now() - 3 * 86_400_000)
    utimesSync(p, atime, atime)
    const health: HealthPayload = {
      predicate: "file_mtime_age",
      path: p,
      maxAgeDays: 1,
    }
    const outcome = await evalPredicate(health)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.state).toBe("stale")
    }
  })

  it("returns ok=false with eval_error when file does not exist", async () => {
    const health: HealthPayload = {
      predicate: "file_mtime_age",
      path: join(tmp, "does-not-exist-xyz.txt"),
      maxAgeDays: 1,
    }
    const outcome = await evalPredicate(health)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("eval_error")
    }
  })

  it("returns ok=false when params are missing", async () => {
    const health: HealthPayload = { predicate: "file_mtime_age" }
    const outcome = await evalPredicate(health)
    expect(outcome.ok).toBe(false)
  })
})

// ── http_ok ─────────────────────────────────────────────────────────────────
// vi.stubGlobal is not available under bun:test's vitest-compat shim.
// Instead, follow the same pattern as packages/core/test/embedder/ollama.test.ts:
// save the real fetch at module level, swap via Object.defineProperty in
// beforeEach, and restore in afterEach so a failing test never leaves fetch
// stubbed for subsequent test files.

const _originalFetch = globalThis.fetch

const _setFetch = (impl: typeof globalThis.fetch) => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: impl,
  })
}

const _restoreFetch = () => {
  if (_originalFetch === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { fetch?: typeof globalThis.fetch }).fetch
  } else {
    _setFetch(_originalFetch)
  }
}

describe("http_ok", () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    mockFetch.mockReset()
    _setFetch(mockFetch as unknown as typeof globalThis.fetch)
  })

  afterEach(() => {
    _restoreFetch()
  })

  it("returns fresh when fetch responds 200", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 })

    const health: HealthPayload = {
      predicate: "http_ok",
      url: "https://example.com/health",
      timeoutMs: 3000,
    }
    const outcome = await evalPredicate(health)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.state).toBe("fresh")
    }
  })

  it("returns stale when fetch responds 500", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 })

    const health: HealthPayload = {
      predicate: "http_ok",
      url: "https://example.com/health",
      timeoutMs: 3000,
    }
    const outcome = await evalPredicate(health)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.state).toBe("stale")
      expect(outcome.result.detail).toMatch("500")
    }
  })

  it("returns ok=false (eval_error) when fetch throws (network error)", async () => {
    mockFetch.mockRejectedValue(new Error("network failure"))

    const health: HealthPayload = {
      predicate: "http_ok",
      url: "https://example.com/health",
      timeoutMs: 3000,
    }
    const outcome = await evalPredicate(health)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("eval_error")
    }
  })

  it("returns ok=false when url param is missing", async () => {
    const health: HealthPayload = { predicate: "http_ok" }
    const outcome = await evalPredicate(health)
    expect(outcome.ok).toBe(false)
  })
})

// ── registerPredicate ────────────────────────────────────────────────────────

describe("registerPredicate", () => {
  afterEach(() => {
    // No teardown needed since registry module is shared; custom entries
    // are additive and won't pollute built-ins.
  })

  it("allows registering and calling a custom predicate", async () => {
    registerPredicate("custom_always_fresh", async () => ({ state: "fresh" as const }))

    const health: HealthPayload = { predicate: "custom_always_fresh" }
    const outcome = await evalPredicate(health)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.state).toBe("fresh")
    }
  })

  it("allows registering a predicate that returns stale with detail", async () => {
    registerPredicate("custom_always_stale", async () => ({
      state: "stale" as const,
      detail: "always stale for testing",
    }))

    const health: HealthPayload = { predicate: "custom_always_stale" }
    const outcome = await evalPredicate(health)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.state).toBe("stale")
      expect(outcome.result.detail).toBe("always stale for testing")
    }
  })
})
