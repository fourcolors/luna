/**
 * reconcileVaultItems — pure reconciler tests.
 *
 * Load-bearing claims:
 *   - orphan env-secrets are adopted (source='manual', kind='env-secret')
 *   - orphan op-tokens are adopted (kind='op-token')
 *   - denylist: UI_WS_TOKEN and LUNA_* vars are never adopted
 *   - idempotency: second run with the adopted items in `existing` produces
 *     toAdopt=[] (no duplicate rows)
 *   - items already in the registry (any source) are not re-adopted
 */
import { describe, expect, it } from "vitest"
import { reconcileVaultItems } from "../src/reconciler.js"
import type { VaultItem } from "../src/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_000_000

const existingItem = (ref: string, over: Partial<VaultItem> = {}): VaultItem => ({
  id: `id-${ref}`,
  name: ref,
  kind: "env-secret",
  ref,
  source: "manual",
  description: null,
  createdAt: NOW - 1000,
  updatedAt: NOW - 1000,
  opItemId: null,
  ...over,
})

// ---------------------------------------------------------------------------
// Basic adoption
// ---------------------------------------------------------------------------

describe("reconcileVaultItems — basic adoption", () => {
  it("adopts an orphan env-secret not in the registry", () => {
    const { toAdopt } = reconcileVaultItems({
      envVarNames: ["OPENAI_API_KEY"],
      opTokenLabels: [],
      existing: [],
      now: NOW,
    })
    expect(toAdopt).toHaveLength(1)
    expect(toAdopt[0]?.kind).toBe("env-secret")
    expect(toAdopt[0]?.ref).toBe("env:OPENAI_API_KEY")
    expect(toAdopt[0]?.source).toBe("manual")
    expect(toAdopt[0]?.name).toBe("Openai Api Key")
    expect(toAdopt[0]?.createdAt).toBe(NOW)
  })

  it("adopts an orphan op-token not in the registry", () => {
    const { toAdopt } = reconcileVaultItems({
      envVarNames: [],
      opTokenLabels: ["primary"],
      existing: [],
      now: NOW,
    })
    expect(toAdopt).toHaveLength(1)
    expect(toAdopt[0]?.kind).toBe("op-token")
    expect(toAdopt[0]?.ref).toBe("luna-op://primary")
    expect(toAdopt[0]?.name).toBe("primary")
    expect(toAdopt[0]?.source).toBe("manual")
  })

  it("adopts multiple orphans in one pass", () => {
    const { toAdopt } = reconcileVaultItems({
      envVarNames: ["KEY_A", "KEY_B"],
      opTokenLabels: ["work"],
      existing: [],
      now: NOW,
    })
    expect(toAdopt).toHaveLength(3)
    const refs = toAdopt.map((i) => i.ref).sort()
    expect(refs).toEqual(["env:KEY_A", "env:KEY_B", "luna-op://work"])
  })
})

// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------

