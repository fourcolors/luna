/**
 * Account Switcher — Tier-3 Reducer Unit Tests
 *
 * Pure-function tests for the `reduce` additions needed by the
 * account-switcher feature:
 *
 *   1. `UIState` gains `accounts: AccountSummary[]` + `selectedAccountId`.
 *   2. `account-list` ServerFrame populates `state.accounts`.
 *   3. `select-account` ChatLocalAction updates `state.selectedAccountId`.
 *   4. Auto-select: first healthy account is selected when none is set.
 *   5. Persistence hint: selectedAccountId survives subsequent frames.
 *   6. Hidden-when-single: only 1 account → still stored (UI decides visibility).
 *   7. Empty list: `account-list` with empty array → accounts=[], no auto-select.
 *   8. All rate-limited: no healthy accounts → selectedAccountId stays null.
 *   9. Re-receive: second `account-list` replaces first (health updates).
 *  10. Unrelated frames don't touch accounts state.
 *
 * These tests will fail RED until the reducer changes are implemented —
 * that is the TDD intent.
 *
 * Pattern: import `reduce` and `initialState` from the reducer module;
 * build minimal frames / actions; assert on the returned state slice.
 * Zero Effect / Zero Layer.
 */
import { describe, expect, it } from "vitest"
import { reduce, initialState } from "./reducer.js"
import type { UIState } from "./reducer.js"
import type { ServerFrame } from "./wire.js"

// ─── Type stubs (will exist after the feature is implemented) ─────────────────
//
// We use `as unknown as ServerFrame` casts here so the tests compile today
// against the current wire.ts (which doesn't yet have AccountListFrame).
// Once `AccountListFrame` is added to `ServerFrame`, remove the casts.

interface AccountSummary {
  id: string
  label: string
  kind: string
  health: string
}

const makeAccountListFrame = (
  accounts: ReadonlyArray<AccountSummary>,
): ServerFrame =>
  ({
    type: "account-list",
    accounts,
  }) as unknown as ServerFrame

const makeSelectAccountAction = (accountId: string | null) =>
  ({
    tag: "select-account",
    accountId,
  }) as Parameters<typeof reduce>[1]

// ─── Helpers ──────────────────────────────────────────────────────────────────

const healthy = (id: string, label?: string): AccountSummary => ({
  id,
  label: label ?? `Account ${id}`,
  kind: "anthropic",
  health: "healthy",
})

const rateLimited = (id: string): AccountSummary => ({
  id,
  label: `Account ${id}`,
  kind: "anthropic",
  health: "rate_limited",
})

// Helper to pull accounts/selectedAccountId from state (with fallback so
// tests fail with a clear message rather than crashing before the feature lands).
// Bun's JSC throws TypeError if the LHS of a property access is undefined,
// so we guard against `reduce` returning undefined (which it does for unhandled
// frame types before the feature is implemented — correct RED behaviour).
const getAccounts = (state: UIState | undefined): ReadonlyArray<AccountSummary> => {
  if (state == null) return []
  // @ts-expect-error — accounts field added in this feature
  const a = (state as Record<string, unknown>)["accounts"]
  return (Array.isArray(a) ? a : []) as ReadonlyArray<AccountSummary>
}

const getSelected = (state: UIState | undefined): string | null => {
  if (state == null) return null
  // @ts-expect-error — selectedAccountId field added in this feature
  const s = (state as Record<string, unknown>)["selectedAccountId"]
  return (typeof s === "string" ? s : null)
}

// ─── S1 — account-list populates UIState.accounts ─────────────────────────────

describe("S1 — account-list frame populates state.accounts", () => {
  /**
   * Given: initial state (no accounts yet).
   * When:  an account-list frame with 3 accounts is reduced.
   * Then:  state.accounts has all 3 entries.
   */
  it("stores all accounts from the frame", () => {
    const frame = makeAccountListFrame([
      healthy("a1"),
      healthy("a2"),
      healthy("a3"),
    ])
    const next = reduce(initialState, frame)
    expect(getAccounts(next)).toHaveLength(3)
  })

  /**
   * Given: an account-list frame.
   * When:  reduced.
   * Then:  each entry has id, label, kind, health.
   */
  it("preserves the account summary fields exactly", () => {
    const frame = makeAccountListFrame([healthy("a1", "Primary")])
    const next = reduce(initialState, frame)
    const acct = getAccounts(next)[0]
    expect(acct?.id).toBe("a1")
    expect(acct?.label).toBe("Primary")
    expect(acct?.kind).toBe("anthropic")
    expect(acct?.health).toBe("healthy")
  })
})

// ─── S2 — auto-select first healthy account ───────────────────────────────────

