/**
 * makeVaultMutations tests.
 *
 * Load-bearing claims:
 *   - put validates name length (1..64)
 *   - put routes through registerSecret for grammar + storage; registry row
 *     is only upserted on success
 *   - put returns restartNeeded=true only for op-token
 *   - remove looks up by id; env-secret → removeEnvSecret, op-token →
 *     deleteOpToken, op-item → registry-only (no delete primitive called)
 *   - remove returns ok:false for unknown id
 *   - NEVER throws (every failure path resolves to {ok:false})
 *   - NEVER logs or returns a secret value
 *   - recordCapture humanizes varNames and back-fills the registry
 */
import { describe, expect, it, vi } from "vitest"
import {
  makeVaultMutations,
  humanizeName,
  type VaultMutationDeps,
  type VaultStoreFacade,
} from "../src/mutations.js"
import type { VaultItem } from "../src/types.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FAKE_TOKEN = "ops_test_token_fake"
const FAKE_ENV_VALUE = "sk-fake-env-value-for-tests"

/** In-memory VaultStoreFacade. */
const makeStore = (seed: VaultItem[] = []): VaultStoreFacade & { _items: VaultItem[] } => {
  const items: VaultItem[] = [...seed]
  return {
    _items: items,
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
  }
}

/** Happy-path deps factory; override per-test as needed. */
const makeDeps = (
  overrides: Partial<VaultMutationDeps> = {},
  storeSeed: VaultItem[] = [],
): {
  deps: VaultMutationDeps
  store: ReturnType<typeof makeStore>
  registerSecret: ReturnType<typeof vi.fn>
  removeEnvSecret: ReturnType<typeof vi.fn>
  deleteOpToken: ReturnType<typeof vi.fn>
  logs: string[]
} => {
  const store = makeStore(storeSeed)
  const registerSecret = vi.fn(async () => ({ ok: true, message: "Stored." }))
  const removeEnvSecret = vi.fn(async () => {})
  const deleteOpToken = vi.fn(async () => {})
  const logs: string[] = []

  const deps: VaultMutationDeps = {
    registerSecret,
    removeEnvSecret,
    deleteOpToken,
    store,
    now: () => 1_000_000,
    log: (msg) => logs.push(msg),
    ...overrides,
  }
  return { deps, store, registerSecret, removeEnvSecret, deleteOpToken, logs }
}

// ---------------------------------------------------------------------------
// put — name validation
// ---------------------------------------------------------------------------

describe("put — name validation", () => {
  it("rejects an empty name", async () => {
    const { deps } = makeDeps()
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({ name: "   ", kind: "env-secret", varName: "FOO", value: FAKE_ENV_VALUE })
    expect(res.ok).toBe(false)
    expect(res.message).toContain("1 and 64")
  })

  it("rejects a name longer than 64 chars", async () => {
    const { deps } = makeDeps()
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "A".repeat(65),
      kind: "env-secret",
      varName: "FOO",
      value: FAKE_ENV_VALUE,
    })
    expect(res.ok).toBe(false)
  })

  it("accepts a name of exactly 64 chars", async () => {
    const { deps, registerSecret } = makeDeps()
    registerSecret.mockResolvedValueOnce({ ok: true, message: "Stored." })
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "A".repeat(64),
      kind: "env-secret",
      varName: "FOO",
      value: FAKE_ENV_VALUE,
    })
    expect(res.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// put — env-secret
// ---------------------------------------------------------------------------

describe("put — env-secret", () => {
  it("calls registerSecret and upserts the registry row on success", async () => {
    const { deps, store, registerSecret } = makeDeps()
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "My Api Key",
      kind: "env-secret",
      varName: "MY_API_KEY",
      value: FAKE_ENV_VALUE,
    })
    expect(res.ok).toBe(true)
    expect(res.restartNeeded).toBe(false)
    expect(registerSecret).toHaveBeenCalledWith(
      { kind: "env-secret", varName: "MY_API_KEY" },
      FAKE_ENV_VALUE,
    )
    expect(store._items).toHaveLength(1)
    expect(store._items[0]?.ref).toBe("env:MY_API_KEY")
    expect(store._items[0]?.source).toBe("manual")
  })

  it("does NOT upsert registry when registerSecret returns ok:false", async () => {
    const { deps, store, registerSecret } = makeDeps()
    registerSecret.mockResolvedValueOnce({ ok: false, message: "Invalid var name." })
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "Bad Var",
      kind: "env-secret",
      varName: "bad=var",
      value: FAKE_ENV_VALUE,
    })
    expect(res.ok).toBe(false)
    expect(store._items).toHaveLength(0)
  })

  it("returns ok:false (opaque) and does not upsert when registerSecret throws", async () => {
    const { deps, store } = makeDeps({
      registerSecret: async () => { throw new Error("boom") },
    })
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({ name: "X", kind: "env-secret", varName: "X", value: FAKE_ENV_VALUE })
    expect(res.ok).toBe(false)
    expect(store._items).toHaveLength(0)
  })

  it("rejects env-secret when varName is missing", async () => {
    const { deps } = makeDeps()
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({ name: "Foo", kind: "env-secret", value: FAKE_ENV_VALUE })
    expect(res.ok).toBe(false)
    expect(res.message).toContain("varName")
  })
})