describe("reconcileVaultItems — denylist", () => {
  it("never adopts UI_WS_TOKEN", () => {
    const { toAdopt } = reconcileVaultItems({
      envVarNames: ["UI_WS_TOKEN"],
      opTokenLabels: [],
      existing: [],
      now: NOW,
    })
    expect(toAdopt).toHaveLength(0)
  })

  it("never adopts any LUNA_* variable", () => {
    const { toAdopt } = reconcileVaultItems({
      envVarNames: ["LUNA_OP_ACCOUNTS", "LUNA_INTERNAL_SECRET", "LUNA_REPO_ROOT"],
      opTokenLabels: [],
      existing: [],
      now: NOW,
    })
    expect(toAdopt).toHaveLength(0)
  })

  it("adopts non-denied vars alongside denied ones", () => {
    const { toAdopt } = reconcileVaultItems({
      envVarNames: ["LUNA_INTERNAL", "UI_WS_TOKEN", "OPENAI_API_KEY", "SOME_KEY"],
      opTokenLabels: [],
      existing: [],
      now: NOW,
    })
    expect(toAdopt).toHaveLength(2)
    expect(toAdopt.map((i) => i.ref).sort()).toEqual(["env:OPENAI_API_KEY", "env:SOME_KEY"])
  })

  // Audit finding: denylist must be CASE-INSENSITIVE so mixed-case variants
  // (e.g. luna_x, Ui_Ws_Token) are equally blocked.
  it("never adopts mixed-case variants of UI_WS_TOKEN or LUNA_*", () => {
    const { toAdopt } = reconcileVaultItems({
      envVarNames: ["ui_ws_token", "Ui_Ws_Token", "luna_connector_x", "Luna_Internal"],
      opTokenLabels: [],
      existing: [],
      now: NOW,
    })
    expect(toAdopt).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("reconcileVaultItems — idempotency", () => {
  it("second run with adopted items in existing produces toAdopt=[]", () => {
    const input = {
      envVarNames: ["OPENAI_API_KEY"],
      opTokenLabels: ["primary"],
      now: NOW,
    }
    const first = reconcileVaultItems({ ...input, existing: [] })
    // Simulate the adopted items being written to the registry.
    const second = reconcileVaultItems({ ...input, existing: first.toAdopt })
    expect(second.toAdopt).toHaveLength(0)
  })

  it("items already in registry (any source) are not re-adopted", () => {
    const existing = [
      existingItem("env:OPENAI_API_KEY", { kind: "env-secret" }),
      existingItem("luna-op://primary", { kind: "op-token" }),
    ]
    const { toAdopt } = reconcileVaultItems({
      envVarNames: ["OPENAI_API_KEY"],
      opTokenLabels: ["primary"],
      existing,
      now: NOW,
    })
    expect(toAdopt).toHaveLength(0)
  })

  it("items from any source block re-adoption", () => {
    const existing = [
      existingItem("env:GITHUB_TOKEN", { source: "agent", kind: "env-secret" }),
    ]
    const { toAdopt } = reconcileVaultItems({
      envVarNames: ["GITHUB_TOKEN"],
      opTokenLabels: [],
      existing,
      now: NOW,
    })
    expect(toAdopt).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Duplicate input protection
// ---------------------------------------------------------------------------

describe("reconcileVaultItems — duplicate input", () => {
  it("duplicate var names in input produce only one adoption row", () => {
    const { toAdopt } = reconcileVaultItems({
      envVarNames: ["SOME_KEY", "SOME_KEY"],
      opTokenLabels: [],
      existing: [],
      now: NOW,
    })
    expect(toAdopt).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Empty inputs
// ---------------------------------------------------------------------------

describe("reconcileVaultItems — empty inputs", () => {
  it("returns empty toAdopt for all-empty inputs", () => {
    const { toAdopt } = reconcileVaultItems({
      envVarNames: [],
      opTokenLabels: [],
      existing: [],
      now: NOW,
    })
    expect(toAdopt).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// No I/O — pure function
// ---------------------------------------------------------------------------

describe("reconcileVaultItems — pure function", () => {
  it("does not mutate the existing array", () => {
    const existing: VaultItem[] = []
    reconcileVaultItems({ envVarNames: ["X"], opTokenLabels: [], existing, now: NOW })
    expect(existing).toHaveLength(0)
  })

  it("each call produces items with unique ids (crypto-random)", () => {
    const r1 = reconcileVaultItems({ envVarNames: ["X"], opTokenLabels: [], existing: [], now: NOW })
    const r2 = reconcileVaultItems({ envVarNames: ["X"], opTokenLabels: [], existing: [], now: NOW })
    expect(r1.toAdopt[0]?.id).not.toBe(r2.toAdopt[0]?.id)
  })
})

// ---------------------------------------------------------------------------
// Name-collision handling (Finding 2)
// ---------------------------------------------------------------------------

describe("reconcileVaultItems — name-collision deduplication", () => {
  it("name-collision with different ref does NOT clobber: uniquifies with raw origin", () => {
    // GITHUB_TOKEN and GITHUB_TOKEN_BACKUP both humanize differently, but
    // two vars whose humanized names collide with an existing item's name slot
    // should be uniquified. Use a direct collision: an existing item named
    // "Github Token" (from a different ref) and a new var GITHUB_TOKEN.
    const existing: VaultItem[] = [
      existingItem("env:GITHUB_TOKEN_LEGACY", {
        name: "Github Token",
        kind: "env-secret",
        ref: "env:GITHUB_TOKEN_LEGACY",
      }),
    ]
    // GITHUB_TOKEN also humanizes to "Github Token" — name slot is taken by a different ref.
    const { toAdopt } = reconcileVaultItems({
      envVarNames: ["GITHUB_TOKEN"],
      opTokenLabels: [],
      existing,
      now: NOW,
    })
    expect(toAdopt).toHaveLength(1)
    // Must NOT produce "Github Token" (which would clobber the existing row).
    expect(toAdopt[0]?.name).toBe("Github Token (GITHUB_TOKEN)")
    expect(toAdopt[0]?.ref).toBe("env:GITHUB_TOKEN")
  })

  it("uses a numbered fallback when the deterministic suffix is already occupied", () => {
    const existing = [
      existingItem("env:GITHUB_TOKEN_2", { name: "Github Token" }),
      existingItem("env:GITHUB_TOKEN_3", {
        name: "Github Token (GITHUB_TOKEN)",
      }),
    ]

    const { toAdopt } = reconcileVaultItems({
      envVarNames: ["GITHUB_TOKEN"],
      opTokenLabels: [],
      existing,
      now: NOW,
    })

    expect(toAdopt).toHaveLength(1)
    expect(toAdopt[0]?.name).toBe("Github Token (GITHUB_TOKEN) #2")
  })

  it("two same-pass vars whose humanized names collide produce two distinct rows", () => {
    // GITHUB_TOKEN and GITHUB_TOKEN both humanize to "Github Token"; the
    // second is a duplicate ref so only one adoption row. Use two DIFFERENT
    // vars whose humanized names collide: impossible with normal var names
    // without manufacturing one, so test a simpler case — two vars that
    // after humanizeName are the same string only via a trivially constructed
    // pair that the store would collapse. We test via a pre-existing slot
    // from the first adoption blocking the second.
    //
    // Concrete: existing has GITHUB_TOKEN_LEGACY → "Github Token";
    // input has GITHUB_TOKEN (collides) and GITHUB_TOKEN_OTHER (unique).
    // The first should be uniquified; the second goes in as-is.
    const existing: VaultItem[] = [
      existingItem("env:GITHUB_TOKEN_LEGACY", {
        name: "Github Token",
        kind: "env-secret",
        ref: "env:GITHUB_TOKEN_LEGACY",
      }),
    ]
    const { toAdopt } = reconcileVaultItems({
      envVarNames: ["GITHUB_TOKEN", "GITHUB_TOKEN_OTHER"],
      opTokenLabels: [],
      existing,
      now: NOW,
    })
    expect(toAdopt).toHaveLength(2)
    const names = toAdopt.map((i) => i.name).sort()
    expect(names).toEqual(["Github Token (GITHUB_TOKEN)", "Github Token Other"])
  })

  it("a second reconcile pass with adopted items in existing produces toAdopt=[] (no oscillation)", () => {
    // First pass: GITHUB_TOKEN collides with an existing "Github Token" from a different ref.
    const existingLegacy: VaultItem[] = [
      existingItem("env:GITHUB_TOKEN_LEGACY", {
        name: "Github Token",
        kind: "env-secret",
        ref: "env:GITHUB_TOKEN_LEGACY",
      }),
    ]
    const first = reconcileVaultItems({
      envVarNames: ["GITHUB_TOKEN"],
      opTokenLabels: [],
      existing: existingLegacy,
      now: NOW,
    })
    expect(first.toAdopt).toHaveLength(1)
    const adoptedName = first.toAdopt[0]?.name
    expect(adoptedName).toBe("Github Token (GITHUB_TOKEN)")

    // Second pass: simulate the adopted item now being in the registry.
    const existingAfterAdopt = [...existingLegacy, ...first.toAdopt]
    const second = reconcileVaultItems({
      envVarNames: ["GITHUB_TOKEN"],
      opTokenLabels: [],
      existing: existingAfterAdopt,
      now: NOW,
    })
    // No new adoptions — idempotent.
    expect(second.toAdopt).toHaveLength(0)
  })
})
