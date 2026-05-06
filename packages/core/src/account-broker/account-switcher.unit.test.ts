/**
 * Account Switcher — Tier-1 Unit Tests
 *
 * Pure-function tests for `pickAccount` covering all behaviour the
 * account-switcher dropdown relies on. Zero Effect / Zero Layer —
 * no I/O, no Scope, no clock mocking.
 *
 * BDD scenarios (Given / When / Then):
 *
 * S1 — Basic list: given multiple anthropic accounts, pickAccount returns one.
 * S2 — Kind filter: non-anthropic accounts are invisible to acquireSession.
 * S3 — Cooldown exclusion: account in cooldown is skipped.
 * S4 — Cooldown expired: account becomes eligible once nowMs > cooldownUntilMs.
 * S5 — LRU tie-break: when inFlight is equal, least-recently-used wins.
 * S6 — inFlight ordering: lowest inFlight wins regardless of lastUsedMs.
 * S7 — Sticky-pin hit: boundId selects exactly that account.
 * S8 — Sticky-pin blocked by cooldown: bound account in cooldown → null.
 * S9 — All exhausted: every account in cooldown → null.
 * S10 — Single account: only candidate is always returned (no rotation).
 * S11 — boundId unknown: id not in pool → null (not a different account).
 * S12 — Mixed kinds: list() kind-filter must not leak tool-* accounts into
 *        acquireSession results.
 */
import { describe, expect, it } from "vitest"
import { pickAccount, type AccountRecord } from "./rotation-policy.js"

// ─── helpers ──────────────────────────────────────────────────────────────────

const anthropic = (
  id: string,
  overrides: Partial<AccountRecord> = {},
): AccountRecord => ({
  id,
  kind: "anthropic",
  secretRef: `anth:${id}`,
  inFlight: 0,
  lastUsedMs: 0,
  ...overrides,
})

const tool = (id: string): AccountRecord => ({
  id,
  kind: "tool-computer",
  secretRef: `tool:${id}`,
  inFlight: 0,
  lastUsedMs: 0,
})

// ─── S1 — Basic list ──────────────────────────────────────────────────────────

describe("S1 — Basic list", () => {
  /**
   * Given: three healthy anthropic accounts, all idle.
   * When:  pickAccount is called with kind "anthropic".
   * Then:  one account is returned (not null).
   */
  it("returns one of the available accounts", () => {
    const accounts = [anthropic("a1"), anthropic("a2"), anthropic("a3")]
    const result = pickAccount(accounts, "anthropic", 0)
    expect(result).not.toBeNull()
    expect(["a1", "a2", "a3"]).toContain(result?.id)
  })
})

// ─── S2 — Kind filter ─────────────────────────────────────────────────────────

describe("S2 — Kind filter", () => {
  /**
   * Given: one anthropic account and one tool account.
   * When:  pickAccount is called with kind "anthropic".
   * Then:  the tool account is never returned.
   */
  it("never returns a non-anthropic account for acquireSession", () => {
    const accounts = [anthropic("a1"), tool("t1")]
    for (let i = 0; i < 20; i++) {
      const result = pickAccount(accounts, "anthropic", i)
      expect(result?.id).toBe("a1")
    }
  })

  /**
   * Given: only tool accounts in the pool.
   * When:  pickAccount is called with kind "anthropic".
   * Then:  null is returned.
   */
  it("returns null when no accounts match the requested kind", () => {
    const accounts = [tool("t1"), tool("t2")]
    expect(pickAccount(accounts, "anthropic", 0)).toBeNull()
  })
})

// ─── S3 — Cooldown exclusion ──────────────────────────────────────────────────

describe("S3 — Cooldown exclusion", () => {
  /**
   * Given: a1 is in cooldown (cooldownUntilMs=1000), a2 is healthy.
   * When:  pickAccount is called at nowMs=500 (before cooldown expires).
   * Then:  only a2 is returned.
   */
  it("skips the account whose cooldownUntilMs is in the future", () => {
    const accounts = [
      anthropic("a1", { cooldownUntilMs: 1000 }),
      anthropic("a2"),
    ]
    const result = pickAccount(accounts, "anthropic", 500)
    expect(result?.id).toBe("a2")
  })

  /**
   * Given: a1 has cooldownUntilMs=1000, a2 also in cooldown.
   * When:  pickAccount is called at nowMs=999.
   * Then:  null — both excluded.
   */
  it("returns null when all accounts are in cooldown", () => {
    const accounts = [
      anthropic("a1", { cooldownUntilMs: 1000 }),
      anthropic("a2", { cooldownUntilMs: 500 }),
    ]
    expect(pickAccount(accounts, "anthropic", 499)).toBeNull()
  })
})

// ─── S4 — Cooldown expired ────────────────────────────────────────────────────

