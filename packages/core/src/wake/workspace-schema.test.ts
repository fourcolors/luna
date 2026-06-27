import { describe, expect, it } from "vitest"
import { Database } from "bun:sqlite"
import {
  hasWakeSchema,
  installWakeSchema,
  WAKE_REQUIRED_TABLES,
} from "./workspace-schema.js"

describe("hasWakeSchema", () => {
  it("is false for a fresh db with no wake tables", () => {
    const db = new Database(":memory:")
    expect(hasWakeSchema(db)).toBe(false)
    db.close()
  })

  it("is false when only one of goals/next_actions exists", () => {
    const db = new Database(":memory:")
    db.run(
      "CREATE TABLE goals (slug TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT, priority INTEGER, created_at INTEGER, updated_at INTEGER)",
    )
    expect(hasWakeSchema(db)).toBe(false) // next_actions still missing
    db.close()
  })

  it("is true once the full schema is installed", () => {
    const db = new Database(":memory:")
    installWakeSchema(db)
    expect(hasWakeSchema(db)).toBe(true)
    db.close()
  })

  it("only requires goals + next_actions (not wake_log)", () => {
    expect([...WAKE_REQUIRED_TABLES]).toEqual(["goals", "next_actions"])
  })
})

describe("installWakeSchema", () => {
  it("is idempotent — re-running does not throw or lose data", () => {
    const db = new Database(":memory:")
    installWakeSchema(db)
    db.run(
      "INSERT INTO goals (slug, title, created_at, updated_at) VALUES ('g1','G1',1,1)",
    )
    installWakeSchema(db) // second run is a no-op
    const rows = db.query("SELECT slug FROM goals").all() as Array<{
      slug: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.slug).toBe("g1")
    db.close()
  })

  it("creates next_actions with a NULLABLE goal_slug (the masked-bug fix)", () => {
    const db = new Database(":memory:")
    installWakeSchema(db)
    // An unattached proposal (goal_slug = null) MUST insert cleanly. A NOT NULL
    // column here would silently drop every such proposal (Path-B dead on arrival).
    db.run(
      "INSERT INTO next_actions (goal_slug, action, priority, created_at, updated_at) VALUES (NULL, 'do a thing', 3, 10, 10)",
    )
    const rows = db
      .query("SELECT goal_slug, action FROM next_actions")
      .all() as Array<{ goal_slug: string | null; action: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.goal_slug).toBeNull()
    expect(rows[0]?.action).toBe("do a thing")
    db.close()
  })
})
