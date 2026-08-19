/**
 * AccountBroker — SQLite-backed Layer factory (Phase 25a).
 *
 * Persistence-backed sibling of `AccountBrokerLayer.fromAccounts`. Closes the
 * §0.2/§5.1 deferral noted in `account-broker.ts` lines 18–20.
 *
 * Contract:
 *   - §7.5 — public surface unchanged. Returns the SAME `AccountBrokerApi`
 *     `fromAccounts` returns; callers cannot tell which factory was used.
 *   - §0.2 — OAuth subscription tokens NEVER hit disk in plaintext. The
 *     `accounts.secret_ref` column is a pointer string; resolution flows
 *     through `SecretProvider`, returning `Redacted<string>` only at acquire
 *     time — same shape as Phase 9.
 *   - §5.1 — `accounts(id, label, kind, secret_ref, health, cooldown_ms,
 *     usage_json)` columns byte-exact per DESIGN.md. No additive columns.
 *   - §5.2 — Migration ladder uses the per-component `schema_versions`
 *     ledger (Phase 25e) via `applyMigration("accounts", 1, ...)`. The
 *     pre-25e drift to `PRAGMA user_version` collided across components
 *     sharing `~/.luna/luna.db`; the new ledger keys per (component, version)
 *     so each store migrates independently.
 *   - §6 — Errors only via existing `ConfigError`. Missing `bun:sqlite` →
 *     ConfigError. Malformed row at hydrate (empty `kind` or empty
 *     `secret_ref`) → ConfigError with offending `id` in the message.
 *
 * Hydrate rule for §5.1 columns the in-memory `AccountRecord` doesn't model:
 *   - `label`        — carried into AccountRecord (displayed in UI/AccountSwitcher)
 *   - `health`       — ignored at hydrate (semantically default "healthy");
 *                      runtime cooldowns live on `cooldownUntilMs`
 *   - `cooldown_ms`  — if non-zero, sets `cooldownUntilMs = now + cooldown_ms`
 *                      so a row that was rate-limited shortly before reboot
 *                      keeps its remaining cooldown
 *   - `usage_json`   — ignored for now; write-back is Phase 25b+
 *
 * Out of scope this phase:
 *   - `report()` SQL write-back (in-memory cooldown only, exactly as Phase 9)
 *   - Hot-reload of new accounts post-boot (load-once-at-boot)
 *   - Seed CLI / chat-server wiring (Phase 25b)
 */
import { Effect, Layer, Redacted, Ref } from "effect"
import type * as Scope from "effect/Scope"
import * as os from "node:os"
import * as path from "node:path"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import {
  AllAccountsExhaustedError,
  ConfigError,
} from "../errors.js"
import {
  SecretProvider,
  isClaudeCodeLoginSecretRef,
  type SecretRef,
} from "../secret-provider/index.js"
import {
  AccountBroker,
  type AccountBrokerApi,
  type AccountError,
  type AcquiredSession,
  type Credential,
  type AccountSummary,
} from "./account-broker.js"
import { pickAccount, type AccountRecord } from "./rotation-policy.js"
import { readProviderEnv, resolveKind } from "../provider-profile.js"
import {
  auditOverflowEnv,
  pickLaneTarget,
  readOverflowConfig,
  resolveChain,
} from "../overflow-chain.js"
import { readRateTable } from "../pricing.js"
import { applyUsage, readCycleMs } from "./spend-meter.js"

// ── Schema (§5.1, byte-exact columns) ──────────────────────────────────────
const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    kind          TEXT NOT NULL,
    secret_ref    TEXT NOT NULL,
    health        TEXT NOT NULL,
    cooldown_ms   INTEGER,
    usage_json    TEXT NOT NULL
  );
