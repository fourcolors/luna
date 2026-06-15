/**
 * makeVaultOpSync — 1Password two-way sync engine (slice V3).
 *
 * Shells out to the `op` CLI through an INJECTED runner (never
 * @1password/sdk — its WASM hangs on Bun, issue #166), so every decision
 * branch is unit-testable with a fake runner. The chat-server provides the
 * real spawn.
 *
 * SECURITY invariants:
 *   - The service-account token reaches `op` ONLY via the child process env
 *     (`OP_SERVICE_ACCOUNT_TOKEN`), mirroring chat-server's opWhoami. It is
 *     NEVER placed in argv (visible in the process list) and NEVER logged.
 *   - Outbound credential VALUES reach `op` ONLY via an item-template JSON on
 *     STDIN (`op item create - --vault <v> --format json`, the documented
 *     piped-template form). Values are NEVER placed in argv, logs, returned
 *     messages, or `lastError`.
 *   - `lastError` is stored SANITIZED: operation + exit code only (e.g.
 *     "op item list failed (exit 6)") — never stdout/stderr bodies, which
 *     can echo request/item content.
 *
 * RATE BUDGET (1Password personal plan ≈ 1000 reads/day, 100 writes/hr):
 *   - Poll floor 60 s (default 300 s ≈ 288 reads/day).
 *   - `nextDelayMs` doubles the interval per consecutive failure (cap 1 h);
 *     the caller's poll loop resets the failure count on success.
 *
 * Every public method NEVER throws — all failure paths resolve {ok:false}.
 */

import type { VaultItem, VaultSyncConfig } from "./types.js"
import type { VaultStoreFacade } from "./mutations.js"
import { makeId } from "./internal.js"

// ---------------------------------------------------------------------------
// Dep interfaces
// ---------------------------------------------------------------------------

/** One `op` CLI invocation. `env` is MERGED over the parent env by the runner. */
export interface OpRunInput {
  readonly args: ReadonlyArray<string>
  readonly env?: Readonly<Record<string, string>>
  /** Item-template JSON for `op item create -`. Sensitive — never logged. */
  readonly stdin?: string
}

export interface OpRunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** VaultStoreFacade + the sync-config row (promise facade, framework-free). */
export interface VaultSyncStoreFacade extends VaultStoreFacade {
  readonly getSyncConfig: () => Promise<VaultSyncConfig | null>
  readonly setSyncConfig: (cfg: VaultSyncConfig) => Promise<void>
}

export interface VaultOpSyncDeps {
  /** Injected `op` runner — the chat-server provides the real spawn. */
  readonly runOp: (input: OpRunInput) => Promise<OpRunResult>
  /** Boot-discovered label→token map lookup; chat-server provides. */
  readonly tokenForLabel: (label: string) => string | undefined
  readonly store: VaultSyncStoreFacade
  /** Returns current time in epoch ms. */
  readonly now: () => number
  /** Optional non-sensitive audit logger. NEVER passed a secret value. */
  readonly log?: (msg: string) => void
}

// ---------------------------------------------------------------------------
// Return shapes
// ---------------------------------------------------------------------------

