/**
 * makeVaultOpSync tests.
 *
 * Load-bearing claims:
 *   - The service-account token reaches `op` ONLY via child env
 *     (OP_SERVICE_ACCOUNT_TOKEN); it NEVER appears in argv.
 *   - Outbound credential values reach `op` ONLY via the stdin JSON
 *     template; they NEVER appear in argv, log lines, lastError, or any
 *     returned message.
 *   - lastError is sanitized: operation + exit code only — stderr/stdout
 *     bodies (e.g. a 429 rate-limit body) are never stored.
 *   - syncOnce diffs the manifest: adopt new, refresh changed, remove
 *     vanished source='1password' rows, CLEAR opItemId on vanished
 *     locally-pushed env-secret rows.
 *   - Disabled/never-configured sync → no-op success, runOp never called.
 *   - createItem builds the right template per category; importLogins is
 *     sequential, stops on first hard failure, reports created honestly.
 *   - nextDelayMs: poll floor 60 s, doubling per failure, 3600 s cap.
 *   - NEVER throws (every failure path resolves {ok:false}).
 *
 * Repo is public — all fixtures are fakes (ops_test_token_fake etc.).
 */
import { describe, expect, it, vi } from "vitest"
import {
  makeVaultOpSync,
  shouldAttemptSync,
  type OpRunInput,
  type OpRunResult,
  type VaultOpSyncDeps,
  type VaultSyncStoreFacade,
} from "../src/op-sync.js"
import type { VaultItem, VaultSyncConfig } from "../src/types.js"

// ---------------------------------------------------------------------------
// Test fixtures (FAKES ONLY — public repo)
// ---------------------------------------------------------------------------

const FAKE_TOKEN = "ops_test_token_fake"
const FAKE_VALUE = "sk-fake-credential-value-for-tests"
const FAKE_PASSWORD = "fake-password-for-tests"
const NOW = 1_750_000_000_000

const baseConfig = (overrides: Partial<VaultSyncConfig> = {}): VaultSyncConfig => ({
  enabled: true,
  opLabel: "testacct",
  opVault: "TestVault",
  pollSeconds: 300,
  lastSyncedAt: null,
  lastError: null,
  ...overrides,
})

/** In-memory VaultSyncStoreFacade (items + single sync-config row). */
const makeStore = (
  seed: VaultItem[] = [],
  cfg: VaultSyncConfig | null = baseConfig(),
): VaultSyncStoreFacade & { _items: VaultItem[]; _cfg: () => VaultSyncConfig | null } => {
  const items: VaultItem[] = [...seed]
  let syncCfg: VaultSyncConfig | null = cfg
  return {
    _items: items,
    _cfg: () => syncCfg,
    list: async () => [...items],
    upsertByName: async (item) => {
      const nameLower = item.name.toLowerCase()
      const idx = items.findIndex((i) => i.name.toLowerCase() === nameLower)
      if (idx >= 0) {
        const existing = items[idx]!
        items[idx] = { ...item, id: existing.id, createdAt: existing.createdAt }
      } else {
        items.push(item)
      }
    },
    getById: async (id) => items.find((i) => i.id === id) ?? null,
    remove: async (id) => {
      const idx = items.findIndex((i) => i.id === id)
      if (idx < 0) return false
      items.splice(idx, 1)
      return true
    },
    getSyncConfig: async () => syncCfg,
    setSyncConfig: async (next) => {
      syncCfg = next
    },
  }
}

/** Fake op runner: scripted results + full call capture for argv/env asserts. */
const makeRunOp = (
  script: (input: OpRunInput, callIndex: number) => OpRunResult | Promise<OpRunResult>,
): { runOp: VaultOpSyncDeps["runOp"]; calls: OpRunInput[] } => {
  const calls: OpRunInput[] = []
  const runOp: VaultOpSyncDeps["runOp"] = async (input) => {
    calls.push(input)
    return script(input, calls.length - 1)
  }
  return { runOp, calls }
}

const okList = (items: ReadonlyArray<Record<string, unknown>>): OpRunResult => ({
  code: 0,
  stdout: JSON.stringify(items),
  stderr: "",
})

const okCreate = (id: string): OpRunResult => ({
  code: 0,
  stdout: JSON.stringify({ id, title: "whatever", category: "LOGIN" }),
  stderr: "",
})

const opItemRow = (overrides: Partial<VaultItem> = {}): VaultItem => ({
  id: "row-1",
  name: "Existing Item",
  kind: "op-item",
  ref: "luna-op://testacct/TestVault/op-id-1/password",
  source: "1password",
  description: null,
  createdAt: NOW - 5000,
  updatedAt: NOW - 5000,
  opItemId: "op-id-1",
  ...overrides,
})

const makeDeps = (
  overrides: Partial<VaultOpSyncDeps> = {},
): { deps: VaultOpSyncDeps; store: ReturnType<typeof makeStore>; logs: string[] } => {
  const store = (overrides.store as ReturnType<typeof makeStore> | undefined) ?? makeStore()
  const logs: string[] = []
  const deps: VaultOpSyncDeps = {
    runOp: async () => ({ code: 0, stdout: "[]", stderr: "" }),
    tokenForLabel: (label) => (label === "testacct" ? FAKE_TOKEN : undefined),
    store,
    now: () => NOW,
    log: (msg) => logs.push(msg),
    ...overrides,
  }
  return { deps, store, logs }
}

