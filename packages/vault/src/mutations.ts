/**
 * makeVaultMutations — orchestration behind vault-put / vault-delete.
 *
 * This module intentionally has no Effect-TS runtime dependency: like
 * makeRegisterSecret it is a plain async factory so the chat-server
 * can inject real deps and tests can inject stubs. The `store` parameter
 * uses a Promise-based facade so the same function covers both the
 * in-memory test store (run via Effect.runPromise) and the SQLite
 * production store.
 *
 * SECURITY invariants (mirrors makeRegisterSecret):
 *   - secret values are passed through to `registerSecret` only — they
 *     are NEVER stored in the registry, never appear in log lines, and
 *     never flow into any returned message string.
 *   - The function NEVER throws (every failure path resolves to {ok:false}).
 */

import type { VaultItem, VaultItemKind, VaultItemSource } from "./types.js"
import { makeId, isEnvDenied } from "./internal.js"

// ---------------------------------------------------------------------------
// Dep interfaces
// ---------------------------------------------------------------------------

/**
 * Where a vault secret should be stored. Discriminated by `kind`, mirrors
 * SecretDestination in packages/secret-tools — we declare it locally so
 * this file stays framework-free (same pattern as register-secret.ts).
 */
type VaultDestination =
  | { readonly kind: "op-token"; readonly label: string }
  | { readonly kind: "env-secret"; readonly varName: string }

/** Promise-based facade over VaultStoreApi for framework-free wiring. */
export interface VaultStoreFacade {
  readonly list: () => Promise<ReadonlyArray<VaultItem>>
  readonly upsertByName: (item: VaultItem) => Promise<void>
  readonly getById: (id: string) => Promise<VaultItem | null>
  readonly remove: (id: string) => Promise<boolean>
}

export interface VaultMutationDeps {
  /**
   * Route through the SAME makeRegisterSecret instance for free validation
   * (label grammar, env grammar, newline rejection, op whoami).
   */
  readonly registerSecret: (
    destination: VaultDestination,
    secret: string,
  ) => Promise<{ ok: boolean; message: string }>
  /** Remove an env var from ~/.luna/.env and process.env. */
  readonly removeEnvSecret: (varName: string) => Promise<void>
  /** Delete an op-token from OS keychain / file. */
  readonly deleteOpToken: (label: string) => Promise<void>
  /** Promise-based vault store facade. */
  readonly store: VaultStoreFacade
  /** Returns current time in epoch ms. */
  readonly now: () => number
  /** Optional non-sensitive audit logger. NEVER passed a secret value. */
  readonly log?: (msg: string) => void
}

// ---------------------------------------------------------------------------
// Return shapes
// ---------------------------------------------------------------------------

