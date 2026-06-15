/**
 * vault-frames.protocol.test.ts — frame-shape and wire-safety tests for the
 * Luna Vault V1 wire frames.
 *
 * WHY THIS EXISTS
 * ---------------
 * `vault-put` and `vault-import` carry sensitive credential values. The test
 * pins:
 *   a) that the frame shapes match the plan exactly (additive, no bump needed),
 *   b) that vault-status and vault-list NEVER carry a `value` or `password`
 *      field (wire-safety by construction check), and
 *   c) that the new frames appear in both the protocol.ts and wire.ts unions
 *      (the frame-set test already covers this; we add named assertions here so
 *      failures point directly at the vault feature).
 *
 * Following frame-set.protocol.test.ts: we parse source text rather than
 * relying on TS type erasure at runtime.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type {
  VaultDeleteFrame,
  VaultImportFrame,
  VaultListFrame,
  VaultPutFrame,
  VaultStatusFrame,
  VaultSyncConfigFrame,
  VaultWireItem,
  VaultSyncWire,
} from "../src/protocol.js"

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function readSource(relPath: string): string {
  return readFileSync(new URL(relPath, import.meta.url), "utf8")
}

/** Build a minimal VaultWireItem fixture with obviously-fake values. */
const fakeItem = (overrides?: Partial<VaultWireItem>): VaultWireItem => ({
  id: "item-fake-uuid-001",
  name: "Fake API Key",
  kind: "env-secret",
  ref: "env:FAKE_API_KEY",
  source: "manual",
  description: null,
  createdAt: 1000,
  updatedAt: 1001,
  synced: false,
  shadowed: false,
  ...overrides,
})

/** Build a minimal VaultSyncWire fixture. */
const fakeSyncWire = (): VaultSyncWire => ({
  enabled: false,
  opLabel: null,
  opVault: null,
  lastSyncedAt: null,
  lastError: null,
  pollSeconds: 300,
})

/* -------------------------------------------------------------------------- */
/* Frame-shape tests                                                           */
/* -------------------------------------------------------------------------- */

