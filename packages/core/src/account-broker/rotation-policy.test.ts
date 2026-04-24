import { describe, expect, it } from "vitest"
import { pickAccount, type AccountRecord } from "./rotation-policy.js"

const acct = (
  id: string,
  overrides: Partial<AccountRecord> = {},
): AccountRecord => ({
  id,
  kind: "anthropic",
  secretRef: `env:${id.toUpperCase()}`,
  inFlight: 0,
  lastUsedMs: 0,
  ...overrides,
})

describe("pickAccount", () => {
  it("round-robin: 3 healthy accounts, 3 picks return distinct ids", () => {
    let pool: AccountRecord[] = [acct("a1"), acct("a2"), acct("a3")]
    const picks: string[] = []
    for (let i = 0; i < 3; i++) {
      const now = 1000 + i
      const chosen = pickAccount(pool, "anthropic", now)
      expect(chosen).not.toBeNull()
      picks.push(chosen!.id)
      // Simulate acquire: bump inFlight + lastUsedMs.
      pool = pool.map((a) =>
        a.id === chosen!.id
          ? { ...a, inFlight: a.inFlight + 1, lastUsedMs: now }
          : a,
      )
    }
    expect(new Set(picks).size).toBe(3)
  })

  it("cooldown filter: account in cooldown is never returned", () => {
    const pool: AccountRecord[] = [
      acct("a1", { cooldownUntilMs: 5000 }),
      acct("a2"),
      acct("a3"),
    ]
    for (let i = 0; i < 10; i++) {
      const chosen = pickAccount(pool, "anthropic", 1000)
      expect(chosen?.id).not.toBe("a1")
    }
  })

  it("all in cooldown → null", () => {
    const pool: AccountRecord[] = [
      acct("a1", { cooldownUntilMs: 5000 }),
      acct("a2", { cooldownUntilMs: 5000 }),
    ]
    expect(pickAccount(pool, "anthropic", 1000)).toBeNull()
  })

  it("boundId hits if healthy", () => {
    const pool: AccountRecord[] = [acct("a1"), acct("a2"), acct("a3")]
    const got = pickAccount(pool, "anthropic", 1000, "a2")
    expect(got?.id).toBe("a2")
  })

  it("boundId in cooldown → null", () => {
    const pool: AccountRecord[] = [
      acct("a1"),
      acct("a2", { cooldownUntilMs: 5000 }),
    ]
    expect(pickAccount(pool, "anthropic", 1000, "a2")).toBeNull()
  })

  it("boundId unknown → null", () => {
    const pool: AccountRecord[] = [acct("a1")]
    expect(pickAccount(pool, "anthropic", 1000, "ghost")).toBeNull()
  })

  it("kind filter excludes non-matching kind", () => {
    const pool: AccountRecord[] = [
      acct("a1", { kind: "anthropic" }),
      acct("t1", { kind: "tool-foo" }),
      acct("t2", { kind: "tool-foo" }),
    ]
    const got = pickAccount(pool, "tool-foo", 1000)
    expect(got?.kind).toBe("tool-foo")
    expect(["t1", "t2"]).toContain(got!.id)
  })
})