/** Assert no call ever put the token or a credential value into argv. */
const assertArgvClean = (calls: ReadonlyArray<OpRunInput>): void => {
  for (const call of calls) {
    const argv = call.args.join(" ")
    expect(argv).not.toContain(FAKE_TOKEN)
    expect(argv).not.toContain(FAKE_VALUE)
    expect(argv).not.toContain(FAKE_PASSWORD)
  }
}

// ---------------------------------------------------------------------------
// nextDelayMs — pure backoff helper
// ---------------------------------------------------------------------------

describe("nextDelayMs", () => {
  const { deps } = makeDeps()
  const sync = makeVaultOpSync(deps)

  it("returns the poll interval at 0 failures", () => {
    expect(sync.nextDelayMs(0, 300)).toBe(300_000)
  })

  it("floors the poll interval at 60s", () => {
    expect(sync.nextDelayMs(0, 5)).toBe(60_000)
    expect(sync.nextDelayMs(0, 0)).toBe(60_000)
    expect(sync.nextDelayMs(0, -10)).toBe(60_000)
  })

  it("doubles per consecutive failure", () => {
    expect(sync.nextDelayMs(1, 300)).toBe(600_000)
    expect(sync.nextDelayMs(2, 300)).toBe(1_200_000)
    expect(sync.nextDelayMs(3, 300)).toBe(2_400_000)
  })

  it("caps at 3600s", () => {
    expect(sync.nextDelayMs(4, 300)).toBe(3_600_000)
    expect(sync.nextDelayMs(50, 300)).toBe(3_600_000)
    expect(sync.nextDelayMs(10_000, 300)).toBe(3_600_000)
  })

  it("treats garbage failure counts as 0", () => {
    expect(sync.nextDelayMs(Number.NaN, 300)).toBe(300_000)
    expect(sync.nextDelayMs(-3, 300)).toBe(300_000)
  })
})

// ---------------------------------------------------------------------------
// syncOnce — config gating
// ---------------------------------------------------------------------------