describe("S2 — auto-select first healthy account on first account-list", () => {
  /**
   * Given: selectedAccountId is null (first connection).
   * When:  account-list frame with [a1 healthy, a2 healthy] arrives.
   * Then:  selectedAccountId is set to "a1" (first healthy).
   */
  it("auto-selects the first healthy account when none is selected", () => {
    const frame = makeAccountListFrame([healthy("a1"), healthy("a2")])
    const next = reduce(initialState, frame)
    expect(getSelected(next)).toBe("a1")
  })

  /**
   * Given: a1 is rate-limited; a2 is healthy.
   * When:  account-list frame arrives with [a1 rate_limited, a2 healthy].
   * Then:  selectedAccountId is set to "a2" (first HEALTHY account).
   */
  it("auto-selects first HEALTHY account, skipping rate-limited ones", () => {
    const frame = makeAccountListFrame([rateLimited("a1"), healthy("a2")])
    const next = reduce(initialState, frame)
    expect(getSelected(next)).toBe("a2")
  })

  /**
   * Given: selectedAccountId is already "a2" (user previously selected it).
   * When:  a new account-list frame arrives (e.g. reconnect).
   * Then:  selectedAccountId stays "a2" — user's choice is preserved.
   */
  it("does NOT overwrite an existing selectedAccountId on reconnect", () => {
    // First: select a2.
    const firstFrame = makeAccountListFrame([healthy("a1"), healthy("a2")])
    let state = reduce(initialState, firstFrame)
    state = reduce(state, makeSelectAccountAction("a2"))
    expect(getSelected(state)).toBe("a2")

    // Second: reconnect sends a fresh account-list.
    const reconnectFrame = makeAccountListFrame([healthy("a1"), healthy("a2")])
    const after = reduce(state, reconnectFrame)
    // a2 must still be selected.
    expect(getSelected(after)).toBe("a2")
  })
})

// ─── S3 — select-account action ───────────────────────────────────────────────

describe("S3 — select-account action updates selectedAccountId", () => {
  /**
   * Given: state has selectedAccountId="a1".
   * When:  select-account action with accountId="a2" is dispatched.
   * Then:  selectedAccountId becomes "a2".
   */
  it("switches selectedAccountId to the chosen account", () => {
    const frame = makeAccountListFrame([healthy("a1"), healthy("a2")])
    let state = reduce(initialState, frame)
    // Initial auto-select: a1.
    expect(getSelected(state)).toBe("a1")

    // User picks a2 in the dropdown.
    state = reduce(state, makeSelectAccountAction("a2"))
    expect(getSelected(state)).toBe("a2")
  })

  /**
   * Given: selectedAccountId is "a2".
   * When:  select-account action with accountId=null is dispatched.
   * Then:  selectedAccountId becomes null (unpin — use default rotation).
   */
  it("clears selectedAccountId when null is dispatched", () => {
    const frame = makeAccountListFrame([healthy("a1"), healthy("a2")])
    let state = reduce(initialState, frame)
    state = reduce(state, makeSelectAccountAction("a2"))
    state = reduce(state, makeSelectAccountAction(null))
    expect(getSelected(state)).toBeNull()
  })

  /**
   * Given: user switches from a1 → a2 → a3.
   * When:  each select-account action is dispatched.
   * Then:  selectedAccountId reflects the latest selection.
   */
  it("tracks successive account selections correctly", () => {
    const frame = makeAccountListFrame([
      healthy("a1"),
      healthy("a2"),
      healthy("a3"),
    ])
    let state = reduce(initialState, frame)

    state = reduce(state, makeSelectAccountAction("a2"))
    expect(getSelected(state)).toBe("a2")

    state = reduce(state, makeSelectAccountAction("a3"))
    expect(getSelected(state)).toBe("a3")

    state = reduce(state, makeSelectAccountAction("a1"))
    expect(getSelected(state)).toBe("a1")
  })
})

// ─── S4 — selectedAccountId survives unrelated frames ─────────────────────────

describe("S4 — selectedAccountId survives unrelated frames", () => {
  /**
   * Given: selectedAccountId="a2" in state.
   * When:  an unrelated frame (ping, event, thread-list) is reduced.
   * Then:  selectedAccountId is still "a2" — not reset.
   */
  it("ping frame does not reset selectedAccountId", () => {
    const frame = makeAccountListFrame([healthy("a1"), healthy("a2")])
    let state = reduce(initialState, frame)
    state = reduce(state, makeSelectAccountAction("a2"))

    const ping: ServerFrame = { type: "ping", ts: new Date().toISOString() }
    state = reduce(state, ping)
    expect(getSelected(state)).toBe("a2")
  })

  it("thread-list frame does not reset selectedAccountId", () => {
    const frame = makeAccountListFrame([healthy("a1"), healthy("a2")])
    let state = reduce(initialState, frame)
    state = reduce(state, makeSelectAccountAction("a2"))

    const threadList: ServerFrame = { type: "thread-list", threads: [] }
    state = reduce(state, threadList)
    expect(getSelected(state)).toBe("a2")
  })

  it("hello frame does not reset selectedAccountId", () => {
    const frame = makeAccountListFrame([healthy("a1"), healthy("a2")])
    let state = reduce(initialState, frame)
    state = reduce(state, makeSelectAccountAction("a2"))

    const hello: ServerFrame = {
      type: "hello",
      protocolVersion: 2,
      kinds: [],
      capabilities: { chat: true, streamingDeltas: true },
    }
    state = reduce(state, hello)
    expect(getSelected(state)).toBe("a2")
  })
})