export interface VaultOpSync {
  /** One inbound sync pass (manifest diff). Never throws. */
  readonly syncOnce: () => Promise<{
    readonly ok: boolean
    readonly changed: number
    readonly message: string
  }>
  /**
   * Create one item in the configured 1Password vault. The value travels via
   * a stdin JSON template only. Never throws.
   */
  readonly createItem: (input: {
    readonly title: string
    readonly value: string
    readonly category?: "API_CREDENTIAL" | "LOGIN"
    readonly username?: string
    readonly url?: string
    readonly notes?: string
  }) => Promise<{ readonly ok: boolean; readonly itemId?: string; readonly message: string }>
  /**
   * Sequential LOGIN-item creates + registry rows (source 'apple-import').
   * Stops on the first hard failure; reports the created count honestly.
   */
  readonly importLogins: (
    items: ReadonlyArray<{
      readonly title: string
      readonly url?: string
      readonly username?: string
      readonly password: string
      readonly notes?: string
    }>,
  ) => Promise<{ readonly ok: boolean; readonly created: number; readonly message: string }>
  /**
   * Pure backoff helper: poll interval (floor 60 s) doubled per consecutive
   * failure, capped at 3600 s. `nextDelayMs(0, poll)` is the steady-state
   * interval.
   */
  readonly nextDelayMs: (consecutiveFailures: number, pollSeconds: number) => number
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const POLL_FLOOR_S = 60
const BACKOFF_CAP_MS = 3600 * 1000

/**
 * Pure backoff helper: steady-state interval (floor 60s) doubled per
 * consecutive failure, capped at 3600s for backoff only.
 *
 * A4: when consecutiveFailures===0, return the base interval uncapped
 * (so pollSeconds=86400 is respected as-is); apply the cap only on backoff
 * growth (cap = max(BACKOFF_CAP_MS, base) so the cap never shrinks a large
 * legitimate poll interval).
 */
const nextDelayMsPure = (consecutiveFailures: number, pollSeconds: number): number => {
  const baseS = Number.isFinite(pollSeconds)
    ? Math.max(POLL_FLOOR_S, Math.floor(pollSeconds))
    : POLL_FLOOR_S
  const failures = Math.max(0, Math.floor(consecutiveFailures) || 0)
  if (failures === 0) return baseS * 1000
  const backoffCap = Math.max(BACKOFF_CAP_MS, baseS * 1000)
  return Math.min(backoffCap, baseS * 1000 * Math.pow(2, failures))
}

// ---------------------------------------------------------------------------
// A3: shouldAttemptSync — pure poll-gate predicate
// ---------------------------------------------------------------------------

/**
 * Pure predicate that matches the chat-server's two-gate composition exactly:
 *   pollDue   = nowMs - (lastSyncedAt ?? 0) >= nextDelayMs(0, pollSeconds)
 *   backoffDue = consecutiveFailures===0 ||
 *                nowMs - lastAttemptAt >= nextDelayMs(consecutiveFailures, pollSeconds)
 *
 * Both gates must hold for a sync attempt to proceed.
 * Track B will swap chat-server to call this.
 */
export interface ShouldAttemptSyncInput {
  readonly nowMs: number
  readonly lastSyncedAt: number | null
  readonly lastAttemptAt: number | null
  readonly consecutiveFailures: number
  readonly pollSeconds: number
}

export const shouldAttemptSync = (input: ShouldAttemptSyncInput): boolean => {
  const { nowMs, lastSyncedAt, lastAttemptAt, consecutiveFailures, pollSeconds } = input
  const baseDelay = nextDelayMsPure(0, pollSeconds)
  const pollDue = nowMs - (lastSyncedAt ?? 0) >= baseDelay
  const backoffDue =
    consecutiveFailures === 0 ||
    lastAttemptAt === null ||
    nowMs - lastAttemptAt >= nextDelayMsPure(consecutiveFailures, pollSeconds)
  return pollDue && backoffDue
}

/**
 * Primary secret field of a 1Password item by category — the last segment of
 * a `luna-op://<label>/<vault>/<itemId>/<field>` ref.
 */
const primaryFieldFor = (category: string): string => {
  switch (category) {
    case "LOGIN":
    case "PASSWORD":
      return "password"
    case "API_CREDENTIAL":
      return "credential"
    default:
      return "password"
  }
}

/** One row of the inbound manifest parsed from `op item list` output. */
interface ManifestEntry {
  readonly title: string
  readonly category: string
  readonly updatedAt: number
}

/**
 * Parse `op item list --format json` stdout into a manifest. Returns null on
 * malformed JSON / non-array output. Entries without a string id are skipped
 * (defensive — never trust subprocess output shape).
 */
const parseItemList = (stdout: string, fallbackNow: number): Map<string, ManifestEntry> | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const manifest = new Map<string, ManifestEntry>()
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) continue
    const r = raw as { id?: unknown; title?: unknown; category?: unknown; updated_at?: unknown }
    if (typeof r.id !== "string" || r.id.length === 0) continue
    const updatedMs =
      typeof r.updated_at === "string" ? Date.parse(r.updated_at) : Number.NaN
    manifest.set(r.id, {
      title: typeof r.title === "string" && r.title.length > 0 ? r.title : "Untitled",
      category: typeof r.category === "string" ? r.category : "",
      updatedAt: Number.isFinite(updatedMs) ? updatedMs : fallbackNow,
    })
  }
  return manifest
}

/**
 * Build the `op item create` stdin JSON template. Field shapes verified
 * against `op item template get "API Credential"` / `"Login"` (op 2.32.1).
 * The VALUE lives only inside this template — the caller pipes it to stdin.
 */