export interface VaultMutationResult {
  readonly ok: boolean
  readonly message: string
  /** True only for op-token operations (caller must schedule a restart). */
  readonly restartNeeded: boolean
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the `ref` pointer from the destination. POINTERS only — never values.
 *   env-secret → `env:<varName>`
 *   op-token   → `luna-op://<label>`
 */
const refFor = (dest: VaultDestination): string => {
  switch (dest.kind) {
    case "env-secret":
      return `env:${dest.varName}`
    case "op-token":
      return `luna-op://${dest.label}`
  }
}

/**
 * Parse a `ref` back to a deletion target. Returns null for op-item refs
 * (which are registry-only deletes — the caller handles that branch).
 */
const parseRef = (
  ref: string,
): { kind: "env-secret"; varName: string } | { kind: "op-token"; label: string } | null => {
  if (ref.startsWith("env:")) {
    return { kind: "env-secret", varName: ref.slice(4) }
  }
  if (ref.startsWith("luna-op://")) {
    const rest = ref.slice("luna-op://".length)
    // luna-op://<label>          → op-token
    // luna-op://<label>/...      → op-item (registry-only)
    const slashIdx = rest.indexOf("/")
    if (slashIdx === -1) {
      return { kind: "op-token", label: rest }
    }
    return null // op-item — caller handles
  }
  return null
}

/**
 * Convert an environment-variable name to a human-readable title.
 * E.g. NOTION_API_KEY → "Notion Api Key", OPENAI_KEY → "Openai Key".
 */
export const humanizeName = (varName: string): string =>
  varName
    .toLowerCase()
    .split("_")
    .filter((p) => p.length > 0)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(" ")

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface VaultMutations {
  /**
   * Store a new or updated vault entry. Calls registerSecret for
   * validation + persistence; on success upserts the registry row.
   * Never logs or returns the secret value.
   */
  readonly put: (args: {
    name: string
    kind: VaultItemKind
    /** Required for env-secret. */
    varName?: string
    /** Required for op-token. */
    label?: string
    /** The secret value — passes through to registerSecret ONLY. */
    value: string
    description?: string
  }) => Promise<VaultMutationResult>

  /**
   * Delete a vault entry by id. Dispatches to the appropriate delete
   * primitive based on kind, then removes the registry row.
   * Never throws; never logs values.
   */
  readonly remove: (id: string) => Promise<VaultMutationResult>

  /**
   * Record a credential that was captured via agent or settings path
   * (no secret value involved — the value has already been persisted by
   * the caller). Used by SecretRequestBridge and register-op-token to
   * back-fill the registry.
   */
  readonly recordCapture: (args: {
    kind: VaultItemKind
    /** varName for env-secret kind. */
    varName?: string
    /** label for op-token kind. */
    label?: string
    source: VaultItemSource
  }) => Promise<void>
}

export const makeVaultMutations = (deps: VaultMutationDeps): VaultMutations => {
  const { registerSecret, removeEnvSecret, deleteOpToken, store, now, log } = deps

  const put: VaultMutations["put"] = async ({
    name,
    kind,
    varName,
    label,
    value,
    description,
  }) => {
    // ------------------------------------------------------------------
    // Validate name (trimmed, 1..64 chars).
    // ------------------------------------------------------------------
    const trimmedName = name.trim()
    if (trimmedName.length === 0 || trimmedName.length > 64) {
      return {
        ok: false,
        message: "Vault entry name must be between 1 and 64 characters.",
        restartNeeded: false,
      }
    }

    // ------------------------------------------------------------------
    // Build the destination. op-item is not writable via vault-put.
    // ------------------------------------------------------------------
    let dest: VaultDestination
    if (kind === "env-secret") {
      if (!varName) {
        return {
          ok: false,
          message: "varName is required for env-secret entries.",
          restartNeeded: false,
        }
      }
      // A5: reserved-name denylist — UI_WS_TOKEN and LUNA_* must not be
      // overwritten via vault-put (a later vault-delete would wipe the live value).
      if (isEnvDenied(varName.trim())) {
        return {
          ok: false,
          message: "That name is reserved for Luna internals.",
          restartNeeded: false,
        }
      }
      dest = { kind: "env-secret", varName: varName.trim() }
    } else if (kind === "op-token") {
      if (!label) {
        return {
          ok: false,
          message: "label is required for op-token entries.",
          restartNeeded: false,
        }
      }
      dest = { kind: "op-token", label: label.trim() }
    } else {
      // op-item — cannot be written via vault-put
      return {
        ok: false,
        message: "op-item entries are created by the 1Password sync — use vault-sync-config to enable sync.",
        restartNeeded: false,
      }
    }

    // ------------------------------------------------------------------
    // Delegate to registerSecret — reuses all its validation for free:
    // label grammar, env-var grammar, newline rejection, op whoami.
    // ------------------------------------------------------------------
    let result: { ok: boolean; message: string }
    try {
      result = await registerSecret(dest, value)
    } catch {
      // Honor never-throws contract even if a dep rejects.
      return {
        ok: false,
        message: "Failed to store the credential.",
        restartNeeded: false,
      }
    }

    if (!result.ok) {
      return { ok: false, message: result.message, restartNeeded: false }
    }

    // ------------------------------------------------------------------
    // Upsert the registry row (pointer only — never the value).
    //
    // Same-ref rename guard: a row already pointing at this exact ref but
    // under a DIFFERENT name is the same credential being re-saved — replace
    // it (preserving createdAt) instead of accumulating two rows whose
    // deletes would race over one backing value. Best-effort: a lookup
    // failure must not block the upsert.
    // ------------------------------------------------------------------
    const ts = now()
    const ref = refFor(dest)
    let createdAt = ts
    // A1: hoist so opItemId is available for item construction below.
    let existingByRef: VaultItem | undefined
    try {
      existingByRef = (await store.list()).find((i) => i.ref === ref)
      if (existingByRef !== undefined) {
        createdAt = existingByRef.createdAt
        if (existingByRef.name.toLowerCase() !== trimmedName.toLowerCase()) {
          await store.remove(existingByRef.id)
        }
      }
    } catch {
      // fall through with createdAt = ts, existingByRef = undefined
    }

    const item: VaultItem = {
      id: makeId(),
      name: trimmedName,
      kind,
      ref,
      source: "manual",
      description: description?.trim() ?? null,
      createdAt,
      updatedAt: ts,
      // A1: carry the existing opItemId forward on a same-ref re-save so the
      // pushEnvSecretTo1P skip guard is not defeated by a subsequent vault-put.
      opItemId: existingByRef?.opItemId ?? null,
    }

    try {
      await store.upsertByName(item)
    } catch {
      return {
        ok: false,
        message: "Credential stored but registry update failed.",
        restartNeeded: kind === "op-token",
      }
    }

    log?.(`[vault] put "${trimmedName}" kind=${kind}`)

    // Vault-path messaging: registerSecret's own message describes the
    // request_secret flow ("…at the end of this turn"), which is wrong here —
    // the Vault caller restarts immediately (op-token) or not at all
    // (env-secret is live via process.env).
    return {
      ok: true,
      message:
        dest.kind === "op-token"
          ? `Saved "${trimmedName}". Restarting the server to activate…`
          : `Saved "${trimmedName}" (env:${dest.varName}). Available immediately.`,
      restartNeeded: dest.kind === "op-token",
    }
  }

  const remove: VaultMutations["remove"] = async (id) => {
    // ------------------------------------------------------------------
    // Look up the row.
    // ------------------------------------------------------------------
    let item: VaultItem | null
    try {
      item = await store.getById(id)
    } catch {
      return { ok: false, message: "Registry lookup failed.", restartNeeded: false }
    }

    if (item === null) {
      return { ok: false, message: `No vault entry with id "${id}".`, restartNeeded: false }
    }

    const { kind, ref, name, opItemId, source } = item

    // ------------------------------------------------------------------
    // Delete the backing credential (when applicable).
    // ------------------------------------------------------------------
    if (kind === "env-secret") {
      const parsed = parseRef(ref)
      if (parsed?.kind === "env-secret") {
        try {
          await removeEnvSecret(parsed.varName)
        } catch {
          return {
            ok: false,
            message: "Failed to remove the env secret from the server.",
            restartNeeded: false,
          }
        }
      }
    } else if (kind === "op-token") {
      const parsed = parseRef(ref)
      if (parsed?.kind === "op-token") {
        try {
          await deleteOpToken(parsed.label)
        } catch {
          return {
            ok: false,
            message: "Failed to delete the op-token from the server.",
            restartNeeded: false,
          }
        }
      }
    }
    // op-item: registry-only — we NEVER delete inside 1Password.

    // ------------------------------------------------------------------
    // Remove the registry row.
    // ------------------------------------------------------------------
    // The backing delete above already happened — for op-token that means a
    // restart is owed regardless of how the registry bookkeeping below goes
    // (same class as the put-path registry-failure finding).
    let removed: boolean
    try {
      removed = await store.remove(id)
    } catch {
      return {
        ok: false,
        message: "Credential deleted but registry removal failed.",
        restartNeeded: kind === "op-token",
      }
    }

    if (!removed) {
      // Row was deleted by a concurrent remove between our lookup and here.
      return {
        ok: false,
        message: `No vault entry with id "${id}".`,
        restartNeeded: kind === "op-token",
      }
    }

    log?.(`[vault] remove "${name}" kind=${kind}`)

    // A6: honest message when the item still exists in 1Password — it will
    // reappear on the next sync pass unless deleted there or sync is disabled.
    const reappearsWarning =
      opItemId !== null || source === "1password"
        ? " The item still exists in 1Password — it will reappear unless you delete it there or disable sync."
        : ""

    return {
      ok: true,
      message: `Removed "${name}" from the vault.${reappearsWarning}`,
      restartNeeded: kind === "op-token",
    }
  }

  const recordCapture: VaultMutations["recordCapture"] = async ({
    kind,
    varName,
    label,
    source,
  }) => {
    // Build the human name and ref.
    let itemName: string
    let ref: string

    if (kind === "env-secret") {
      if (!varName) return
      const v = varName.trim()
      // A5: silently skip reserved names in recordCapture (fire-and-forget
      // bookkeeping path — the backing store was handled elsewhere).
      if (isEnvDenied(v)) return
      itemName = humanizeName(v)
      ref = `env:${v}`
    } else if (kind === "op-token") {
      if (!label) return
      const l = label.trim()
      itemName = l
      ref = `luna-op://${l}`
    } else {
      // op-item capture not supported via this path
      return
    }

    const ts = now()
    try {
      const all = await store.list()

      // Re-capture of an already-registered credential (same ref): refresh
      // the existing row in place, keeping the operator's chosen name and
      // description — upsertByName's name-keyed update path preserves id.
      const byRef = all.find((i) => i.ref === ref)
      if (byRef !== undefined) {
        await store.upsertByName({ ...byRef, source, updatedAt: ts })
        log?.(`[vault] recordCapture refreshed "${byRef.name}" kind=${kind} source=${source}`)
        return
      }

      // Name-slot collision with a DIFFERENT ref: uniquify deterministically
      // (same scheme as the reconciler) instead of clobbering the other row.
      const rawOrigin = kind === "env-secret" ? varName!.trim() : label!.trim()
      const taken = all.some(
        (i) => i.name.toLowerCase() === itemName.toLowerCase(),
      )
      const finalName = taken ? `${itemName} (${rawOrigin})` : itemName

      await store.upsertByName({
        id: makeId(),
        name: finalName,
        kind,
        ref,
        source,
        description: null,
        createdAt: ts,
        updatedAt: ts,
        opItemId: null,
      })
      log?.(`[vault] recordCapture "${finalName}" kind=${kind} source=${source}`)
    } catch {
      // recordCapture is fire-and-forget; swallow errors silently.
    }
  }

  return { put, remove, recordCapture }
}