describe("vault wire frames — shape and field presence", () => {
  it("VaultWireItem carries no secret value fields (registry is pointers only)", () => {
    const item = fakeItem()
    // Ensure 'value', 'password', 'secret', 'token' are NOT keys on the item.
    expect("value" in item).toBe(false)
    expect("password" in item).toBe(false)
    expect("secret" in item).toBe(false)
    expect("token" in item).toBe(false)
    // 'ref' is an opaque pointer (e.g. "env:FAKE_API_KEY"), not a value.
    expect(item.ref).toBe("env:FAKE_API_KEY")
  })

  it("VaultListFrame has items + optional sync; no value fields", () => {
    const frame: VaultListFrame = {
      type: "vault-list",
      items: [fakeItem()],
    }
    expect(frame.type).toBe("vault-list")
    expect(frame.items).toHaveLength(1)
    expect(frame.sync).toBeUndefined()
    expect("value" in frame).toBe(false)

    const withSync: VaultListFrame = {
      type: "vault-list",
      items: [],
      sync: fakeSyncWire(),
    }
    expect(withSync.sync?.enabled).toBe(false)
  })

  it("VaultStatusFrame carries requestId + ok + message; no value field", () => {
    const ok: VaultStatusFrame = {
      type: "vault-status",
      requestId: "req-abc",
      ok: true,
      message: "stored",
    }
    expect(ok.type).toBe("vault-status")
    expect(ok.ok).toBe(true)
    expect("value" in ok).toBe(false)
    expect("password" in ok).toBe(false)

    const fail: VaultStatusFrame = {
      type: "vault-status",
      requestId: "req-abc",
      ok: false,
      message: "label not found in LUNA_OP_ACCOUNTS",
    }
    expect(fail.ok).toBe(false)
    // Message must be diagnostic text, not an echoed value.
    expect(fail.message).not.toContain("ops_")
  })

  it("VaultPutFrame requires name + kind + value; varName/label/description optional", () => {
    const envPut: VaultPutFrame = {
      type: "vault-put",
      requestId: "req-env-001",
      name: "My API Key",
      kind: "env-secret",
      varName: "FAKE_API_KEY",
      value: "ops_test_token_fake",
    }
    expect(envPut.type).toBe("vault-put")
    expect(envPut.kind).toBe("env-secret")
    expect(envPut.varName).toBe("FAKE_API_KEY")
    expect(envPut.label).toBeUndefined()
    expect(envPut.description).toBeUndefined()

    const opPut: VaultPutFrame = {
      type: "vault-put",
      requestId: "req-op-001",
      name: "My 1P Token",
      kind: "op-token",
      label: "my-label",
      value: "ops_test_token_fake",
      description: "Used for personal vault",
    }
    expect(opPut.kind).toBe("op-token")
    expect(opPut.label).toBe("my-label")
    expect(opPut.description).toBe("Used for personal vault")
  })

  it("VaultDeleteFrame requires requestId + id only", () => {
    const frame: VaultDeleteFrame = {
      type: "vault-delete",
      requestId: "req-del-001",
      id: "item-fake-uuid-001",
    }
    expect(frame.type).toBe("vault-delete")
    expect(frame.id).toBe("item-fake-uuid-001")
    expect("value" in frame).toBe(false)
  })

  it("VaultSyncConfigFrame carries enabled + optional opLabel/opVault/pollSeconds", () => {
    const frame: VaultSyncConfigFrame = {
      type: "vault-sync-config",
      requestId: "req-sync-001",
      enabled: true,
      opLabel: "my-label",
      opVault: "Personal",
      pollSeconds: 300,
    }
    expect(frame.type).toBe("vault-sync-config")
    expect(frame.enabled).toBe(true)
    expect(frame.opLabel).toBe("my-label")
    expect(frame.pollSeconds).toBe(300)

    const minimal: VaultSyncConfigFrame = {
      type: "vault-sync-config",
      requestId: "req-sync-002",
      enabled: false,
    }
    expect(minimal.opLabel).toBeUndefined()
    expect("value" in minimal).toBe(false)
  })

  it("VaultImportFrame items have title + password; url/username/notes optional", () => {
    const frame: VaultImportFrame = {
      type: "vault-import",
      requestId: "req-import-001",
      items: [
        {
          title: "Example Login",
          url: "https://example.test",
          username: "user@example.test",
          password: "hunter2_fake",
          notes: "test note",
        },
        {
          title: "Minimal Login",
          password: "pw_fake",
        },
      ],
    }
    expect(frame.type).toBe("vault-import")
    expect(frame.items).toHaveLength(2)
    expect(frame.items[0]?.title).toBe("Example Login")
    expect(frame.items[1]?.url).toBeUndefined()
    expect(frame.items[1]?.username).toBeUndefined()
    expect(frame.items[1]?.notes).toBeUndefined()
    // Value goes UP only — server never echoes password in any response frame.
  })
})

/* -------------------------------------------------------------------------- */
/* Source-text wire-safety assertions                                          */
/* -------------------------------------------------------------------------- */