`

const DEFAULT_COOLDOWN_MS = 60_000
const SESSION_LIMIT_COOLDOWN_MS = 3 * 60 * 60 * 1000 // 3 hours

// ── bun:sqlite minimal shape (mirrors cost-store-sqlite.ts) ────────────────
interface BunDb {
  run: (sql: string) => void
  query: (sql: string) => BunStmt
  close: () => void
}
interface BunStmt {
  get: (...p: unknown[]) => unknown
  all: (...p: unknown[]) => unknown[]
  run: (...p: unknown[]) => { changes: number }
}

interface AccountsRow {
  id: string
  label: string
  kind: string
  secret_ref: string
  health: string
  cooldown_ms: number | null
  usage_json: string
}

const cfgErr = (key: string, message: string) =>
  new ConfigError({ module: "account-broker", key, message })

/**
 * Parse the §5.1 `usage_json` blob into the in-memory spend state. The blob
 * packs BOTH the rolling accumulator AND the per-account budget (§5.1: no new
 * column — `budget_usd` lives INSIDE usage_json). Shape (all optional):
 *   { "cycleStartMs": number, "spentUsd": number, "budgetUsd": number }
 *
 * Defensive: malformed / missing JSON ⇒ no usage, no budget (telemetry-only),
 * mirroring the readOverflowConfig/readRateTable style — never throws.
 *
 * `nowMs` + `cycleMs` reset a stale accumulator at hydrate: if the persisted
 * cycle has already elapsed (`now >= cycleStartMs + cycleMs`), the usage is
 * dropped so a restart after the cycle boundary starts fresh.
 */
function parseUsageJson(
  raw: string,
  nowMs: number,
  cycleMs: number,
): {
  usage?: { cycleStartMs: number; spentUsd: number }
  budgetUsd?: number
} {
  if (!raw || raw.trim() === "" || raw.trim() === "{}") return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== "object") return {}
    const o = parsed as Record<string, unknown>
    const out: {
      usage?: { cycleStartMs: number; spentUsd: number }
      budgetUsd?: number
    } = {}
    if (typeof o["budgetUsd"] === "number" && Number.isFinite(o["budgetUsd"])) {
      out.budgetUsd = o["budgetUsd"]
    }
    if (
      typeof o["cycleStartMs"] === "number" &&
      Number.isFinite(o["cycleStartMs"]) &&
      typeof o["spentUsd"] === "number" &&
      Number.isFinite(o["spentUsd"])
    ) {
      const cycleStartMs = o["cycleStartMs"]
      // Reset the accumulator if the persisted cycle has already elapsed.
      if (nowMs < cycleStartMs + cycleMs) {
        out.usage = { cycleStartMs, spentUsd: o["spentUsd"] }
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Serialize the spend state back into the §5.1 `usage_json` blob (budget packed
 * IN — no new column). Always includes budgetUsd when known so it round-trips. */
function serializeUsageJson(
  usage: { cycleStartMs: number; spentUsd: number } | undefined,
  budgetUsd: number | undefined,
): string {
  const o: Record<string, number> = {}
  if (budgetUsd !== undefined) o["budgetUsd"] = budgetUsd
  if (usage !== undefined) {
    o["cycleStartMs"] = usage.cycleStartMs
    o["spentUsd"] = usage.spentUsd
  }
  return JSON.stringify(o)
}

const defaultDbPath = (): string => path.join(os.homedir(), ".luna", "luna.db")

export interface FromSqlOptions {
  /** Defaults to `~/.luna/luna.db`. Pass `":memory:"` for ephemeral tests. */
  readonly dbPath?: string
}

/**
 * Build an AccountBroker layer hydrated from the §5.1 `accounts` table.
 * Load-once-at-boot: the table is read at Layer construction; subsequent
 * INSERTs to the table do not appear in the broker's pool until the
 * surrounding Layer scope is rebuilt.
 *
 * Depends on `SecretProvider` and `Clock`. Layer error channel is
 * `ConfigError` (boot-time `bun:sqlite` import or malformed-row).
 */
const fromSql = (
  opts: FromSqlOptions = {},
): Layer.Layer<
  AccountBroker,
  ConfigError,
  SecretProvider | Clock | LunaSqliteBootstrap
> =>
  Layer.effect(
    AccountBroker,
    Effect.gen(function* () {
      // Phase 27a: pull the bootstrap Tag BEFORE the dynamic
      // `import("bun:sqlite")`. Forcing the dependency this way means the
      // process-wide `Database.setCustomSQLite()` swap (provided by
      // `LunaSqliteBootstrapLive` from @luna/memory) has run before the
      // very first `new Database()` in the process — so Vectorlite's HNSW
      // path is available downstream. We don't branch on the result; the
      // side effect is what matters.
      yield* LunaSqliteBootstrap

      const secrets = yield* SecretProvider
      const clock = yield* Clock
      const dbPath = opts.dbPath ?? defaultDbPath()

      // Dynamic import so stock node+vitest doesn't hard-fail at import time;
      // bun resolves `bun:sqlite` natively. (Mirrors cost-store-sqlite.ts.)
      const bunSqliteSpec = "bun:sqlite"
      const mod = yield* Effect.tryPromise({
        try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
        catch: (cause) =>
          cfgErr(
            "bun:sqlite",
            `failed to import bun:sqlite: ${String(cause)}`,
          ),
      })
      const Database = (mod as { Database?: unknown }).Database as
        | (new (p: string) => BunDb)
        | undefined
      if (!Database) {
        return yield* Effect.fail(
          cfgErr("bun:sqlite", "bun:sqlite module has no `Database` export"),
        )
      }
      const db = new Database(dbPath)

      // Pragmas BEFORE any user data writes.
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA synchronous = NORMAL")
      db.run("PRAGMA foreign_keys = ON")

      // §5.2 migration ladder: per-component `schema_versions` ledger.
      // Component name "accounts" is shared with apps/agent-cli/src/db.ts —
      // the CLI writes the same table on the same DB and must agree on
      // version keying.
      const now = yield* clock.nowMs()
      ensureSchemaVersions(db)
      applyMigration(db, "accounts", 1, SCHEMA_V1, now)

      // §3.4 #4 LIFO: register `db.close` finalizer so the DB closes
      // when the surrounding scope finalizes.
      yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

      const cycleMs = readCycleMs()
      // Env-derived config is immutable for the process — parse ONCE at layer
      // build (mirrors the in-memory broker) and audit it so a mangled
      // LUNA_OVERFLOW_CHAINS surfaces as a boot warning, not a silent fallback.
      const providerEnv = readProviderEnv()
      const overflowCfg = readOverflowConfig()
      const rateTable = readRateTable()
      for (const finding of auditOverflowEnv(process.env, providerEnv)) {
        yield* Effect.logWarning(`[AccountBrokerSql] ${finding}`)
      }

      // Hydrate rows → AccountRecord[].
      const rows = db.query("SELECT * FROM accounts").all() as AccountsRow[]

      const initial: AccountRecord[] = []
      for (const r of rows) {
        if (typeof r.kind !== "string" || r.kind.length === 0) {
          // We don't need to reach directly into the DB to close it —
          // the `addFinalizer` above will run on Layer error.
          return yield* Effect.fail(
            cfgErr(
              `accounts.${r.id}.kind`,
              `account row id="${r.id}" has empty kind`,
            ),
          )
        }
        if (typeof r.secret_ref !== "string" || r.secret_ref.length === 0) {
          return yield* Effect.fail(
            cfgErr(
              `accounts.${r.id}.secret_ref`,
              `account row id="${r.id}" has empty secret_ref`,
            ),
          )
        }
        const cooldownMs =
          typeof r.cooldown_ms === "number" && r.cooldown_ms > 0
            ? r.cooldown_ms
            : 0
        // B3: hydrate the spend accumulator + budget from usage_json (budget is
        // packed IN — §5.1, no new column). A persisted cycle that has already
        // elapsed is reset to fresh at hydrate.
        const spend = parseUsageJson(r.usage_json ?? "{}", now, cycleMs)
        // BLOCKER #2: a BUDGET cooldown is an ABSOLUTE cycle boundary
        // (cycleStartMs + cycleMs). Re-DERIVE it from the persisted spend state
        // rather than trusting `cooldown_ms` — which is stored as remaining-ms
        // and would re-anchor to `now` on every restart, shoving a budget
        // cooldown forward indefinitely (permanent lockout under frequent
        // restarts + §7.5 divergence from the in-memory broker). `cooldown_ms`
        // now carries only TRANSIENT rate-limit cooldowns. parseUsageJson has
        // already reset a stale cycle, so an over-budget spend here is live.
        const budgetCooldownUntil =
          spend.budgetUsd !== undefined &&
          spend.usage !== undefined &&
          spend.usage.spentUsd >= spend.budgetUsd
            ? spend.usage.cycleStartMs + cycleMs
            : undefined
        const cooldownUntilMs =
          budgetCooldownUntil !== undefined
            ? budgetCooldownUntil
            : cooldownMs > 0
              ? now + cooldownMs
              : undefined
        const record: AccountRecord = {
          id: r.id,
          label: r.label || r.id,
          kind: r.kind,
          secretRef: r.secret_ref as SecretRef,
          inFlight: 0,
          lastUsedMs: 0,
          ...(cooldownUntilMs !== undefined && cooldownUntilMs > now
            ? { cooldownUntilMs }
            : {}),
          ...(spend.budgetUsd !== undefined
            ? { budgetUsd: spend.budgetUsd }
            : {}),
          ...(spend.usage !== undefined ? { usage: spend.usage } : {}),
        }
        initial.push(record)
        // CONSUME the persisted transient cooldown: it re-anchored to `now`
        // once (this boot, in-memory above) — clear the row so the SAME
        // remaining-ms isn't re-anchored on EVERY restart. Without this, an
        // account the chain routed away from (so no further report rewrites
        // its row) re-cools for the full duration each boot — under restarts
        // more frequent than the cooldown, an indefinite lockout (the exact
        // BLOCKER #2 pathology, on the transient path).
        if (cooldownMs > 0) {
          db.query("UPDATE accounts SET cooldown_ms = 0 WHERE id = ?").run(r.id)
        }
      }

      const ref = yield* Ref.make<ReadonlyArray<AccountRecord>>(initial)
      // B6: last winning step index per lane (mirror of the in-memory broker).
      const lastStepRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map())

      // ── Public API (mirrors fromAccounts, including B6 chain + B3 meter) ──
      const acquireWith = (
        kind: string,
        pick: (
          accounts: ReadonlyArray<AccountRecord>,
          now: number,
        ) => {
          account: AccountRecord
          model: string
          stepIndex: number
          budgetUsd?: number | undefined
          failoverPossible: boolean
        } | null,
      ): Effect.Effect<AcquiredSession, AccountError, Scope.Scope> =>
        Effect.gen(function* () {
          const t = yield* clock.nowMs()
          const picked = yield* Ref.modify(ref, (accounts) => {
            const chosen = pick(accounts, t)
            if (chosen === null) return [null, accounts] as const
            const next = accounts.map((a) =>
              a.id === chosen.account.id
                ? { ...a, inFlight: a.inFlight + 1, lastUsedMs: t }
                : a,
            )
            return [chosen, next] as const
          })
          if (picked === null) {
            return yield* Effect.fail(
              new AllAccountsExhaustedError({ kind }),
            )
          }
          yield* Effect.addFinalizer(() =>
            Ref.update(ref, (accounts) =>
              accounts.map((a) =>
                a.id === picked.account.id
                  ? { ...a, inFlight: Math.max(0, a.inFlight - 1) }
                  : a,
              ),
            ),
          )
          const resolved = isClaudeCodeLoginSecretRef(picked.account.secretRef)
            ? Redacted.make("")
            : yield* secrets.get(picked.account.secretRef)
          const credential: Credential = {
            kind: picked.account.kind,
            accountId: picked.account.id,
            secretRef: picked.account.secretRef,
            resolvedSecret: resolved,
          }
          return {
            credential,
            model: picked.model,
            stepIndex: picked.stepIndex,
            failoverPossible: picked.failoverPossible,
            ...(picked.budgetUsd !== undefined
              ? { budgetUsd: picked.budgetUsd }
              : {}),
          } satisfies AcquiredSession
        })

      // Provider routing + overflow chain (B6). Selection is the SHARED
      // `pickLaneTarget` (overflow-chain.ts) — the same pure function the
      // in-memory broker runs, so the two cannot drift (§7.5). No chain
      // configured ⇒ single-step fallback BYTE-IDENTICAL to today.
      const acquireSession: AccountBrokerApi["acquireSession"] = (o) =>
        Effect.gen(function* () {
          const lane = o.model
          const chain = resolveChain(lane, overflowCfg)
          const fallbackKind = resolveKind(lane, providerEnv)
          const acq = yield* acquireWith(fallbackKind, (accounts, now) =>
            pickLaneTarget(
              {
                lane,
                chain,
                fallbackKind,
                callerBudgetUsd: o.budgetUsd,
                boundId: o.boundAccountId,
                providerEnv,
              },
              accounts,
              now,
            ),
          )
          if (chain === null || chain.length === 0) return acq
          const lastMap = yield* Ref.get(lastStepRef)
          const prev = lastMap.get(lane)
          yield* Ref.update(lastStepRef, (m) =>
            new Map(m).set(lane, acq.stepIndex),
          )
          if (prev !== undefined && prev !== acq.stepIndex) {
            return { ...acq, advancedFrom: prev }
          }
          return acq
        })

      const acquireTool: AccountBrokerApi["acquireTool"] = (toolName) =>
        acquireWith(`tool-${toolName}`, (accounts, now) => {
          const account = pickAccount(accounts, `tool-${toolName}`, now)
          if (account === null) return null
          return { account, model: toolName, stepIndex: 0, failoverPossible: false }
        }).pipe(Effect.map((acq) => acq.credential))

      // Read-only re-check (see the interface doc comment in
      // account-broker.ts). Reuses the SAME `pickLaneTarget` selection
      // `acquireSession` runs above, so it can never disagree with what a
      // real re-acquire for this lane/bind would do. Only reads `ref`;
      // never `Ref.modify`s it.
      const peekFailoverPossible: AccountBrokerApi["peekFailoverPossible"] = (
        opts,
      ) =>
        Effect.gen(function* () {
          const now = yield* clock.nowMs()
          const accounts = yield* Ref.get(ref)
          const lane = opts.model
          const chain = resolveChain(lane, overflowCfg)
          const fallbackKind = resolveKind(lane, providerEnv)
          const target = pickLaneTarget(
            {
              lane,
              chain,
              fallbackKind,
              boundId: opts.boundAccountId,
              providerEnv,
            },
            accounts,
            now,
          )
          return target !== null
        })

      // Write-back helper: persist a single account's mutable fields (§5.1
      // `usage_json` + `cooldown_ms`) so a budget-exhausted account SURVIVES a
      // restart still cooled down until the cycle reset. `cooldown_ms` is stored
      // as remaining ms (it hydrates as `now + cooldown_ms`), matching the boot
      // contract; a non-cooled account writes 0.
      const writeBack = (a: AccountRecord, nowMs: number): void => {
        const usageJson = serializeUsageJson(a.usage, a.budgetUsd)
        // BLOCKER #2: persist `cooldown_ms` ONLY for TRANSIENT (rate-limit)
        // cooldowns. A budget cooldown is an absolute cycle boundary re-derived
        // at hydrate from usage_json, so writing it as remaining-ms here would
        // re-anchor it forward on restart. A budget-exhausted account writes 0.
        const budgetExhausted =
          a.budgetUsd !== undefined &&
          a.usage !== undefined &&
          a.usage.spentUsd >= a.budgetUsd
        const remainingCooldownMs =
          !budgetExhausted &&
          a.cooldownUntilMs !== undefined &&
          a.cooldownUntilMs > nowMs
            ? a.cooldownUntilMs - nowMs
            : 0
        db.query(
          "UPDATE accounts SET usage_json = ?, cooldown_ms = ? WHERE id = ?",
        ).run(usageJson, remainingCooldownMs, a.id)
      }

      const report: AccountBrokerApi["report"] = (usage) =>
        Effect.gen(function* () {
          if (
            usage.kind === "rate_limit" ||
            usage.kind === "session_limit" ||
            usage.kind === "quota_exhausted" ||
            usage.kind === "model_busy"
          ) {
            const t = yield* clock.nowMs()
            const defaultMs =
              usage.kind === "session_limit"
                ? SESSION_LIMIT_COOLDOWN_MS
                : DEFAULT_COOLDOWN_MS
            const cooldownUntil =
              t + (usage.retryAfterMs ?? defaultMs)
            // Single atomic Ref.modify that RETURNS the updated record, so the
            // writeBack below persists exactly the state this report produced
            // (a get-after-update could interleave with a concurrent report).
            const acct = yield* Ref.modify(ref, (accounts) => {
              let updated: AccountRecord | undefined
              const next = accounts.map((a) => {
                if (a.id !== usage.accountId) return a
                updated = {
                  ...a,
                  // Never SHORTEN an existing cooldown (mirrors the in-memory
                  // broker): a budget cooldown at the cycle boundary must
                  // survive a transient 429 from a still-in-flight turn.
                  cooldownUntilMs: Math.max(
                    a.cooldownUntilMs ?? 0,
                    cooldownUntil,
                  ),
                }
                return updated
              })
              return [updated, next] as const
            })
            // Persist the cooldown so a rate-limited account survives ONE
            // restart (hydrate consumes the row — see the hydrate loop).
            if (acct) yield* Effect.sync(() => writeBack(acct, t))
            return
          }
          if (usage.kind !== "usage") return
          // B3 spend-meter: same accumulate/exhaust as B2, then write back.
          const t = yield* clock.nowMs()
          const acct = yield* Ref.modify(ref, (accounts) => {
            let updated: AccountRecord | undefined
            const next = accounts.map((a) => {
              if (a.id !== usage.accountId) return a
              const update = applyUsage(
                a,
                {
                  model: usage.model,
                  tokensIn: usage.tokensIn,
                  tokensOut: usage.tokensOut,
                  ...(usage.cacheRead !== undefined
                    ? { cacheRead: usage.cacheRead }
                    : {}),
                  ...(usage.cacheWrite !== undefined
                    ? { cacheWrite: usage.cacheWrite }
                    : {}),
                },
                usage.budgetUsd ?? a.budgetUsd,
                t,
                cycleMs,
                rateTable,
              )
              updated = {
                ...a,
                usage: update.usage,
                ...(update.cooldownUntilMs !== undefined
                  ? { cooldownUntilMs: update.cooldownUntilMs }
                  : {}),
              }
              return updated
            })
            return [updated, next] as const
          })
          // WRITE BACK usage_json + cooldown_ms for the affected account. Even
          // with no budget this persists spend telemetry (survives restart);
          // routing is unaffected — pickAccount never reads usage. (Review #7
          // noted the per-turn write as a benign no-config delta; kept, since
          // B3.1 asserts telemetry persistence and it's harmless.)
          if (acct) yield* Effect.sync(() => writeBack(acct, t))
        })

      const _inspect: AccountBrokerApi["_inspect"] = () => Ref.get(ref)

      const list: AccountBrokerApi["list"] = (kindFilter) =>
        Effect.gen(function* () {
          const t = yield* clock.nowMs()
          const accounts = yield* Ref.get(ref)
          const filtered = kindFilter
            ? accounts.filter((a) => a.kind === kindFilter)
            : accounts
          return filtered.map((a): AccountSummary => ({
            id: a.id,
            label: a.label ?? a.id,
            kind: a.kind,
            health:
              a.cooldownUntilMs !== undefined && a.cooldownUntilMs > t
                ? "rate_limited"
                : "healthy",
          }))
        })

      // Suppress "unused" lint without changing surface — Redacted is
      // imported for the JSDoc reference to redacted secrets.
      void Redacted

      return {
        acquireSession,
        acquireTool,
        report,
        _inspect,
        list,
        peekFailoverPossible,
      } satisfies AccountBrokerApi
    }),
  )

// Re-export under the canonical AccountBrokerLayer barrel via index.ts.
export { fromSql }