// ---------------------------------------------------------------------------
// put — op-token
// ---------------------------------------------------------------------------

describe("put — op-token", () => {
  it("calls registerSecret and upserts registry; restartNeeded=true", async () => {
    const { deps, store, registerSecret } = makeDeps()
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "1Password Primary",
      kind: "op-token",
      label: "primary",
      value: FAKE_TOKEN,
    })
    expect(res.ok).toBe(true)
    expect(res.restartNeeded).toBe(true)
    expect(registerSecret).toHaveBeenCalledWith({ kind: "op-token", label: "primary" }, FAKE_TOKEN)
    expect(store._items[0]?.ref).toBe("luna-op://primary")
  })

  it("rejects op-token when label is missing", async () => {
    const { deps } = makeDeps()
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({ name: "Foo", kind: "op-token", value: FAKE_TOKEN })
    expect(res.ok).toBe(false)
    expect(res.message).toContain("label")
  })
})

// ---------------------------------------------------------------------------
// put — op-item (not writable via vault-put)
// ---------------------------------------------------------------------------

describe("put — op-item", () => {
  it("returns ok:false explaining op-item is sync-only", async () => {
    const { deps } = makeDeps()
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({ name: "Foo", kind: "op-item", value: FAKE_TOKEN })
    expect(res.ok).toBe(false)
    expect(res.message).toContain("sync")
  })
})

// ---------------------------------------------------------------------------
// put — never logs the secret value
// ---------------------------------------------------------------------------

describe("put — never-log contract", () => {
  it("does not include the secret value in any log line", async () => {
    const { deps, logs } = makeDeps()
    const mutations = makeVaultMutations(deps)
    await mutations.put({ name: "Key", kind: "env-secret", varName: "SOME_KEY", value: FAKE_ENV_VALUE })
    for (const line of logs) {
      expect(line).not.toContain(FAKE_ENV_VALUE)
    }
  })
})

// ---------------------------------------------------------------------------
// remove — env-secret
// ---------------------------------------------------------------------------

