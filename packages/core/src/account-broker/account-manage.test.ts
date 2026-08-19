/**
 * account-manage.test.ts — pure validation + in-memory fake DB for add/rm.
 */
import { describe, expect, it } from "vitest"
import {
  addAccountToDb,
  removeAccountFromDb,
  validateAccountAddInput,
  type AccountManageDb,
} from "./account-manage.js"

function makeMemDb(
  initial: Array<{
    id: string
    label: string
    kind: string
    secret_ref: string
    health: string
  }> = [],
): AccountManageDb & { rows: typeof initial } {
  const rows = [...initial]
  return {
    rows,
    query: (sql: string) => ({
      all: () => {
        if (sql.includes("SELECT id, label, kind, health")) {
          return rows.map((r) => ({
            id: r.id,
            label: r.label,
            kind: r.kind,
            health: r.health,
          }))
        }
        return []
      },
      get: (...p: unknown[]) => {
        if (sql.includes("COUNT(*)")) {
          return { n: rows.filter((r) => r.kind === "anthropic").length }
        }
        if (sql.includes("WHERE id = ?")) {
          const id = String(p[0] ?? "")
          return rows.find((r) => r.id === id) ?? null
        }
        return null
      },
      run: (...p: unknown[]) => {
        if (sql.includes("INSERT INTO accounts")) {
          const id = String(p[0])
          if (rows.some((r) => r.id === id)) {
            throw new Error("UNIQUE constraint failed")
          }
          rows.push({
            id,
            label: String(p[1]),
            kind: String(p[2]),
            secret_ref: String(p[3]),
            health: String(p[4] ?? "healthy"),
          })
          return { changes: 1 }
        }
        if (sql.includes("DELETE FROM accounts")) {
          const id = String(p[0])
          const before = rows.length
          const idx = rows.findIndex((r) => r.id === id)
          if (idx >= 0) rows.splice(idx, 1)
          return { changes: before - rows.length }
        }
        return { changes: 0 }
      },
    }),
  }
}

describe("validateAccountAddInput", () => {
  it("accepts claude-code:login / env: / op:// / luna-op://", () => {
    for (const secretRef of [
      "claude-code:login",
      "env:ANTHROPIC_API_KEY",
      "op://vault/item/field",
      "luna-op://work/vault/item/field",
    ]) {
      expect(
        validateAccountAddInput({
          id: "a1",
          label: "Primary",
          kind: "anthropic",
          secretRef,
        }).ok,
      ).toBe(true)
    }
  })

  it("rejects file: refs and empty fields", () => {
    expect(
      validateAccountAddInput({
        id: "a1",
        label: "x",
        kind: "anthropic",
        secretRef: "file:/tmp/x",
      }).ok,
    ).toBe(false)
    expect(
      validateAccountAddInput({
        id: "",
        label: "x",
        kind: "anthropic",
        secretRef: "env:X",
      }).ok,
    ).toBe(false)
  })
})

describe("addAccountToDb / removeAccountFromDb", () => {
  it("adds then removes; refuses last Anthropic", () => {
    const db = makeMemDb([
      {
        id: "default",
        label: "Claude.ai",
        kind: "anthropic",
        secret_ref: "claude-code:login",
        health: "healthy",
      },
    ])
    const added = addAccountToDb(db, {
      id: "account-secondary-1",
      label: "secondary",
      kind: "anthropic",
      secretRef: "env:SECONDARY",
    })
    expect(added.ok).toBe(true)
    expect(db.rows).toHaveLength(2)

    const rm = removeAccountFromDb(db, "account-secondary-1")
    expect(rm.ok).toBe(true)
    expect(db.rows).toHaveLength(1)

    const refuse = removeAccountFromDb(db, "default")
    expect(refuse.ok).toBe(false)
    expect(refuse.message).toMatch(/last Anthropic/i)
  })
})