describe("S4 — Cooldown expired", () => {
  /**
   * Given: a1 has cooldownUntilMs=1000.
   * When:  pickAccount is called at nowMs=1000 (exactly at boundary).
   * Then:  a1 is eligible (cooldownUntilMs <= nowMs).
   */
  it("account is eligible exactly at the cooldown boundary (<=)", () => {
    const accounts = [anthropic("a1", { cooldownUntilMs: 1000 })]
    const result = pickAccount(accounts, "anthropic", 1000)
    expect(result?.id).toBe("a1")
  })

  /**
   * Given: a1 has cooldownUntilMs=1000.
   * When:  called at nowMs=1001.
   * Then:  a1 is eligible.
   */
  it("account is eligible after cooldown expires", () => {
    const accounts = [anthropic("a1", { cooldownUntilMs: 1000 })]
    expect(pickAccount(accounts, "anthropic", 1001)?.id).toBe("a1")
  })

  /**
   * Given: a1 has cooldownUntilMs=1000.
   * When:  called at nowMs=999.
   * Then:  null — not yet expired.
   */
  it("account is NOT eligible one ms before cooldown expires", () => {
    const accounts = [anthropic("a1", { cooldownUntilMs: 1000 })]
    expect(pickAccount(accounts, "anthropic", 999)).toBeNull()
  })
})

// ─── S5 — LRU tie-break ───────────────────────────────────────────────────────

describe("S5 — LRU tie-break (equal inFlight)", () => {
  /**
   * Given: three accounts with equal inFlight=0, different lastUsedMs.
   * When:  pickAccount is called.
   * Then:  the account with the smallest lastUsedMs (oldest) is returned.
   */
  it("picks the least-recently-used account when inFlight is tied", () => {
    const accounts = [
      anthropic("a1", { lastUsedMs: 300 }),
      anthropic("a2", { lastUsedMs: 100 }), // oldest → should win
      anthropic("a3", { lastUsedMs: 200 }),
    ]
    const result = pickAccount(accounts, "anthropic", 1000)
    expect(result?.id).toBe("a2")
  })

  /**
   * Given: all accounts have lastUsedMs=0 (never used).
   * When:  called.
   * Then:  returns the first element (stable sort heads the identical group).
   */
  it("returns the first account when all are equally idle (lastUsedMs=0)", () => {
    const accounts = [anthropic("a1"), anthropic("a2"), anthropic("a3")]
    const result = pickAccount(accounts, "anthropic", 0)
    expect(result?.id).toBe("a1")
  })
})

// ─── S6 — inFlight ordering ───────────────────────────────────────────────────

describe("S6 — inFlight ordering", () => {
  /**
   * Given: a1 inFlight=2, a2 inFlight=0, a3 inFlight=1.
   * When:  pickAccount is called.
   * Then:  a2 wins (lowest inFlight), regardless of lastUsedMs.
   */
  it("picks account with the lowest inFlight count", () => {
    const accounts = [
      anthropic("a1", { inFlight: 2, lastUsedMs: 0 }),
      anthropic("a2", { inFlight: 0, lastUsedMs: 999 }), // highest lastUsedMs but wins
      anthropic("a3", { inFlight: 1, lastUsedMs: 0 }),
    ]
    expect(pickAccount(accounts, "anthropic", 1000)?.id).toBe("a2")
  })

  /**
   * Given: a1 inFlight=1, a2 inFlight=1 with older lastUsedMs.
   * When:  pickAccount is called.
   * Then:  a2 wins (LRU tie-break on equal inFlight).
   */
  it("applies LRU tie-break when inFlight counts are equal but > 0", () => {
    const accounts = [
      anthropic("a1", { inFlight: 1, lastUsedMs: 500 }),
      anthropic("a2", { inFlight: 1, lastUsedMs: 100 }), // older → wins
    ]
    expect(pickAccount(accounts, "anthropic", 1000)?.id).toBe("a2")
  })
})

// ─── S7 — Sticky-pin hit ──────────────────────────────────────────────────────

describe("S7 — Sticky-pin (boundId)", () => {
  /**
   * Given: three healthy accounts; a2 is NOT next in round-robin.
   * When:  pickAccount is called with boundId="a2".
   * Then:  a2 is returned regardless of rotation order.
   *
   * This is the core guarantee for the account-switcher: selecting an
   * account in the dropdown pins every subsequent new-thread to that
   * account.
   */
  it("returns exactly the pinned account when it is healthy", () => {
    const accounts = [
      anthropic("a1", { lastUsedMs: 0 }), // would win LRU otherwise
      anthropic("a2", { lastUsedMs: 500 }),
      anthropic("a3", { lastUsedMs: 200 }),
    ]
    const result = pickAccount(accounts, "anthropic", 1000, "a2")
    expect(result?.id).toBe("a2")
  })

  /**
   * Given: three accounts; user pins to a2 repeatedly.
   * When:  pickAccount is called 10 times with boundId="a2".
   * Then:  always returns a2 — no rotation escapes the pin.
   */
  it("consistently returns the pinned account across multiple calls", () => {
    const accounts = [
      anthropic("a1"),
      anthropic("a2", { lastUsedMs: 999 }),
      anthropic("a3"),
    ]
    for (let i = 0; i < 10; i++) {
      expect(pickAccount(accounts, "anthropic", i, "a2")?.id).toBe("a2")
    }
  })
})