describe("remove — env-secret", () => {
  const existingEnvItem: VaultItem = {
    id: "env-item-1",
    name: "Openai Key",
    kind: "env-secret",
    ref: "env:OPENAI_API_KEY",
    source: "manual",
    description: null,
    createdAt: 100,
    updatedAt: 100,
    opItemId: null,
  }

  it("calls removeEnvSecret and removes the registry row", async () => {
    const { deps, store, removeEnvSecret } = makeDeps({}, [existingEnvItem])
    const mutations = makeVaultMutations(deps)
    const res = await mutations.remove("env-item-1")
    expect(res.ok).toBe(true)
    expect(res.restartNeeded).toBe(false)
    expect(removeEnvSecret).toHaveBeenCalledWith("OPENAI_API_KEY")
    expect(store._items).toHaveLength(0)
  })

  it("returns ok:false (opaque) when removeEnvSecret throws", async () => {
    const { deps, store } = makeDeps(
      { removeEnvSecret: async () => { throw new Error("fs error") } },
      [existingEnvItem],
    )
    const mutations = makeVaultMutations(deps)
    const res = await mutations.remove("env-item-1")
    expect(res.ok).toBe(false)
    // Registry row must NOT have been deleted (remove was aborted before store.remove).
    expect(store._items).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// remove — op-token
// ---------------------------------------------------------------------------

describe("remove — op-token", () => {
  const existingOpItem: VaultItem = {
    id: "op-item-1",
    name: "Primary Token",
    kind: "op-token",
    ref: "luna-op://primary",
    source: "manual",
    description: null,
    createdAt: 100,
    updatedAt: 100,
    opItemId: null,
  }

  it("calls deleteOpToken, removes registry row, restartNeeded=true", async () => {
    const { deps, store, deleteOpToken } = makeDeps({}, [existingOpItem])
    const mutations = makeVaultMutations(deps)
    const res = await mutations.remove("op-item-1")
    expect(res.ok).toBe(true)
    expect(res.restartNeeded).toBe(true)
    expect(deleteOpToken).toHaveBeenCalledWith("primary")
    expect(store._items).toHaveLength(0)
  })

  it("returns ok:false (opaque) when deleteOpToken throws", async () => {
    const { deps, store } = makeDeps(
      { deleteOpToken: async () => { throw new Error("keychain locked") } },
      [existingOpItem],
    )
    const mutations = makeVaultMutations(deps)
    const res = await mutations.remove("op-item-1")
    expect(res.ok).toBe(false)
    expect(store._items).toHaveLength(1) // row not removed
  })
})

// ---------------------------------------------------------------------------
// remove — op-item (registry-only, never calls a delete primitive)
// ---------------------------------------------------------------------------

describe("remove — op-item", () => {
  const existingOpVaultItem: VaultItem = {
    id: "opv-item-1",
    name: "Github Token",
    kind: "op-item",
    ref: "luna-op://primary/Personal/item123/credential",
    source: "1password",
    description: null,
    createdAt: 100,
    updatedAt: 100,
    opItemId: "item123",
  }

  it("removes registry row only — no delete primitives called", async () => {
    const { deps, store, removeEnvSecret, deleteOpToken } = makeDeps({}, [existingOpVaultItem])
    const mutations = makeVaultMutations(deps)
    const res = await mutations.remove("opv-item-1")
    expect(res.ok).toBe(true)
    expect(res.restartNeeded).toBe(false)
    expect(removeEnvSecret).not.toHaveBeenCalled()
    expect(deleteOpToken).not.toHaveBeenCalled()
    expect(store._items).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// remove — unknown id
// ---------------------------------------------------------------------------

describe("remove — unknown id", () => {
  it("returns ok:false for an id not in the registry", async () => {
    const { deps } = makeDeps()
    const mutations = makeVaultMutations(deps)
    const res = await mutations.remove("does-not-exist")
    expect(res.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// never-throws contract
// ---------------------------------------------------------------------------

describe("never-throws contract", () => {
  it("put resolves to ok:false even when every dep throws", async () => {
    const deps: VaultMutationDeps = {
      registerSecret: async () => { throw new Error("boom") },
      removeEnvSecret: async () => { throw new Error("boom") },
      deleteOpToken: async () => { throw new Error("boom") },
      store: {
        list: async () => { throw new Error("boom") },
        upsertByName: async () => { throw new Error("boom") },
        getById: async () => { throw new Error("boom") },
        remove: async () => { throw new Error("boom") },
      },
      now: () => 0,
    }
    const mutations = makeVaultMutations(deps)
    await expect(
      mutations.put({ name: "X", kind: "env-secret", varName: "X", value: FAKE_ENV_VALUE }),
    ).resolves.toMatchObject({ ok: false })
  })

  it("remove resolves to ok:false even when every dep throws", async () => {
    const deps: VaultMutationDeps = {
      registerSecret: async () => ({ ok: true, message: "" }),
      removeEnvSecret: async () => { throw new Error("boom") },
      deleteOpToken: async () => { throw new Error("boom") },
      store: {
        list: async () => [],
        upsertByName: async () => {},
        getById: async () => { throw new Error("boom") },
        remove: async () => { throw new Error("boom") },
      },
      now: () => 0,
    }
    const mutations = makeVaultMutations(deps)
    await expect(mutations.remove("any-id")).resolves.toMatchObject({ ok: false })
  })
})

// ---------------------------------------------------------------------------
// recordCapture
// ---------------------------------------------------------------------------

describe("recordCapture", () => {
  it("humanizes varName and upserts a registry row with source=agent", async () => {
    const { deps, store } = makeDeps()
    const mutations = makeVaultMutations(deps)
    await mutations.recordCapture({ kind: "env-secret", varName: "NOTION_API_KEY", source: "agent" })
    expect(store._items).toHaveLength(1)
    expect(store._items[0]?.name).toBe("Notion Api Key")
    expect(store._items[0]?.ref).toBe("env:NOTION_API_KEY")
    expect(store._items[0]?.source).toBe("agent")
  })

  it("uses label as name for op-token captures", async () => {
    const { deps, store } = makeDeps()
    const mutations = makeVaultMutations(deps)
    await mutations.recordCapture({ kind: "op-token", label: "primary", source: "manual" })
    expect(store._items[0]?.name).toBe("primary")
    expect(store._items[0]?.ref).toBe("luna-op://primary")
  })

  it("is idempotent: second capture with same name updates, does not duplicate", async () => {
    const { deps, store } = makeDeps()
    const mutations = makeVaultMutations(deps)
    await mutations.recordCapture({ kind: "env-secret", varName: "MY_KEY", source: "agent" })
    await mutations.recordCapture({ kind: "env-secret", varName: "MY_KEY", source: "manual" })
    expect(store._items).toHaveLength(1)
    expect(store._items[0]?.source).toBe("manual")
  })

  it("silently ignores missing varName/label instead of throwing", async () => {
    const { deps } = makeDeps()
    const mutations = makeVaultMutations(deps)
    await expect(mutations.recordCapture({ kind: "env-secret", source: "agent" })).resolves.toBeUndefined()
    await expect(mutations.recordCapture({ kind: "op-token", source: "agent" })).resolves.toBeUndefined()
  })

  it("does not throw when store.upsertByName throws", async () => {
    const { deps } = makeDeps({
      store: {
        ...makeStore(),
        upsertByName: async () => { throw new Error("disk full") },
      },
    })
    const mutations = makeVaultMutations(deps)
    await expect(
      mutations.recordCapture({ kind: "env-secret", varName: "X", source: "agent" }),
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// put — registry-upsert-failure restartNeeded (Finding 3)
// ---------------------------------------------------------------------------

describe("put — registry-upsert-failure restartNeeded", () => {
  it("returns restartNeeded:false when env-secret backing write succeeds but registry upsert fails", async () => {
    const { deps } = makeDeps({
      store: {
        ...makeStore(),
        upsertByName: async () => { throw new Error("disk full") },
      },
    })
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "My Key",
      kind: "env-secret",
      varName: "MY_KEY",
      value: FAKE_ENV_VALUE,
    })
    expect(res.ok).toBe(false)
    expect(res.restartNeeded).toBe(false)
  })

  it("returns restartNeeded:true when op-token backing write succeeds but registry upsert fails", async () => {
    const { deps } = makeDeps({
      store: {
        ...makeStore(),
        upsertByName: async () => { throw new Error("disk full") },
      },
    })
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "1Password Token",
      kind: "op-token",
      label: "primary",
      value: FAKE_TOKEN,
    })
    expect(res.ok).toBe(false)
    // The backing op-token write already succeeded → restart is still needed.
    expect(res.restartNeeded).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// humanizeName (exported utility)
// ---------------------------------------------------------------------------

describe("humanizeName", () => {
  it("converts NOTION_API_KEY → 'Notion Api Key'", () => {
    expect(humanizeName("NOTION_API_KEY")).toBe("Notion Api Key")
  })

  it("handles a single segment", () => {
    expect(humanizeName("OPENAI")).toBe("Openai")
  })

  it("handles leading/trailing underscores gracefully", () => {
    expect(humanizeName("_FOO_BAR_")).toBe("Foo Bar")
  })
})

// ---------------------------------------------------------------------------
// Registry-consistency behaviors (post-review hardening)
// ---------------------------------------------------------------------------

const seedItem = (over: Partial<VaultItem>): VaultItem => ({
  id: "seed-id",
  name: "Seed",
  kind: "env-secret",
  ref: "env:SEED",
  source: "manual",
  description: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  opItemId: null,
  ...over,
})

describe("put — same-ref rename dedupe", () => {
  it("re-saving the same ref under a new name replaces the old row (preserving createdAt)", async () => {
    const { deps, store } = makeDeps({}, [
      seedItem({ id: "old", name: "Old Name", ref: "env:MY_KEY", createdAt: 42 }),
    ])
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "New Name",
      kind: "env-secret",
      varName: "MY_KEY",
      value: FAKE_ENV_VALUE,
    })
    expect(res.ok).toBe(true)
    expect(store._items).toHaveLength(1)
    expect(store._items[0]?.name).toBe("New Name")
    expect(store._items[0]?.ref).toBe("env:MY_KEY")
    expect(store._items[0]?.createdAt).toBe(42)
  })

  it("re-saving the same ref under the SAME name (case-insensitive) keeps one row", async () => {
    const { deps, store } = makeDeps({}, [
      seedItem({ id: "old", name: "My Key", ref: "env:MY_KEY", createdAt: 42 }),
    ])
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "my key",
      kind: "env-secret",
      varName: "MY_KEY",
      value: FAKE_ENV_VALUE,
    })
    expect(res.ok).toBe(true)
    expect(store._items).toHaveLength(1)
    expect(store._items[0]?.createdAt).toBe(42)
  })
})

describe("put — vault-path messages", () => {
  it("env-secret success says available immediately and never mentions turn-end restart", async () => {
    const { deps } = makeDeps()
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "Notion Key",
      kind: "env-secret",
      varName: "NOTION_API_KEY",
      value: FAKE_ENV_VALUE,
    })
    expect(res.ok).toBe(true)
    expect(res.message).toContain("env:NOTION_API_KEY")
    expect(res.message).toMatch(/immediately/i)
    expect(res.message).not.toMatch(/end of this turn/i)
  })

  it("op-token success says restarting", async () => {
    const { deps } = makeDeps()
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "Primary 1P",
      kind: "op-token",
      label: "primary",
      value: FAKE_TOKEN,
    })
    expect(res.ok).toBe(true)
    expect(res.message).toMatch(/restart/i)
    expect(res.restartNeeded).toBe(true)
  })
})

describe("remove — restartNeeded on partial-failure paths", () => {
  it("op-token: registry removal failure still reports restartNeeded (backing delete happened)", async () => {
    const base = makeStore([
      seedItem({ id: "t1", name: "primary", kind: "op-token", ref: "luna-op://primary" }),
    ])
    const { deps, deleteOpToken } = makeDeps({
      store: { ...base, remove: async () => { throw new Error("db locked") } },
    })
    const mutations = makeVaultMutations(deps)
    const res = await mutations.remove("t1")
    expect(deleteOpToken).toHaveBeenCalledWith("primary")
    expect(res.ok).toBe(false)
    expect(res.restartNeeded).toBe(true)
  })

  it("op-token: concurrent registry removal still reports restartNeeded", async () => {
    const base = makeStore([
      seedItem({ id: "t1", name: "primary", kind: "op-token", ref: "luna-op://primary" }),
    ])
    const { deps } = makeDeps({
      store: { ...base, remove: async () => false },
    })
    const mutations = makeVaultMutations(deps)
    const res = await mutations.remove("t1")
    expect(res.ok).toBe(false)
    expect(res.restartNeeded).toBe(true)
  })

  it("env-secret: registry removal failure stays restartNeeded=false", async () => {
    const base = makeStore([seedItem({ id: "e1", name: "Key", ref: "env:KEY" })])
    const { deps } = makeDeps({
      store: { ...base, remove: async () => { throw new Error("db locked") } },
    })
    const mutations = makeVaultMutations(deps)
    const res = await mutations.remove("e1")
    expect(res.ok).toBe(false)
    expect(res.restartNeeded).toBe(false)
  })
})

describe("recordCapture — collision safety", () => {
  it("same ref re-capture refreshes the existing row in place (keeps name + description)", async () => {
    const { deps, store } = makeDeps({}, [
      seedItem({
        id: "r1",
        name: "My Custom Name (MY_KEY)",
        ref: "env:MY_KEY",
        description: "operator note",
        source: "manual",
      }),
    ])
    const mutations = makeVaultMutations(deps)
    await mutations.recordCapture({ kind: "env-secret", varName: "MY_KEY", source: "agent" })
    expect(store._items).toHaveLength(1)
    expect(store._items[0]?.name).toBe("My Custom Name (MY_KEY)")
    expect(store._items[0]?.description).toBe("operator note")
    expect(store._items[0]?.source).toBe("agent")
  })

  it("name collision with a DIFFERENT ref uniquifies instead of clobbering", async () => {
    const { deps, store } = makeDeps({}, [
      seedItem({ id: "r1", name: "Github Token", ref: "env:GITHUB_TOKEN_2" }),
    ])
    const mutations = makeVaultMutations(deps)
    await mutations.recordCapture({ kind: "env-secret", varName: "GITHUB_TOKEN", source: "agent" })
    expect(store._items).toHaveLength(2)
    const names = store._items.map((i) => i.name).sort()
    expect(names).toEqual(["Github Token", "Github Token (GITHUB_TOKEN)"])
    const original = store._items.find((i) => i.name === "Github Token")
    expect(original?.ref).toBe("env:GITHUB_TOKEN_2")
  })
})

// ---------------------------------------------------------------------------
// A1 — put preserves opItemId on same-ref re-save
// ---------------------------------------------------------------------------

describe("put — A1: opItemId preserved on same-ref re-save", () => {
  it("re-saving an env-secret that was pushed to 1Password keeps opItemId", async () => {
    const existingWithOpId = seedItem({
      id: "s1",
      name: "Pushed Key",
      ref: "env:PUSHED_KEY",
      opItemId: "op-item-abc",
    })
    const { deps, store } = makeDeps({}, [existingWithOpId])
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "Pushed Key",
      kind: "env-secret",
      varName: "PUSHED_KEY",
      value: FAKE_ENV_VALUE,
    })
    expect(res.ok).toBe(true)
    expect(store._items).toHaveLength(1)
    expect(store._items[0]?.opItemId).toBe("op-item-abc")
  })

  it("new env-secret (no existing row) gets opItemId=null", async () => {
    const { deps, store } = makeDeps()
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "Brand New",
      kind: "env-secret",
      varName: "BRAND_NEW",
      value: FAKE_ENV_VALUE,
    })
    expect(res.ok).toBe(true)
    expect(store._items[0]?.opItemId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// A5 — reserved-name denylist in put and recordCapture
// ---------------------------------------------------------------------------

describe("put — A5: reserved-name denylist", () => {
  it("rejects UI_WS_TOKEN", async () => {
    const { deps } = makeDeps()
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "WS Token",
      kind: "env-secret",
      varName: "UI_WS_TOKEN",
      value: FAKE_ENV_VALUE,
    })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/reserved/i)
  })

  it("rejects LUNA_* names", async () => {
    const { deps } = makeDeps()
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "Luna Scheduler",
      kind: "env-secret",
      varName: "LUNA_SCHEDULER_V2_ENABLED",
      value: FAKE_ENV_VALUE,
    })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/reserved/i)
  })

  it("accepts a non-reserved env var", async () => {
    const { deps } = makeDeps()
    const mutations = makeVaultMutations(deps)
    const res = await mutations.put({
      name: "Notion Key",
      kind: "env-secret",
      varName: "NOTION_API_KEY",
      value: FAKE_ENV_VALUE,
    })
    expect(res.ok).toBe(true)
  })
})

describe("recordCapture — A5: reserved-name denylist", () => {
  it("silently skips UI_WS_TOKEN without adding a registry row", async () => {
    const { deps, store } = makeDeps()
    const mutations = makeVaultMutations(deps)
    await mutations.recordCapture({ kind: "env-secret", varName: "UI_WS_TOKEN", source: "agent" })
    expect(store._items).toHaveLength(0)
  })

  it("silently skips LUNA_* names without adding a registry row", async () => {
    const { deps, store } = makeDeps()
    const mutations = makeVaultMutations(deps)
    await mutations.recordCapture({ kind: "env-secret", varName: "LUNA_OP_ACCOUNTS", source: "agent" })
    expect(store._items).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// A6 — remove: honest message when item still exists in 1Password
// ---------------------------------------------------------------------------

describe("remove — A6: honest message on 1Password-backed items", () => {
  it("appends 1Password warning when row has opItemId set (locally-pushed env-secret)", async () => {
    const item = seedItem({
      id: "pushed-1",
      name: "Pushed Env",
      ref: "env:PUSHED_ENV",
      opItemId: "op-item-xyz",
      source: "manual",
    })
    const { deps } = makeDeps({}, [item])
    const mutations = makeVaultMutations(deps)
    const res = await mutations.remove("pushed-1")
    expect(res.ok).toBe(true)
    expect(res.message).toContain("1Password")
    expect(res.message).toContain("reappear")
  })

  it("appends 1Password warning when source='1password' (op-item row)", async () => {
    const item: VaultItem = {
      id: "op-adopted",
      name: "Github Token",
      kind: "op-item",
      ref: "luna-op://primary/Personal/item888/credential",
      source: "1password",
      description: null,
      createdAt: 1000,
      updatedAt: 1000,
      opItemId: "item888",
    }
    const { deps } = makeDeps({}, [item])
    const mutations = makeVaultMutations(deps)
    const res = await mutations.remove("op-adopted")
    expect(res.ok).toBe(true)
    expect(res.message).toContain("1Password")
  })

  it("does NOT append 1Password warning for a plain env-secret with no opItemId", async () => {
    const item = seedItem({ id: "plain-1", name: "Plain Env", ref: "env:PLAIN_ENV", opItemId: null, source: "manual" })
    const { deps } = makeDeps({}, [item])
    const mutations = makeVaultMutations(deps)
    const res = await mutations.remove("plain-1")
    expect(res.ok).toBe(true)
    expect(res.message).not.toContain("1Password")
  })
})
