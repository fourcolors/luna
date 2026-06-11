/**
 * toWireVaultItem tests (A8).
 *
 * Mirrors the 5-case spec from the review findings:
 *   1. env-secret whose var name is in shadowedEnvKeys → shadowed=true
 *   2. env-secret whose var name is NOT in shadowedEnvKeys → shadowed=false
 *   3. env-secret with opItemId set → synced=true
 *   4. op-token — never shadowed regardless of shadowedEnvKeys
 *   5. non-env ref — shadowedEnvKeys set is ignored (shadowed=false)
 *
 * Also covers the 10-field completeness contract and the WireVaultItem shape.
 */
import { describe, expect, it } from "vitest"
import { toWireVaultItem } from "../src/wire-projection.js"
import type { VaultItem } from "../src/types.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const base = (over: Partial<VaultItem> = {}): VaultItem => ({
  id: "item-001",
  name: "Openai Api Key",
  kind: "env-secret",
  ref: "env:OPENAI_API_KEY",
  source: "manual",
  description: null,
  createdAt: 1_000_000,
  updatedAt: 2_000_000,
  opItemId: null,
  ...over,
})

// ---------------------------------------------------------------------------
// 5 required cases
// ---------------------------------------------------------------------------

describe("toWireVaultItem", () => {
  it("case 1: env-secret whose varName is in shadowedEnvKeys → shadowed=true", () => {
    const item = base({ ref: "env:OPENAI_API_KEY" })
    const wire = toWireVaultItem(item, new Set(["OPENAI_API_KEY"]))
    expect(wire.shadowed).toBe(true)
    expect(wire.synced).toBe(false)
  })

  it("case 2: env-secret NOT in shadowedEnvKeys → shadowed=false", () => {
    const item = base({ ref: "env:OPENAI_API_KEY" })
    const wire = toWireVaultItem(item, new Set(["SOME_OTHER_KEY"]))
    expect(wire.shadowed).toBe(false)
  })

  it("case 3: env-secret with opItemId set → synced=true", () => {
    const item = base({ ref: "env:OPENAI_API_KEY", opItemId: "op-abc-123" })
    const wire = toWireVaultItem(item, new Set(["OPENAI_API_KEY"]))
    expect(wire.synced).toBe(true)
    expect(wire.shadowed).toBe(true) // still shadowed independently
  })

  it("case 4: op-token — never shadowed regardless of shadowedEnvKeys contents", () => {
    const item = base({
      kind: "op-token",
      ref: "luna-op://primary",
      name: "Primary Token",
    })
    // Even if the shadowed set has a matching string, op-token can never be shadowed.
    const wire = toWireVaultItem(item, new Set(["primary", "luna-op://primary"]))
    expect(wire.shadowed).toBe(false)
  })

  it("case 5: non-env ref (op-item) — shadowedEnvKeys ignored → shadowed=false", () => {
    const item = base({
      kind: "op-item",
      ref: "luna-op://primary/Personal/item999/credential",
      name: "Github Token",
      source: "1password",
      opItemId: "item999",
    })
    const wire = toWireVaultItem(item, new Set(["GITHUB_TOKEN", "item999"]))
    expect(wire.shadowed).toBe(false)
    expect(wire.synced).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // 10-field completeness
  // ---------------------------------------------------------------------------

  it("produces exactly the 10 required wire fields", () => {
    const item = base({ description: "test description", opItemId: "op-xyz" })
    const wire = toWireVaultItem(item, new Set())
    expect(wire.id).toBe(item.id)
    expect(wire.name).toBe(item.name)
    expect(wire.kind).toBe(item.kind)
    expect(wire.ref).toBe(item.ref)
    expect(wire.source).toBe(item.source)
    expect(wire.description).toBe(item.description)
    expect(wire.createdAt).toBe(item.createdAt)
    expect(wire.updatedAt).toBe(item.updatedAt)
    expect(wire.synced).toBe(true)  // opItemId !== null
    expect(wire.shadowed).toBe(false) // not in shadowedEnvKeys
    // Exactly 10 keys
    expect(Object.keys(wire)).toHaveLength(10)
  })

  it("empty shadowedEnvKeys set → shadowed=false for all env-secrets", () => {
    const item = base({ ref: "env:NOTION_API_KEY" })
    const wire = toWireVaultItem(item, new Set())
    expect(wire.shadowed).toBe(false)
  })

  it("preserves null description", () => {
    const item = base({ description: null })
    const wire = toWireVaultItem(item, new Set())
    expect(wire.description).toBeNull()
  })
})