describe("vault frames — wire-safety (source-text checks)", () => {
  const protoSrc = readSource("../src/protocol.ts")
  const wireSrc = readSource("../../ui-shared/src/wire.ts")

  it("VaultListFrame interface in protocol.ts has no value/password/secret/token field", () => {
    // Extract the VaultListFrame interface body from source text.
    const start = protoSrc.indexOf("export interface VaultListFrame")
    expect(start).toBeGreaterThan(-1)
    const end = protoSrc.indexOf("\n}\n", start) + 3
    const body = protoSrc.slice(start, end)
    expect(body).not.toMatch(/readonly value/)
    expect(body).not.toMatch(/readonly password/)
    expect(body).not.toMatch(/readonly secret/)
    expect(body).not.toMatch(/readonly token/)
  })

  it("VaultStatusFrame interface in protocol.ts has no value/password field", () => {
    const start = protoSrc.indexOf("export interface VaultStatusFrame")
    expect(start).toBeGreaterThan(-1)
    const end = protoSrc.indexOf("\n}\n", start) + 3
    const body = protoSrc.slice(start, end)
    expect(body).not.toMatch(/readonly value/)
    expect(body).not.toMatch(/readonly password/)
  })

  it("VaultWireItem interface in protocol.ts has no value/password field", () => {
    const start = protoSrc.indexOf("export interface VaultWireItem")
    expect(start).toBeGreaterThan(-1)
    const end = protoSrc.indexOf("\n}\n", start) + 3
    const body = protoSrc.slice(start, end)
    expect(body).not.toMatch(/readonly value/)
    expect(body).not.toMatch(/readonly password/)
    // 'ref' is present (opaque pointer).
    expect(body).toContain("readonly ref:")
  })

  it("vault-list and vault-status appear in protocol.ts ServerFrame union", () => {
    expect(protoSrc).toContain("VaultListFrame")
    expect(protoSrc).toContain("VaultStatusFrame")
    // Both must be in the ServerFrame union block.
    const unionStart = protoSrc.indexOf("export type ServerFrame =")
    const unionEnd = protoSrc.indexOf("\n/* ----------", unionStart)
    const union = protoSrc.slice(unionStart, unionEnd > 0 ? unionEnd : undefined)
    expect(union).toContain("| VaultListFrame")
    expect(union).toContain("| VaultStatusFrame")
  })

  it("vault-put/delete/sync-config/import appear in protocol.ts ClientFrame union", () => {
    const unionStart = protoSrc.indexOf("export type ClientFrame =")
    const union = protoSrc.slice(unionStart)
    expect(union).toContain("| VaultPutFrame")
    expect(union).toContain("| VaultDeleteFrame")
    expect(union).toContain("| VaultSyncConfigFrame")
    expect(union).toContain("| VaultImportFrame")
  })

  it("vault frames are mirrored in wire.ts ServerFrame and ClientFrame unions", () => {
    const serverStart = wireSrc.indexOf("export type ServerFrame =")
    const serverUnion = wireSrc.slice(serverStart)
    expect(serverUnion).toContain("| VaultListFrame")
    expect(serverUnion).toContain("| VaultStatusFrame")

    const clientStart = wireSrc.indexOf("export type ClientFrame =")
    const clientUnion = wireSrc.slice(clientStart)
    expect(clientUnion).toContain("| VaultPutFrame")
    expect(clientUnion).toContain("| VaultDeleteFrame")
    expect(clientUnion).toContain("| VaultSyncConfigFrame")
    expect(clientUnion).toContain("| VaultImportFrame")
  })

  it("VaultSyncWire in both protocol.ts and wire.ts declares pollSeconds as required number", () => {
    // B5: pin that VaultSyncWire.pollSeconds is NOT optional in both sources.
    // A stale fixture that omitted it would compile under vitest (no tsc) but
    // this source-text check catches it without relying on the type-checker.
    for (const [label, src] of [
      ["protocol.ts", protoSrc],
      ["wire.ts", wireSrc],
    ] as const) {
      const start = src.indexOf("export interface VaultSyncWire")
      expect(start, `VaultSyncWire not found in ${label}`).toBeGreaterThan(-1)
      const end = src.indexOf("\n}\n", start) + 3
      const body = src.slice(start, end)
      expect(body, `${label} VaultSyncWire should contain 'readonly pollSeconds: number'`).toContain(
        "readonly pollSeconds: number",
      )
    }
  })

  it("hello capabilities includes vault? in both protocol.ts and wire.ts", () => {
    // Check protocol.ts HelloFrame.capabilities has vault?
    const protoCapStart = protoSrc.indexOf("readonly capabilities: {")
    const protoCapEnd = protoSrc.indexOf("\n  }\n}", protoCapStart) + 6
    const protoCap = protoSrc.slice(protoCapStart, protoCapEnd)
    expect(protoCap).toContain("readonly vault?")

    // Check wire.ts HelloFrame.capabilities has vault?
    const wireCapStart = wireSrc.indexOf("readonly capabilities: {")
    const wireCapEnd = wireSrc.indexOf("\n  }\n}", wireCapStart) + 6
    const wireCap = wireSrc.slice(wireCapStart, wireCapEnd)
    expect(wireCap).toContain("readonly vault?")
  })
})