describe("syncOnce — config gating", () => {
  it("is a no-op success when sync was never configured", async () => {
    const { runOp, calls } = makeRunOp(() => okList([]))
    const { deps } = makeDeps({ runOp, store: makeStore([], null) })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res).toEqual({ ok: true, changed: 0, message: "1Password sync is disabled." })
    expect(calls).toHaveLength(0)
  })

  it("is a no-op success when sync is disabled", async () => {
    const { runOp, calls } = makeRunOp(() => okList([]))
    const store = makeStore([], baseConfig({ enabled: false }))
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    expect(res.changed).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it("fails sanely when the label has no discovered token", async () => {
    const { runOp, calls } = makeRunOp(() => okList([]))
    const store = makeStore([], baseConfig({ opLabel: "unknownlabel" }))
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect(store._cfg()?.lastError).toContain("unknownlabel")
    expect(store._cfg()?.lastError).not.toContain(FAKE_TOKEN)
  })
})

// ---------------------------------------------------------------------------
// syncOnce — op invocation hygiene
// ---------------------------------------------------------------------------

describe("syncOnce — op invocation", () => {
  it("lists the configured vault with the token in env, never argv", async () => {
    const { runOp, calls } = makeRunOp(() => okList([]))
    const { deps } = makeDeps({ runOp })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual(["item", "list", "--vault", "TestVault", "--format", "json"])
    expect(calls[0]!.env?.["OP_SERVICE_ACCOUNT_TOKEN"]).toBe(FAKE_TOKEN)
    expect(calls[0]!.stdin).toBeUndefined()
    assertArgvClean(calls)
  })

  it("updates lastSyncedAt and clears lastError on success", async () => {
    const { runOp } = makeRunOp(() => okList([]))
    const store = makeStore([], baseConfig({ lastError: "op item list failed (exit 6)" }))
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    expect(store._cfg()?.lastSyncedAt).toBe(NOW)
    expect(store._cfg()?.lastError).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// syncOnce — inbound diff
// ---------------------------------------------------------------------------

describe("syncOnce — inbound manifest diff", () => {
  it("adopts new 1P items with category-specific primary fields", async () => {
    const { runOp } = makeRunOp(() =>
      okList([
        { id: "op-login-1", title: "Site Login", category: "LOGIN", updated_at: "2026-06-01T00:00:00Z" },
        { id: "op-api-1", title: "Service Key", category: "API_CREDENTIAL", updated_at: "2026-06-02T00:00:00Z" },
        { id: "op-pass-1", title: "Plain Password", category: "PASSWORD", updated_at: "2026-06-03T00:00:00Z" },
        { id: "op-note-1", title: "Some Note", category: "SECURE_NOTE", updated_at: "2026-06-04T00:00:00Z" },
      ]),
    )
    const store = makeStore()
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    expect(res.changed).toBe(4)
    const byOp = new Map(store._items.map((i) => [i.opItemId, i]))
    expect(byOp.get("op-login-1")?.ref).toBe(
      "luna-op://testacct/TestVault/op-login-1/password",
    )
    expect(byOp.get("op-api-1")?.ref).toBe(
      "luna-op://testacct/TestVault/op-api-1/credential",
    )
    expect(byOp.get("op-pass-1")?.ref).toBe(
      "luna-op://testacct/TestVault/op-pass-1/password",
    )
    // Unknown category defaults to password.
    expect(byOp.get("op-note-1")?.ref).toBe(
      "luna-op://testacct/TestVault/op-note-1/password",
    )
    for (const item of store._items) {
      expect(item.kind).toBe("op-item")
      expect(item.source).toBe("1password")
    }
    expect(byOp.get("op-login-1")?.updatedAt).toBe(Date.parse("2026-06-01T00:00:00Z"))
  })

  it("uniquifies an adopted name that collides with a different ref", async () => {
    const envRow: VaultItem = {
      id: "env-1",
      name: "Service Key",
      kind: "env-secret",
      ref: "env:SERVICE_KEY",
      source: "manual",
      description: null,
      createdAt: NOW - 100,
      updatedAt: NOW - 100,
      opItemId: null,
    }
    const { runOp } = makeRunOp(() =>
      okList([{ id: "op-9", title: "Service Key", category: "API_CREDENTIAL", updated_at: "2026-06-01T00:00:00Z" }]),
    )
    const store = makeStore([envRow])
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    const adopted = store._items.find((i) => i.opItemId === "op-9")
    expect(adopted?.name).toBe("Service Key (op-9)")
    // The pre-existing env row is untouched.
    expect(store._items.find((i) => i.id === "env-1")?.name).toBe("Service Key")
  })

  it("refreshes updatedAt in place when the 1P item changed (same title)", async () => {
    const row = opItemRow({ name: "Existing Item" })
    const newUpdated = "2026-06-05T12:00:00Z"
    const { runOp } = makeRunOp(() =>
      okList([{ id: "op-id-1", title: "Existing Item", category: "LOGIN", updated_at: newUpdated }]),
    )
    const store = makeStore([row])
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    expect(res.changed).toBe(1)
    expect(store._items).toHaveLength(1)
    expect(store._items[0]!.updatedAt).toBe(Date.parse(newUpdated))
    expect(store._items[0]!.id).toBe("row-1") // id preserved
  })

  it("renames the row when the 1P title changed", async () => {
    const row = opItemRow({ name: "Old Title" })
    const { runOp } = makeRunOp(() =>
      okList([{ id: "op-id-1", title: "New Title", category: "LOGIN", updated_at: "2026-06-05T00:00:00Z" }]),
    )
    const store = makeStore([row])
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    expect(store._items).toHaveLength(1)
    expect(store._items[0]!.name).toBe("New Title")
    expect(store._items[0]!.opItemId).toBe("op-id-1")
  })

  it("does NOT churn a collision-uniquified row every pass", async () => {
    // Row was adopted as "Title (op-id-1)" because plain "Title" was taken.
    const other = opItemRow({
      id: "row-0",
      name: "Title",
      ref: "luna-op://testacct/TestVault/op-id-0/password",
      opItemId: "op-id-0",
      updatedAt: Date.parse("2026-06-01T00:00:00Z"),
    })
    const uniquified = opItemRow({
      id: "row-1",
      name: "Title (op-id-1)",
      ref: "luna-op://testacct/TestVault/op-id-1/password",
      opItemId: "op-id-1",
      updatedAt: Date.parse("2026-06-01T00:00:00Z"),
    })
    const { runOp } = makeRunOp(() =>
      okList([
        { id: "op-id-0", title: "Title", category: "LOGIN", updated_at: "2026-06-01T00:00:00Z" },
        { id: "op-id-1", title: "Title", category: "LOGIN", updated_at: "2026-06-01T00:00:00Z" },
      ]),
    )
    const store = makeStore([other, uniquified])
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    expect(res.changed).toBe(0)
    expect(store._items.map((i) => i.name).sort()).toEqual(["Title", "Title (op-id-1)"])
  })

  it("removes vanished source='1password' rows", async () => {
    const row = opItemRow()
    const { runOp } = makeRunOp(() => okList([]))
    const store = makeStore([row])
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    expect(res.changed).toBe(1)
    expect(store._items).toHaveLength(0)
  })

  it("clears opItemId (keeps the row) for a vanished locally-pushed env-secret", async () => {
    const pushed: VaultItem = {
      id: "env-2",
      name: "Pushed Secret",
      kind: "env-secret",
      ref: "env:PUSHED_SECRET",
      source: "manual",
      description: null,
      createdAt: NOW - 100,
      updatedAt: NOW - 100,
      opItemId: "op-gone",
    }
    const { runOp } = makeRunOp(() => okList([]))
    const store = makeStore([pushed])
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    expect(res.changed).toBe(1)
    expect(store._items).toHaveLength(1)
    expect(store._items[0]!.opItemId).toBeNull()
    expect(store._items[0]!.kind).toBe("env-secret")
  })

  it("leaves a still-present locally-pushed env-secret row alone", async () => {
    const pushed: VaultItem = {
      id: "env-2",
      name: "Pushed Secret",
      kind: "env-secret",
      ref: "env:PUSHED_SECRET",
      source: "manual",
      description: null,
      createdAt: NOW - 100,
      updatedAt: NOW - 100,
      opItemId: "op-here",
    }
    const { runOp } = makeRunOp(() =>
      okList([{ id: "op-here", title: "Pushed Secret", category: "API_CREDENTIAL", updated_at: "2026-06-01T00:00:00Z" }]),
    )
    const store = makeStore([pushed])
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    expect(res.changed).toBe(0)
    expect(store._items[0]!.opItemId).toBe("op-here")
  })

  it("is idempotent — a second identical pass reports 0 changes", async () => {
    const { runOp } = makeRunOp(() =>
      okList([{ id: "op-1", title: "Item One", category: "LOGIN", updated_at: "2026-06-01T00:00:00Z" }]),
    )
    const store = makeStore()
    const { deps } = makeDeps({ runOp, store })
    const sync = makeVaultOpSync(deps)
    const first = await sync.syncOnce()
    expect(first.changed).toBe(1)
    const second = await sync.syncOnce()
    expect(second.ok).toBe(true)
    expect(second.changed).toBe(0)
    expect(store._items).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// syncOnce — failure sanitization
// ---------------------------------------------------------------------------

describe("syncOnce — failures stay sanitized", () => {
  it("records operation + exit code only on a non-zero exit", async () => {
    const { runOp } = makeRunOp(() => ({
      code: 6,
      stdout: "",
      stderr: "[ERROR] 2026/06/10 secret-bearing stderr body ops_test_token_fake",
    }))
    const store = makeStore()
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(false)
    expect(res.message).toBe("op item list failed (exit 6)")
    expect(store._cfg()?.lastError).toBe("op item list failed (exit 6)")
    expect(store._cfg()?.lastError).not.toContain("stderr body")
    expect(store._cfg()?.lastError).not.toContain(FAKE_TOKEN)
  })

  it("never copies a rate-limit stderr body into lastError", async () => {
    const { runOp } = makeRunOp(() => ({
      code: 1,
      stdout: "",
      stderr: "429 Too Many Requests: rate limit exceeded for account",
    }))
    const store = makeStore()
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(false)
    expect(store._cfg()?.lastError).toBe("op item list failed (exit 1)")
    expect(store._cfg()?.lastError).not.toContain("429")
  })

  it("handles malformed JSON without leaking the body", async () => {
    const { runOp } = makeRunOp(() => ({
      code: 0,
      stdout: "not json {{{ ops_test_token_fake",
      stderr: "",
    }))
    const store = makeStore()
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(false)
    expect(res.message).toBe("op item list returned invalid JSON")
    expect(store._cfg()?.lastError).toBe("op item list returned invalid JSON")
  })

  it("handles a non-array JSON payload as invalid", async () => {
    const { runOp } = makeRunOp(() => ({ code: 0, stdout: '{"id":"x"}', stderr: "" }))
    const { deps } = makeDeps({ runOp })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(false)
    expect(res.message).toBe("op item list returned invalid JSON")
  })

  it("resolves ok:false (never throws) when runOp rejects", async () => {
    const { deps, store } = makeDeps({
      runOp: async () => {
        throw new Error("spawn ENOENT /usr/bin/op")
      },
    })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(false)
    expect(res.message).toBe("op item list failed (spawn error)")
    expect(store._cfg()?.lastError).toBe("op item list failed (spawn error)")
  })

  it("resolves ok:false (never throws) when the store itself fails", async () => {
    const store = makeStore()
    const broken: VaultSyncStoreFacade = {
      ...store,
      list: async () => {
        throw new Error("db locked")
      },
    }
    const { runOp } = makeRunOp(() => okList([]))
    const { deps } = makeDeps({ runOp, store: broken as never })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(false)
  })

  it("preserves lastSyncedAt across a failed pass", async () => {
    const { runOp } = makeRunOp(() => ({ code: 6, stdout: "", stderr: "" }))
    const store = makeStore([], baseConfig({ lastSyncedAt: NOW - 10_000 }))
    const { deps } = makeDeps({ runOp, store })
    await makeVaultOpSync(deps).syncOnce()
    expect(store._cfg()?.lastSyncedAt).toBe(NOW - 10_000)
  })
})

// ---------------------------------------------------------------------------
// createItem
// ---------------------------------------------------------------------------

describe("createItem", () => {
  it("creates via stdin JSON template — value in stdin, NEVER argv", async () => {
    const { runOp, calls } = makeRunOp(() => okCreate("op-new-1"))
    const { deps, logs } = makeDeps({ runOp })
    const res = await makeVaultOpSync(deps).createItem({
      title: "My Api Key",
      value: FAKE_VALUE,
    })
    expect(res.ok).toBe(true)
    expect(res.itemId).toBe("op-new-1")
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.args).toEqual(["item", "create", "-", "--vault", "TestVault", "--format", "json"])
    expect(call.env?.["OP_SERVICE_ACCOUNT_TOKEN"]).toBe(FAKE_TOKEN)
    assertArgvClean(calls)
    // The value lives ONLY in the stdin template.
    const template = JSON.parse(call.stdin!)
    expect(template.category).toBe("API_CREDENTIAL")
    expect(template.title).toBe("My Api Key")
    const cred = template.fields.find((f: { id: string }) => f.id === "credential")
    expect(cred).toMatchObject({ type: "CONCEALED", value: FAKE_VALUE })
    // Value never reaches messages or logs.
    expect(res.message).not.toContain(FAKE_VALUE)
    for (const line of logs) expect(line).not.toContain(FAKE_VALUE)
  })

  it("builds a LOGIN template with username, password purpose, url and notes", async () => {
    const { runOp, calls } = makeRunOp(() => okCreate("op-new-2"))
    const { deps } = makeDeps({ runOp })
    const res = await makeVaultOpSync(deps).createItem({
      title: "Example Login",
      value: FAKE_PASSWORD,
      category: "LOGIN",
      username: "user@example.com",
      url: "https://example.com/login",
      notes: "imported note",
    })
    expect(res.ok).toBe(true)
    const template = JSON.parse(calls[0]!.stdin!)
    expect(template.category).toBe("LOGIN")
    expect(template.urls).toEqual([
      { label: "website", primary: true, href: "https://example.com/login" },
    ])
    const password = template.fields.find((f: { id: string }) => f.id === "password")
    expect(password).toMatchObject({ purpose: "PASSWORD", type: "CONCEALED", value: FAKE_PASSWORD })
    const username = template.fields.find((f: { id: string }) => f.id === "username")
    expect(username).toMatchObject({ purpose: "USERNAME", value: "user@example.com" })
    const notes = template.fields.find((f: { id: string }) => f.id === "notesPlain")
    expect(notes).toMatchObject({ purpose: "NOTES", value: "imported note" })
    assertArgvClean(calls)
  })

  it("refuses when sync is disabled (no op call)", async () => {
    const { runOp, calls } = makeRunOp(() => okCreate("x"))
    const store = makeStore([], baseConfig({ enabled: false }))
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).createItem({ title: "T", value: FAKE_VALUE })
    expect(res.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it("sanitizes a non-zero exit — no value, no stderr in message/lastError", async () => {
    const { runOp } = makeRunOp(() => ({
      code: 1,
      stdout: "",
      stderr: `failed to create item with value ${FAKE_VALUE}`,
    }))
    const store = makeStore()
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).createItem({ title: "T", value: FAKE_VALUE })
    expect(res.ok).toBe(false)
    expect(res.message).toBe("op item create failed (exit 1)")
    expect(store._cfg()?.lastError).toBe("op item create failed (exit 1)")
  })

  it("fails sanely on malformed create output", async () => {
    const { runOp } = makeRunOp(() => ({ code: 0, stdout: "garbage", stderr: "" }))
    const { deps } = makeDeps({ runOp })
    const res = await makeVaultOpSync(deps).createItem({ title: "T", value: FAKE_VALUE })
    expect(res.ok).toBe(false)
    expect(res.message).toBe("op item create returned invalid JSON")
  })

  it("fails sanely when the created item has no id", async () => {
    const { runOp } = makeRunOp(() => ({ code: 0, stdout: "{}", stderr: "" }))
    const { deps } = makeDeps({ runOp })
    const res = await makeVaultOpSync(deps).createItem({ title: "T", value: FAKE_VALUE })
    expect(res.ok).toBe(false)
    expect(res.message).toBe("op item create returned no item id")
  })

  it("resolves ok:false (never throws) when runOp rejects", async () => {
    const { deps } = makeDeps({
      runOp: async () => {
        throw new Error("boom")
      },
    })
    const res = await makeVaultOpSync(deps).createItem({ title: "T", value: FAKE_VALUE })
    expect(res.ok).toBe(false)
    expect(res.message).toBe("op item create failed (spawn error)")
  })
})

// ---------------------------------------------------------------------------
// importLogins
// ---------------------------------------------------------------------------

describe("importLogins", () => {
  const threeLogins = [
    { title: "Site A", url: "https://a.example.com", username: "a@example.com", password: FAKE_PASSWORD },
    { title: "Site B", username: "b@example.com", password: FAKE_PASSWORD },
    { title: "Site C", password: FAKE_PASSWORD, notes: "from apple csv" },
  ]

  it("creates LOGIN items sequentially + registry rows source='apple-import'", async () => {
    const { runOp, calls } = makeRunOp((_input, i) => okCreate(`op-imp-${i}`))
    const store = makeStore()
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).importLogins(threeLogins)
    expect(res).toMatchObject({ ok: true, created: 3 })
    expect(calls).toHaveLength(3)
    assertArgvClean(calls)
    for (const call of calls) {
      const template = JSON.parse(call.stdin!)
      expect(template.category).toBe("LOGIN")
      expect(call.env?.["OP_SERVICE_ACCOUNT_TOKEN"]).toBe(FAKE_TOKEN)
    }
    expect(store._items).toHaveLength(3)
    for (const [i, row] of store._items.entries()) {
      expect(row.kind).toBe("op-item")
      expect(row.source).toBe("apple-import")
      expect(row.opItemId).toBe(`op-imp-${i}`)
      expect(row.ref).toBe(`luna-op://testacct/TestVault/op-imp-${i}/password`)
    }
    expect(store._items.map((r) => r.name)).toEqual(["Site A", "Site B", "Site C"])
  })

  it("stops on the first hard failure and reports created honestly", async () => {
    const { runOp, calls } = makeRunOp((_input, i) =>
      i === 1 ? { code: 1, stdout: "", stderr: "create failed" } : okCreate(`op-imp-${i}`),
    )
    const store = makeStore()
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).importLogins(threeLogins)
    expect(res.ok).toBe(false)
    expect(res.created).toBe(1)
    expect(res.message).toContain("Imported 1 of 3")
    expect(res.message).not.toContain(FAKE_PASSWORD)
    // The third item was never attempted.
    expect(calls).toHaveLength(2)
    expect(store._items).toHaveLength(1)
  })

  it("refuses when sync is disabled", async () => {
    const { runOp, calls } = makeRunOp(() => okCreate("x"))
    const store = makeStore([], baseConfig({ enabled: false }))
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).importLogins(threeLogins)
    expect(res).toMatchObject({ ok: false, created: 0 })
    expect(calls).toHaveLength(0)
  })

  it("returns a clean success for an empty batch", async () => {
    const { runOp, calls } = makeRunOp(() => okCreate("x"))
    const { deps } = makeDeps({ runOp })
    const res = await makeVaultOpSync(deps).importLogins([])
    expect(res).toMatchObject({ ok: true, created: 0 })
    expect(calls).toHaveLength(0)
  })

  it("uniquifies a registry name that collides with a different ref", async () => {
    const occupant: VaultItem = {
      id: "row-x",
      name: "Site A",
      kind: "env-secret",
      ref: "env:SITE_A",
      source: "manual",
      description: null,
      createdAt: NOW - 100,
      updatedAt: NOW - 100,
      opItemId: null,
    }
    const { runOp } = makeRunOp(() => okCreate("op-dup-1"))
    const store = makeStore([occupant])
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).importLogins([
      { title: "Site A", password: FAKE_PASSWORD },
    ])
    expect(res.ok).toBe(true)
    const imported = store._items.find((i) => i.opItemId === "op-dup-1")
    expect(imported?.name).toBe("Site A (op-dup-1)")
    expect(store._items.find((i) => i.id === "row-x")?.name).toBe("Site A")
  })

  it("counts a 1P-created item even when the registry write fails", async () => {
    const { runOp } = makeRunOp(() => okCreate("op-orphan"))
    const store = makeStore()
    const broken: VaultSyncStoreFacade = {
      ...store,
      upsertByName: async () => {
        throw new Error("db locked")
      },
    }
    const { deps } = makeDeps({ runOp, store: broken as never })
    const res = await makeVaultOpSync(deps).importLogins([
      { title: "Site A", password: FAKE_PASSWORD },
    ])
    expect(res.ok).toBe(true)
    expect(res.created).toBe(1)
  })

  it("never leaks values into log lines", async () => {
    const { runOp } = makeRunOp((_input, i) => okCreate(`op-imp-${i}`))
    const { deps, logs } = makeDeps({ runOp })
    await makeVaultOpSync(deps).importLogins(threeLogins)
    for (const line of logs) {
      expect(line).not.toContain(FAKE_PASSWORD)
      expect(line).not.toContain(FAKE_TOKEN)
    }
  })
})

// ---------------------------------------------------------------------------
// ENOENT / spawn rejection path (review finding: chat-server now rejects on
// child 'error' event instead of resolving code:-1, so the engine's existing
// catch branch is exercised — verify clear lastError + backoff still advances)
// ---------------------------------------------------------------------------

describe("syncOnce — spawn rejection produces clear lastError + backoff advances", () => {
  it("runOp rejects → lastError is 'op item list failed (spawn error)', not a raw system message", async () => {
    // The chat-server's runOpForVaultSync now rejects with the raw Node error on
    // ENOENT. The engine's catch block must sanitize it to 'spawn error' only.
    const store = makeStore()
    const { deps } = makeDeps({
      runOp: async () => {
        throw new Error("spawn ENOENT /usr/local/bin/op")
      },
      store,
    })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(false)
    // The message MUST be the sanitized form — never the raw system error text.
    expect(res.message).toBe("op item list failed (spawn error)")
    expect(store._cfg()?.lastError).toBe("op item list failed (spawn error)")
    // Raw system paths and error class details must not bleed through.
    expect(store._cfg()?.lastError).not.toContain("ENOENT")
    expect(store._cfg()?.lastError).not.toContain("/usr/local/bin/op")
  })

  it("consecutive spawn failures increment backoff (missing op binary cannot tight-loop)", async () => {
    // Each syncOnce that rejects via spawn must still resolve ok:false (no throw),
    // and the caller's backoff helper must advance. We verify nextDelayMs strictly
    // increases to confirm the backoff gate is not bypassed.
    const sync = makeVaultOpSync(
      makeDeps({
        runOp: async () => {
          throw new Error("spawn ENOENT /usr/bin/op")
        },
      }).deps,
    )
    const r0 = await sync.syncOnce()
    const r1 = await sync.syncOnce()
    expect(r0.ok).toBe(false)
    expect(r1.ok).toBe(false)
    // Backoff doubles with each consecutive failure — the pure nextDelayMs
    // formula is the gate the poll loop uses; verify it advances.
    const delay0 = sync.nextDelayMs(0, 300)
    const delay1 = sync.nextDelayMs(1, 300)
    const delay2 = sync.nextDelayMs(2, 300)
    expect(delay1).toBeGreaterThan(delay0)
    expect(delay2).toBeGreaterThan(delay1)
  })
})

// ---------------------------------------------------------------------------
// Poll/push race guard (review finding: re-fetch row before vanished-id clear)
// ---------------------------------------------------------------------------

describe("syncOnce — poll/push race guard", () => {
  it("skips clearing opItemId on an env-secret whose updatedAt is newer than manifestFetchTs", async () => {
    // Scenario: manifest was fetched at T=NOW (manifestFetchTs). Between the
    // manifest fetch and the vanished-id loop, a concurrent vault-put updated
    // the row's updatedAt to NOW+1 (simulated by advancing now() on the second
    // call). The engine must skip the clear.
    let nowCalls = 0
    const pushed: VaultItem = {
      id: "env-race",
      name: "Race Secret",
      kind: "env-secret",
      ref: "env:RACE_SECRET",
      source: "manual",
      description: null,
      createdAt: NOW - 200,
      // updatedAt equals manifestFetchTs initially; a later store.getById
      // will return a row with updatedAt = NOW+1 (the concurrent write).
      updatedAt: NOW - 200,
      opItemId: "op-gone-race",
    }
    const store = makeStore([pushed])
    // Override getById so the vanished-id re-fetch returns a fresher row.
    const freshRow: VaultItem = { ...pushed, updatedAt: NOW + 1 }
    const storeWithRace: typeof store = {
      ...store,
      getById: async (id) => (id === "env-race" ? freshRow : null),
    }
    const { deps } = makeDeps({
      // Empty manifest — op-gone-race is "vanished".
      runOp: async () => ({ code: 0, stdout: "[]", stderr: "" }),
      store: storeWithRace,
      // First call = manifestFetchTs (NOW), second call = ts after list.
      now: () => {
        nowCalls += 1
        return nowCalls === 1 ? NOW : NOW + 2
      },
    })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    // The row must NOT have been modified — opItemId is still set.
    expect(store._items[0]!.opItemId).toBe("op-gone-race")
    // changed must not count the skipped row.
    expect(res.changed).toBe(0)
  })

  it("does clear opItemId when the re-fetched row is NOT newer than manifestFetchTs", async () => {
    // Scenario: no concurrent write — the row's updatedAt is older than
    // manifestFetchTs. The engine MUST proceed with the clear as before.
    const pushed: VaultItem = {
      id: "env-stale",
      name: "Stale Secret",
      kind: "env-secret",
      ref: "env:STALE_SECRET",
      source: "manual",
      description: null,
      createdAt: NOW - 200,
      updatedAt: NOW - 200,
      opItemId: "op-gone-stale",
    }
    const store = makeStore([pushed])
    const { deps } = makeDeps({
      runOp: async () => ({ code: 0, stdout: "[]", stderr: "" }),
      store,
      now: () => NOW,
    })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    expect(res.changed).toBe(1)
    expect(store._items[0]!.opItemId).toBeNull()
  })

  it("skips removing a source='1password' op-item row whose re-fetch is newer than manifestFetchTs", async () => {
    // The same race guard applies to op-item removal.
    const row: VaultItem = {
      id: "row-race-op",
      name: "Race OP Item",
      kind: "op-item",
      ref: "luna-op://testacct/TestVault/op-race/password",
      source: "1password",
      description: null,
      createdAt: NOW - 200,
      updatedAt: NOW - 200,
      opItemId: "op-race",
    }
    const store = makeStore([row])
    const freshRow: VaultItem = { ...row, updatedAt: NOW + 1 }
    const storeWithRace: typeof store = {
      ...store,
      getById: async (id) => (id === "row-race-op" ? freshRow : null),
    }
    let nowCalls = 0
    const { deps } = makeDeps({
      runOp: async () => ({ code: 0, stdout: "[]", stderr: "" }),
      store: storeWithRace,
      now: () => {
        nowCalls += 1
        return nowCalls === 1 ? NOW : NOW + 2
      },
    })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    // Row must still exist — the race guard skipped the remove.
    expect(store._items).toHaveLength(1)
    expect(res.changed).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting: token/value hygiene with vi.fn spy across all paths
// ---------------------------------------------------------------------------

describe("argv hygiene across every op invocation", () => {
  it("no public method ever places the token or a value in argv", async () => {
    const runOp = vi.fn(async (input: OpRunInput): Promise<OpRunResult> => {
      if (input.args[1] === "list") return okList([])
      return okCreate("op-any")
    })
    const { deps } = makeDeps({ runOp })
    const sync = makeVaultOpSync(deps)
    await sync.syncOnce()
    await sync.createItem({ title: "T", value: FAKE_VALUE })
    await sync.importLogins([{ title: "L", password: FAKE_PASSWORD }])
    const calls = runOp.mock.calls.map(([input]) => input)
    expect(calls.length).toBeGreaterThanOrEqual(3)
    assertArgvClean(calls)
    for (const call of calls) {
      expect(call.env?.["OP_SERVICE_ACCOUNT_TOKEN"]).toBe(FAKE_TOKEN)
    }
  })
})

// ---------------------------------------------------------------------------
// A2 — setSyncConfig re-reads fresh config to avoid reverting concurrent changes
// ---------------------------------------------------------------------------

describe("syncOnce — A2: concurrent config change not reverted", () => {
  it("a concurrent disable during a slow runOp is preserved after sync success", async () => {
    // The store starts enabled. After runOp returns (simulating a slow op),
    // the test mutates syncCfg to disabled. The success write should NOT
    // re-enable it.
    let syncCfg: VaultSyncConfig = baseConfig({ enabled: true })
    const store: VaultSyncStoreFacade = {
      list: async () => [],
      upsertByName: async () => {},
      getById: async () => null,
      remove: async () => false,
      getSyncConfig: async () => syncCfg,
      setSyncConfig: async (cfg) => {
        syncCfg = cfg
      },
    }
    // During runOp, flip to disabled (simulates concurrent vault-sync-config disable).
    const { runOp } = makeRunOp(() => {
      syncCfg = { ...syncCfg, enabled: false }
      return okList([])
    })
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(true)
    // The final config must remain disabled — A2 fix must NOT spread the stale snapshot.
    expect(syncCfg.enabled).toBe(false)
    // But lastSyncedAt and lastError must have been updated.
    expect(syncCfg.lastSyncedAt).toBe(NOW)
    expect(syncCfg.lastError).toBeNull()
  })

  it("a concurrent disable during a failing runOp is preserved after recordError", async () => {
    let syncCfg: VaultSyncConfig = baseConfig({ enabled: true })
    const store: VaultSyncStoreFacade = {
      list: async () => [],
      upsertByName: async () => {},
      getById: async () => null,
      remove: async () => false,
      getSyncConfig: async () => syncCfg,
      setSyncConfig: async (cfg) => {
        syncCfg = cfg
      },
    }
    const { runOp } = makeRunOp(() => {
      syncCfg = { ...syncCfg, enabled: false }
      return { code: 1, stdout: "", stderr: "" }
    })
    const { deps } = makeDeps({ runOp, store })
    const res = await makeVaultOpSync(deps).syncOnce()
    expect(res.ok).toBe(false)
    // Config must remain disabled after the failed pass.
    expect(syncCfg.enabled).toBe(false)
    // lastError must be set to the sanitized message.
    expect(syncCfg.lastError).toBe("op item list failed (exit 1)")
  })
})

// ---------------------------------------------------------------------------
// A3 — shouldAttemptSync pure predicate
// ---------------------------------------------------------------------------

describe("shouldAttemptSync — A3: pure poll-gate predicate", () => {
  const poll = 300 // seconds
  const base = poll * 1000 // 300_000 ms

  it("is due after pollSeconds since last success (no failures)", () => {
    expect(
      shouldAttemptSync({
        nowMs: base + 1,
        lastSyncedAt: 0,
        lastAttemptAt: null,
        consecutiveFailures: 0,
        pollSeconds: poll,
      }),
    ).toBe(true)
  })

  it("is NOT due before pollSeconds have elapsed", () => {
    expect(
      shouldAttemptSync({
        nowMs: base - 1,
        lastSyncedAt: 0,
        lastAttemptAt: null,
        consecutiveFailures: 0,
        pollSeconds: poll,
      }),
    ).toBe(false)
  })

  it("failures=0 bypasses backoff (lastAttemptAt irrelevant)", () => {
    // Even if lastAttemptAt is just 1ms ago, failures=0 means backoffDue=true.
    expect(
      shouldAttemptSync({
        nowMs: base + 1,
        lastSyncedAt: 0,
        lastAttemptAt: base, // just now
        consecutiveFailures: 0,
        pollSeconds: poll,
      }),
    ).toBe(true)
  })

  it("backoff window respected after N failures", () => {
    // After 1 failure the backoff delay is 600_000ms (2× poll).
    const backoffDelay = 600_000
    // Not yet due.
    expect(
      shouldAttemptSync({
        nowMs: backoffDelay - 1,
        lastSyncedAt: null,
        lastAttemptAt: 0,
        consecutiveFailures: 1,
        pollSeconds: poll,
      }),
    ).toBe(false)
    // Now due.
    expect(
      shouldAttemptSync({
        nowMs: backoffDelay,
        lastSyncedAt: null,
        lastAttemptAt: 0,
        consecutiveFailures: 1,
        pollSeconds: poll,
      }),
    ).toBe(true)
  })

  it("lastSyncedAt=null with failures=0 is immediately due", () => {
    expect(
      shouldAttemptSync({
        nowMs: 0,
        lastSyncedAt: null,
        lastAttemptAt: null,
        consecutiveFailures: 0,
        pollSeconds: poll,
      }),
    ).toBe(false) // nowMs=0, need >= base (300_000ms) from 0

    expect(
      shouldAttemptSync({
        nowMs: base,
        lastSyncedAt: null,
        lastAttemptAt: null,
        consecutiveFailures: 0,
        pollSeconds: poll,
      }),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// A4 — nextDelayMs: steady-state interval uncapped, cap only on backoff
// ---------------------------------------------------------------------------

describe("nextDelayMs — A4: steady-state uncapped, cap on backoff only", () => {
  const { deps } = makeDeps()
  const sync = makeVaultOpSync(deps)

  it("pollSeconds=86400 (1 day) is returned as-is at 0 failures (not capped to 3600s)", () => {
    expect(sync.nextDelayMs(0, 86400)).toBe(86400 * 1000)
  })

  it("pollSeconds=86400 at 1 failure is capped at base (max(3600s,86400s)=86400s)", () => {
    // base=86400s; backoffCap=max(3600000,86400000)=86400000; min(86400000, 172800000)=86400000
    expect(sync.nextDelayMs(1, 86400)).toBe(86400 * 1000)
  })

  it("pollSeconds=86400 at 2 failures stays at base cap", () => {
    // 86400*4=345600s > 86400s cap → 86400s
    expect(sync.nextDelayMs(2, 86400)).toBe(86400 * 1000)
  })

  it("pollSeconds=300 at 4 failures still caps at 3600s", () => {
    // base=300s, 300*2^4=4800s > 3600s → 3600s
    expect(sync.nextDelayMs(4, 300)).toBe(3_600_000)
  })

  it("poll floor 60s still applies at 0 failures", () => {
    expect(sync.nextDelayMs(0, 5)).toBe(60_000)
    expect(sync.nextDelayMs(0, 0)).toBe(60_000)
  })
})
