import { describe, expect, it } from "vitest"
import Database from "bun:sqlite"
import {
  isValidCredentialRef,
  settingsAccountId,
  syncProviderAccountsToDb,
  ProviderAccountSyncError,
} from "./sync-accounts.js"
import type { ProviderConfig } from "./types.js"

describe("isValidCredentialRef", () => {
  it("accepts pointer forms and rejects raw keys / file refs", () => {
    expect(isValidCredentialRef("env:ANTHROPIC_API_KEY")).toBe(true)
    expect(isValidCredentialRef("op://Vault/item/field")).toBe(true)
    expect(isValidCredentialRef("luna-op://work/Vault/item")).toBe(true)
    expect(isValidCredentialRef("claude-code:login")).toBe(true)
    expect(isValidCredentialRef("sk-raw-api-key")).toBe(false)
    expect(isValidCredentialRef("file:/tmp/key")).toBe(false)
    expect(isValidCredentialRef("env://BAD")).toBe(false)
  })
})

describe("syncProviderAccountsToDb", () => {
  it("upserts settings-<kind> for enabled+credentialRef and deletes when disabled", () => {
    const db = new Database(":memory:")
    const enabled: ProviderConfig[] = [
      { kind: "anthropic", enabled: true, credentialRef: "env:ANTHROPIC_API_KEY" },
      { kind: "openai", enabled: false, credentialRef: "env:OPENAI_API_KEY" },
    ]
    syncProviderAccountsToDb(db, enabled)

    const rows = db.query("SELECT id, kind, secret_ref FROM accounts ORDER BY id").all() as Array<{
      id: string
      kind: string
      secret_ref: string
    }>
    expect(rows).toEqual([
      {
        id: settingsAccountId("anthropic"),
        kind: "anthropic",
        secret_ref: "env:ANTHROPIC_API_KEY",
      },
    ])

    // Rotate credentialRef in place.
    syncProviderAccountsToDb(db, [
      { kind: "anthropic", enabled: true, credentialRef: "  env:NEW_KEY  " },
    ])
    const after = db
      .query("SELECT secret_ref FROM accounts WHERE id = ?")
      .get(settingsAccountId("anthropic")) as { secret_ref: string }
    expect(after.secret_ref).toBe("env:NEW_KEY")

    // Disable removes the settings-managed row only.
    syncProviderAccountsToDb(db, [{ kind: "anthropic", enabled: false }])
    expect(
      db.query("SELECT COUNT(*) AS n FROM accounts").get() as { n: number },
    ).toEqual({ n: 0 })
  })

  it("never deletes non-settings account rows", () => {
    const db = new Database(":memory:")
    db.run(`CREATE TABLE accounts (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL,
      secret_ref TEXT NOT NULL, health TEXT NOT NULL, cooldown_ms INTEGER,
      usage_json TEXT NOT NULL
    )`)
    db.query(
      `INSERT INTO accounts VALUES ('cli-anthropic', 'cli', 'anthropic', 'env:CLI', 'healthy', NULL, '{}')`,
    ).run()

    syncProviderAccountsToDb(db, [
      { kind: "anthropic", enabled: true, credentialRef: "env:SETTINGS" },
    ])
    syncProviderAccountsToDb(db, [{ kind: "anthropic", enabled: false }])

    const left = db.query("SELECT id FROM accounts").all() as Array<{ id: string }>
    expect(left).toEqual([{ id: "cli-anthropic" }])
  })

  it("rejects a raw API key credentialRef", () => {
    const db = new Database(":memory:")
    expect(() =>
      syncProviderAccountsToDb(db, [
        { kind: "openai", enabled: true, credentialRef: "sk-live-raw" },
      ]),
    ).toThrow(ProviderAccountSyncError)
  })
})
