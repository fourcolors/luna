import { describe, expect, it } from "vitest"
import {
  accountsFrameToOutput,
  formatHealth,
  type AccountRow,
  type AccountsRenderOptions,
} from "../src/commands/accounts.js"

const tableOpts: AccountsRenderOptions = { json: false }
const jsonOpts: AccountsRenderOptions = { json: true }

/* -------------------------------------------------------------------------- */
/* formatHealth (pure, tiny)                                                   */
/* -------------------------------------------------------------------------- */

describe("accounts — formatHealth (pure)", () => {
  it("leaves healthy unchanged", () => {
    expect(formatHealth("healthy")).toBe("healthy")
  })

  it("appends ⚠ to rate_limited", () => {
    expect(formatHealth("rate_limited")).toBe("rate_limited ⚠")
  })

  it("leaves unknown/custom health strings unchanged", () => {
    expect(formatHealth("degraded")).toBe("degraded")
    expect(formatHealth("")).toBe("")
  })
})

/* -------------------------------------------------------------------------- */
/* accountsFrameToOutput — empty list                                          */
/* -------------------------------------------------------------------------- */

describe("accounts — accountsFrameToOutput (pure) — empty list", () => {
  it("table mode: prints a 'no accounts' message (not an empty table)", () => {
    const out = accountsFrameToOutput([], tableOpts)
    expect(out).toContain("No accounts")
    // No table header should appear for an empty list.
    expect(out).not.toContain("ID")
  })

  it("json mode: emits an empty JSON array", () => {
    const out = accountsFrameToOutput([], jsonOpts)
    expect(JSON.parse(out)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* accountsFrameToOutput — healthy + rate_limited mix                          */
/* -------------------------------------------------------------------------- */

const mixedAccounts: ReadonlyArray<AccountRow> = [
  { id: "acc-primary", label: "Primary", kind: "anthropic", health: "healthy" },
  { id: "acc-secondary", label: "Secondary", kind: "anthropic", health: "rate_limited" },
]

describe("accounts — accountsFrameToOutput (pure) — mixed health", () => {
  it("table mode: shows all columns in the header", () => {
    const out = accountsFrameToOutput(mixedAccounts, tableOpts)
    expect(out).toContain("ID")
    expect(out).toContain("LABEL")
    expect(out).toContain("KIND")
    expect(out).toContain("HEALTH")
  })

  it("table mode: renders healthy accounts without ⚠", () => {
    const out = accountsFrameToOutput(mixedAccounts, tableOpts)
    const lines = out.split("\n")
    const primaryLine = lines.find((l) => l.includes("acc-primary"))
    expect(primaryLine).toBeDefined()
    expect(primaryLine).toContain("healthy")
    expect(primaryLine).not.toContain("⚠")
  })

  it("table mode: renders rate_limited accounts WITH ⚠", () => {
    const out = accountsFrameToOutput(mixedAccounts, tableOpts)
    const lines = out.split("\n")
    const secondaryLine = lines.find((l) => l.includes("acc-secondary"))
    expect(secondaryLine).toBeDefined()
    expect(secondaryLine).toContain("rate_limited ⚠")
  })

  it("table mode: all row data present (id, label, kind)", () => {
    const out = accountsFrameToOutput(mixedAccounts, tableOpts)
    expect(out).toContain("acc-primary")
    expect(out).toContain("Primary")
    expect(out).toContain("anthropic")
    expect(out).toContain("acc-secondary")
    expect(out).toContain("Secondary")
  })

  it("table mode: includes a separator line", () => {
    const out = accountsFrameToOutput(mixedAccounts, tableOpts)
    // The separator is a line of dashes/box-drawing chars.
    const lines = out.split("\n")
    expect(lines.some((l) => /^[─-]{6,}/.test(l.trim()))).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* accountsFrameToOutput — json mode                                           */
/* -------------------------------------------------------------------------- */

describe("accounts — accountsFrameToOutput (pure) — json mode", () => {
  it("emits valid JSON that parses back to the original account array", () => {
    const out = accountsFrameToOutput(mixedAccounts, jsonOpts)
    const parsed = JSON.parse(out) as AccountRow[]
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ id: "acc-primary", health: "healthy" })
    expect(parsed[1]).toMatchObject({ id: "acc-secondary", health: "rate_limited" })
  })

  it("json mode: does NOT append ⚠ to rate_limited (raw values preserved)", () => {
    const out = accountsFrameToOutput(mixedAccounts, jsonOpts)
    const parsed = JSON.parse(out) as AccountRow[]
    // JSON output carries the raw health string, not the display-formatted one.
    expect(parsed[1]!.health).toBe("rate_limited")
    expect(out).not.toContain("⚠")
  })

  it("json mode: does NOT print any table chrome (no header, no separator)", () => {
    const out = accountsFrameToOutput(mixedAccounts, jsonOpts)
    expect(out).not.toContain("ID")
    expect(out).not.toContain("LABEL")
    expect(out).not.toContain("──")
  })
})

/* -------------------------------------------------------------------------- */
/* accountsFrameToOutput — single healthy account                              */
/* -------------------------------------------------------------------------- */

describe("accounts — accountsFrameToOutput (pure) — single account", () => {
  const singleAccount: ReadonlyArray<AccountRow> = [
    { id: "acc-only", label: "Only One", kind: "anthropic", health: "healthy" },
  ]

  it("table mode: renders the single account correctly", () => {
    const out = accountsFrameToOutput(singleAccount, tableOpts)
    expect(out).toContain("acc-only")
    expect(out).toContain("Only One")
    expect(out).toContain("anthropic")
    expect(out).toContain("healthy")
    // No ⚠ on a healthy account.
    expect(out).not.toContain("⚠")
  })

  it("json mode: wraps single account in an array", () => {
    const out = accountsFrameToOutput(singleAccount, jsonOpts)
    const parsed = JSON.parse(out) as AccountRow[]
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
  })
})