// ─── S8 — Sticky-pin blocked by cooldown ──────────────────────────────────────

describe("S8 — Sticky-pin blocked by cooldown", () => {
  /**
   * Given: user pins to a2, but a2 is rate-limited (in cooldown).
   * When:  pickAccount is called.
   * Then:  null is returned — sticky-pin does NOT fall back to another account.
   *
   * Rationale: falling back silently to the wrong account would defeat the
   * purpose of the switcher (user wants to use a specific account).
   * The caller maps null → AllAccountsExhaustedError.
   */
  it("returns null when the pinned account is in cooldown", () => {
    const accounts = [
      anthropic("a1"), // healthy — but NOT selected
      anthropic("a2", { cooldownUntilMs: 9999 }), // pinned but rate-limited
      anthropic("a3"), // healthy — but NOT selected
    ]
    const result = pickAccount(accounts, "anthropic", 500, "a2")
    expect(result).toBeNull()
  })
})

// ─── S9 — All exhausted ───────────────────────────────────────────────────────

describe("S9 — All accounts exhausted", () => {
  /**
   * Given: all anthropic accounts are in cooldown.
   * When:  pickAccount is called (no pin).
   * Then:  null is returned.
   */
  it("returns null when every account is rate-limited", () => {
    const accounts = [
      anthropic("a1", { cooldownUntilMs: 9999 }),
      anthropic("a2", { cooldownUntilMs: 9999 }),
      anthropic("a3", { cooldownUntilMs: 9999 }),
    ]
    expect(pickAccount(accounts, "anthropic", 100)).toBeNull()
  })
})

// ─── S10 — Single account pool ────────────────────────────────────────────────

describe("S10 — Single account", () => {
  /**
   * Given: only one anthropic account in the pool.
   * When:  pickAccount is called N times.
   * Then:  always returns that account.
   */
  it("always returns the sole account regardless of call count", () => {
    const accounts = [anthropic("solo")]
    for (let i = 0; i < 5; i++) {
      expect(pickAccount(accounts, "anthropic", i)?.id).toBe("solo")
    }
  })

  /**
   * Given: only one account; it is in cooldown.
   * When:  pickAccount is called.
   * Then:  null — no fallback available.
   */
  it("returns null when the sole account is rate-limited", () => {
    const accounts = [anthropic("solo", { cooldownUntilMs: 9999 })]
    expect(pickAccount(accounts, "anthropic", 100)).toBeNull()
  })
})

// ─── S11 — Unknown boundId ────────────────────────────────────────────────────

describe("S11 — Unknown boundId", () => {
  /**
   * Given: pool has a1, a2, a3.
   * When:  pickAccount is called with boundId="unknown-account".
   * Then:  null — NOT a different account. The caller must surface an error.
   *
   * This prevents silent mis-routing when the UI sends a stale account id.
   */
  it("returns null for a boundId that does not exist in the pool", () => {
    const accounts = [anthropic("a1"), anthropic("a2")]
    expect(pickAccount(accounts, "anthropic", 0, "unknown-account")).toBeNull()
  })
})

// ─── S12 — Mixed kinds don't bleed ───────────────────────────────────────────

describe("S12 — Mixed kinds don't bleed", () => {
  /**
   * Given: pool has anthropic a1, tool-computer t1, tool-browser b1.
   * When:  pickAccount is called with kind "anthropic".
   * Then:  only a1 appears — tool accounts never leak into session results.
   *
   * This validates that the AccountBroker.list(kind) filter works correctly
   * for the account-switcher dropdown (only "anthropic" accounts shown).
   */
  it("never returns tool-* accounts when kind='anthropic'", () => {
    const accounts = [
      tool("t1"),
      anthropic("a1"),
      { ...tool("b1"), kind: "tool-browser" },
    ]
    const results = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const r = pickAccount(accounts, "anthropic", i)
      if (r) results.add(r.id)
    }
    expect(results).toEqual(new Set(["a1"]))
  })

  /**
   * Given: pool has anthropic a1, a2 and tool-computer t1.
   * When:  pickAccount is called with kind "tool-computer".
   * Then:  only t1 appears — anthropic accounts don't leak into tool results.
   */
  it("kind='tool-computer' sees only tool-computer accounts", () => {
    const accounts = [anthropic("a1"), anthropic("a2"), tool("t1")]
    const result = pickAccount(accounts, "tool-computer", 0)
    expect(result?.id).toBe("t1")
    // anthropic accounts never appear in tool results
    expect(result?.kind).toBe("tool-computer")
  })
})