// ─── S5 — Empty account list ──────────────────────────────────────────────────

describe("S5 — Empty account-list", () => {
  /**
   * Given: an account-list frame with an empty array.
   * When:  reduced.
   * Then:  accounts=[], selectedAccountId=null (no auto-select possible).
   */
  it("stores empty array and leaves selectedAccountId null", () => {
    const frame = makeAccountListFrame([])
    const next = reduce(initialState, frame)
    expect(getAccounts(next)).toHaveLength(0)
    expect(getSelected(next)).toBeNull()
  })
})

// ─── S6 — All accounts rate-limited ───────────────────────────────────────────

describe("S6 — All accounts rate-limited", () => {
  /**
   * Given: all accounts are rate_limited.
   * When:  account-list frame arrives with no healthy accounts.
   * Then:  selectedAccountId stays null (no healthy account to auto-select).
   *
   * The UI should show all accounts greyed out and let the user wait.
   */
  it("does not auto-select when all accounts are rate_limited", () => {
    const frame = makeAccountListFrame([
      rateLimited("a1"),
      rateLimited("a2"),
      rateLimited("a3"),
    ])
    const next = reduce(initialState, frame)
    expect(getAccounts(next)).toHaveLength(3)
    expect(getSelected(next)).toBeNull()
  })
})

// ─── S7 — Re-receive account-list replaces accounts (health update) ────────────

describe("S7 — Re-receive account-list replaces accounts", () => {
  /**
   * Given: first account-list frame has [a1 healthy, a2 healthy].
   * When:  a second account-list frame arrives with [a1 rate_limited, a2 healthy].
   * Then:  state.accounts reflects the new health values.
   *        selectedAccountId (was a2) is preserved.
   *
   * This covers the reconnect / health-push scenario.
   */
  it("replaces accounts array and preserves selection on second account-list", () => {
    const first = makeAccountListFrame([healthy("a1"), healthy("a2")])
    let state = reduce(initialState, first)
    state = reduce(state, makeSelectAccountAction("a2"))

    // Health update arrives.
    const second = makeAccountListFrame([rateLimited("a1"), healthy("a2")])
    state = reduce(state, second)

    expect(getAccounts(state)).toHaveLength(2)
    const a1 = getAccounts(state).find((a) => a.id === "a1")
    expect(a1?.health).toBe("rate_limited")
    // Selected a2 is preserved.
    expect(getSelected(state)).toBe("a2")
  })
})

// ─── S8 — Single account ──────────────────────────────────────────────────────

describe("S8 — Single account in pool", () => {
  /**
   * Given: only one anthropic account.
   * When:  account-list frame arrives.
   * Then:  it is stored and auto-selected (UI may hide the dropdown but
   *        the state is still correct).
   */
  it("stores and auto-selects the sole account", () => {
    const frame = makeAccountListFrame([healthy("solo", "My Only Account")])
    const next = reduce(initialState, frame)
    expect(getAccounts(next)).toHaveLength(1)
    expect(getSelected(next)).toBe("solo")
  })
})

// ─── S9 — Unrelated frames don't touch accounts ───────────────────────────────

describe("S9 — Unrelated frames leave accounts unchanged", () => {
  /**
   * Given: state has 2 accounts already loaded.
   * When:  unrelated frames (drop, bye, event, thread-created) are reduced.
   * Then:  accounts array is untouched.
   */
  it("drop frame does not clear accounts", () => {
    // Pre-seed accounts directly on state (bypasses account-list frame
    // so the test is independent of whether account-list is handled yet).
    const seeded = {
      ...initialState,
      accounts: [healthy("a1"), healthy("a2")],
    } as UIState

    const drop: ServerFrame = {
      type: "drop",
      n: 3,
      since: new Date().toISOString(),
    }
    const state = reduce(seeded, drop)
    expect(getAccounts(state)).toHaveLength(2)
  })

  it("bye frame does not clear accounts", () => {
    const seeded = {
      ...initialState,
      accounts: [healthy("a1"), healthy("a2")],
    } as UIState

    const bye: ServerFrame = { type: "bye", reason: "server-restart" }
    const state = reduce(seeded, bye)
    // Accounts survive a disconnect — UI should keep showing the list.
    expect(getAccounts(state)).toHaveLength(2)
  })
})

// ─── S10 — initialState has empty accounts ─────────────────────────────────────

describe("S10 — initialState defaults", () => {
  /**
   * Given: freshly-imported initialState.
   * Then:  accounts is [] and selectedAccountId is null before any frame arrives.
   */
  it("initialState has no accounts and no selection", () => {
    expect(getAccounts(initialState)).toHaveLength(0)
    expect(getSelected(initialState)).toBeNull()
  })
})