const buildItemTemplate = (input: {
  readonly title: string
  readonly value: string
  readonly category: "API_CREDENTIAL" | "LOGIN"
  readonly username?: string
  readonly url?: string
  readonly notes?: string
}): Record<string, unknown> => {
  const fields: Array<Record<string, unknown>> = []
  if (input.category === "LOGIN") {
    fields.push({
      id: "username",
      type: "STRING",
      purpose: "USERNAME",
      label: "username",
      value: input.username ?? "",
    })
    fields.push({
      id: "password",
      type: "CONCEALED",
      purpose: "PASSWORD",
      label: "password",
      value: input.value,
    })
  } else {
    if (input.username !== undefined) {
      fields.push({ id: "username", type: "STRING", label: "username", value: input.username })
    }
    fields.push({ id: "credential", type: "CONCEALED", label: "credential", value: input.value })
  }
  if (input.notes !== undefined) {
    fields.push({
      id: "notesPlain",
      type: "STRING",
      purpose: "NOTES",
      label: "notesPlain",
      value: input.notes,
    })
  }
  return {
    title: input.title,
    category: input.category,
    ...(input.category === "LOGIN" && input.url !== undefined
      ? { urls: [{ label: "website", primary: true, href: input.url }] }
      : {}),
    fields,
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const makeVaultOpSync = (deps: VaultOpSyncDeps): VaultOpSync => {
  const { runOp, tokenForLabel, store, now, log } = deps

  // A4: delegate to the module-level pure helper so shouldAttemptSync and the
  // factory share the same formula.
  const nextDelayMs: VaultOpSync["nextDelayMs"] = nextDelayMsPure

  /**
   * Merge status fields onto the FRESHLY-READ sync config row (best-effort).
   * A2: re-reading at write time prevents a concurrent vault-sync-config change
   * (e.g. DISABLE) from being silently reverted by spreading the snapshot read
   * at pass-start. If the fresh row is null (config was deleted) we skip the
   * write entirely. Only `lastSyncedAt` and `lastError` are merged.
   */
  const mergeSyncStatus = async (
    updates: { lastSyncedAt?: number | null; lastError?: string | null },
  ): Promise<void> => {
    try {
      const fresh = await store.getSyncConfig()
      if (fresh === null) return
      await store.setSyncConfig({ ...fresh, ...updates })
    } catch {
      // best-effort
    }
  }

  /**
   * Record a SANITIZED error string on the sync-config row (best-effort —
   * a config write failure must not mask the original error). The string is
   * operation + exit code only; never stdout/stderr bodies, never values.
   */
  const recordError = async (_cfg: VaultSyncConfig, message: string): Promise<void> => {
    await mergeSyncStatus({ lastError: message })
  }

  // -------------------------------------------------------------------------
  // syncOnce — inbound manifest diff
  // -------------------------------------------------------------------------

  const syncOnce: VaultOpSync["syncOnce"] = async () => {
    try {
      const cfg = await store.getSyncConfig()
      if (cfg === null || !cfg.enabled) {
        return { ok: true, changed: 0, message: "1Password sync is disabled." }
      }

      const token = tokenForLabel(cfg.opLabel)
      if (token === undefined) {
        const message = `no stored token for 1Password account "${cfg.opLabel}"`
        await recordError(cfg, message)
        return { ok: false, changed: 0, message }
      }

      // Capture the manifest-fetch timestamp BEFORE calling runOp. This
      // timestamp is the race boundary: any row whose updatedAt is strictly
      // newer than this value was written by a concurrent vault-put and must
      // not be overwritten by the vanished-id handler below (poll/push race).
      const manifestFetchTs = now()

      let res: OpRunResult
      try {
        res = await runOp({
          args: ["item", "list", "--vault", cfg.opVault, "--format", "json"],
          env: { OP_SERVICE_ACCOUNT_TOKEN: token },
        })
      } catch {
        const message = "op item list failed (spawn error)"
        await recordError(cfg, message)
        return { ok: false, changed: 0, message }
      }

      if (res.code !== 0) {
        // Sanitized: operation + exit code ONLY. op's stderr can echo request
        // context (and a 429 body its rate-limit details) — never store it.
        const message = `op item list failed (exit ${res.code})`
        await recordError(cfg, message)
        return { ok: false, changed: 0, message }
      }

      const ts = now()
      const manifest = parseItemList(res.stdout, ts)
      if (manifest === null) {
        const message = "op item list returned invalid JSON"
        await recordError(cfg, message)
        return { ok: false, changed: 0, message }
      }

      const all = await store.list()
      let changed = 0

      // Index registry rows by opItemId, and name slots (lower → ref) for
      // deterministic collision-uniquify (same scheme as recordCapture /
      // the reconciler: append the raw origin — here the 1P item id).
      const byOpId = new Map<string, VaultItem>()
      for (const row of all) {
        if (row.opItemId !== null) byOpId.set(row.opItemId, row)
      }
      const nameIndex = new Map<string, string>(
        all.map((i) => [i.name.toLowerCase(), i.ref]),
      )

      for (const [itemId, entry] of manifest) {
        const ref = `luna-op://${cfg.opLabel}/${cfg.opVault}/${itemId}/${primaryFieldFor(entry.category)}`
        const existing = byOpId.get(itemId)

        if (existing === undefined) {
          // New 1P item → adopt a registry row.
          const occupantRef = nameIndex.get(entry.title.toLowerCase())
          const name =
            occupantRef === undefined || occupantRef === ref
              ? entry.title
              : `${entry.title} (${itemId})`
          await store.upsertByName({
            id: makeId(),
            name,
            kind: "op-item",
            ref,
            source: "1password",
            description: null,
            createdAt: ts,
            updatedAt: entry.updatedAt,
            opItemId: itemId,
          })
          nameIndex.set(name.toLowerCase(), ref)
          changed += 1
          continue
        }

        if (existing.kind !== "op-item") {
          // Locally-pushed row (env-secret with opItemId): still present in
          // 1P — nothing to refresh; its truth lives locally.
          continue
        }

        // Existing op-item row: refresh name/updatedAt/ref on change. The
        // stored name may be the uniquified form — both spellings count as
        // "unchanged" so a collision-renamed row isn't churned every pass.
        const nameMatches =
          existing.name === entry.title || existing.name === `${entry.title} (${itemId})`
        if (nameMatches && existing.updatedAt === entry.updatedAt && existing.ref === ref) {
          continue
        }

        if (nameMatches) {
          // In-place refresh — upsertByName matches on the unchanged name.
          await store.upsertByName({ ...existing, ref, updatedAt: entry.updatedAt })
          changed += 1
        } else {
          // Title changed in 1P → rename (uniquified against other rows).
          const occupantRef = nameIndex.get(entry.title.toLowerCase())
          const name =
            occupantRef === undefined || occupantRef === existing.ref
              ? entry.title
              : `${entry.title} (${itemId})`
          await store.remove(existing.id)
          await store.upsertByName({ ...existing, name, ref, updatedAt: entry.updatedAt })
          nameIndex.delete(existing.name.toLowerCase())
          nameIndex.set(name.toLowerCase(), ref)
          changed += 1
        }
      }

      // Vanished ids: rows whose 1P item no longer exists.
      //   - source '1password' op-item rows mirror 1P → remove.
      //   - locally-pushed env-secret rows keep their local value → just
      //     CLEAR opItemId so the UI shows the unsynced badge.
      //   - op-item rows from 'apple-import' are left untouched (per spec;
      //     a future slice may reconcile them).
      //
      // POLL/PUSH RACE GUARD: a concurrent vault-put may have set (or updated)
      // opItemId between the manifest-fetch and here. Re-fetch the row; if its
      // updatedAt is strictly newer than manifestFetchTs the write happened
      // after the manifest snapshot → the item is NOT truly vanished, skip it.
      for (const row of all) {
        if (row.opItemId === null || manifest.has(row.opItemId)) continue
        if (row.kind === "op-item" && row.source === "1password") {
          const fresh = await store.getById(row.id)
          if (fresh !== null && fresh.updatedAt > manifestFetchTs) continue
          await store.remove(row.id)
          changed += 1
        } else if (row.kind === "env-secret") {
          const fresh = await store.getById(row.id)
          if (fresh !== null && fresh.updatedAt > manifestFetchTs) continue
          await store.upsertByName({ ...row, opItemId: null, updatedAt: ts })
          changed += 1
        }
      }

      // A2: re-read fresh config before writing status so a concurrent DISABLE
      // is not silently reverted.
      await mergeSyncStatus({ lastSyncedAt: ts, lastError: null })
      log?.(`[vault/op-sync] sync ok — ${changed} change(s), ${manifest.size} item(s) listed`)
      return {
        ok: true,
        changed,
        message:
          changed === 0 ? "Vault in sync with 1Password." : `Synced ${changed} change(s) from 1Password.`,
      }
    } catch {
      // Honor the never-throws contract even if the store itself fails.
      return { ok: false, changed: 0, message: "vault sync failed (internal error)" }
    }
  }

  // -------------------------------------------------------------------------
  // createItem — outbound stdin-JSON create
  // -------------------------------------------------------------------------

  const createItem: VaultOpSync["createItem"] = async (input) => {
    try {
      const cfg = await store.getSyncConfig()
      if (cfg === null || !cfg.enabled) {
        return { ok: false, message: "1Password sync is disabled." }
      }

      const token = tokenForLabel(cfg.opLabel)
      if (token === undefined) {
        const message = `no stored token for 1Password account "${cfg.opLabel}"`
        await recordError(cfg, message)
        return { ok: false, message }
      }

      const category = input.category ?? "API_CREDENTIAL"
      const template = buildItemTemplate({
        title: input.title,
        value: input.value,
        category,
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      })

      let res: OpRunResult
      try {
        // `op item create [ - ] [flags]` — `-` reads the item template JSON
        // from stdin (verified against op 2.32.1 help). The value never
        // appears in argv.
        res = await runOp({
          args: ["item", "create", "-", "--vault", cfg.opVault, "--format", "json"],
          env: { OP_SERVICE_ACCOUNT_TOKEN: token },
          stdin: JSON.stringify(template),
        })
      } catch {
        const message = "op item create failed (spawn error)"
        await recordError(cfg, message)
        return { ok: false, message }
      }

      if (res.code !== 0) {
        const message = `op item create failed (exit ${res.code})`
        await recordError(cfg, message)
        return { ok: false, message }
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(res.stdout)
      } catch {
        const message = "op item create returned invalid JSON"
        await recordError(cfg, message)
        return { ok: false, message }
      }
      const itemId = (parsed as { id?: unknown } | null)?.id
      if (typeof itemId !== "string" || itemId.length === 0) {
        const message = "op item create returned no item id"
        await recordError(cfg, message)
        return { ok: false, message }
      }

      log?.(`[vault/op-sync] created 1Password item for "${input.title}"`)
      return { ok: true, itemId, message: `Created "${input.title}" in 1Password.` }
    } catch {
      return { ok: false, message: "op item create failed (internal error)" }
    }
  }

  // -------------------------------------------------------------------------
  // importLogins — sequential LOGIN creates + registry rows
  // -------------------------------------------------------------------------

  const importLogins: VaultOpSync["importLogins"] = async (items) => {
    let created = 0
    try {
      if (items.length === 0) {
        return { ok: true, created: 0, message: "No items to import." }
      }
      const cfg = await store.getSyncConfig()
      if (cfg === null || !cfg.enabled) {
        return { ok: false, created: 0, message: "1Password sync is disabled." }
      }

      for (const item of items) {
        const title = item.title.trim() || "Untitled"
        const res = await createItem({
          title,
          value: item.password,
          category: "LOGIN",
          ...(item.username !== undefined ? { username: item.username } : {}),
          ...(item.url !== undefined ? { url: item.url } : {}),
          ...(item.notes !== undefined ? { notes: item.notes } : {}),
        })
        if (!res.ok || res.itemId === undefined) {
          // Stop on the first hard failure; report honestly how far we got.
          return {
            ok: false,
            created,
            message: `Imported ${created} of ${items.length} item(s); stopped: ${res.message}`,
          }
        }

        // The 1P item EXISTS from here on — count it even if the registry
        // write below fails (the next syncOnce pass adopts the row).
        created += 1
        try {
          const ts = now()
          const ref = `luna-op://${cfg.opLabel}/${cfg.opVault}/${res.itemId}/password`
          const all = await store.list()
          const taken = all.some(
            (i) => i.name.toLowerCase() === title.toLowerCase() && i.ref !== ref,
          )
          const name = taken ? `${title} (${res.itemId})` : title
          await store.upsertByName({
            id: makeId(),
            name,
            kind: "op-item",
            ref,
            source: "apple-import",
            description: null,
            createdAt: ts,
            updatedAt: ts,
            opItemId: res.itemId,
          })
        } catch {
          // Registry bookkeeping must never abort the import run.
        }
      }

      log?.(`[vault/op-sync] imported ${created} login(s) into 1Password`)
      return { ok: true, created, message: `Imported ${created} item(s) into 1Password.` }
    } catch {
      return { ok: false, created, message: "import failed (internal error)" }
    }
  }

  return { syncOnce, createItem, importLogins, nextDelayMs }
}
