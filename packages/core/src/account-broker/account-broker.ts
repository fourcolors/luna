/**
 * AccountBroker — Persistence-layer service that owns the in-memory
 * account pool and hands out Scoped credentials.
 *
 * Frozen contract:
 *   - §0.2: per-query rotation via env overlay; sticky-pin on
 *     `boundAccountId` for cache warmth; OAuth subscription tokens
 *     resolved through SecretProvider (not API keys).
 *   - §7.5: three-method surface — `acquireSession`, `acquireTool`,
 *     `report`. (§7.5's prose "rotation only at session boundaries" is
 *     superseded by §0.2 — §7 is the revisable column.)
 *   - §3.4: Scope-attached `inFlight` via `Effect.addFinalizer`. There
 *     is no explicit release — the caller's Scope close decrements.
 *   - §6.2: exhaustion surfaces as `AllAccountsExhaustedError`.
 *   - §4 / §12.2 #6: core stays SDK-free at runtime — Credential is a
 *     plain shape defined here, not borrowed from the SDK.
 *
 * Phase 9 ships an in-memory `Ref<ReadonlyArray<AccountRecord>>` pool
 * seeded by `AccountBrokerLayer.fromAccounts(...)`. SQL persistence
 * (§5.1 `accounts` table) is deferred to a later phase.
 *
 * Convention for `kind`:
 *   - provider kind resolved from the model → matches `acquireSession({model})`
 *     (resolveProfile: claude/`default` → `anthropic`; gemini-* → `google`; *:cloud → `ollama-cloud`)
 *   - `tool-<toolName>` → matches `acquireTool(toolName)`
 *   `acquireTool("foo")` looks up `kind: "tool-foo"`.
 */
import { Effect, Layer, Redacted, Ref } from "effect"
import type * as Scope from "effect/Scope"
import {
  AllAccountsExhaustedError,
  ConfigError,
} from "../errors.js"
import { Clock } from "../clock.js"
import {
  SecretProvider,
  isClaudeCodeLoginSecretRef,
  type SecretRef,
} from "../secret-provider/index.js"
import { pickAccount, type AccountRecord } from "./rotation-policy.js"
import { resolveProfile } from "../provider-profile.js"
import {
  pickChainTarget,
  readOverflowConfig,
  resolveChain,
  type ChainStep,
} from "../overflow-chain.js"
import { readRateTable } from "../pricing.js"
import { applyUsage, readCycleMs } from "./spend-meter.js"

/** Public account summary — no secrets. Used by the account-switcher UI. */
export interface AccountSummary {
  readonly id: string
  readonly label: string
  readonly kind: string
  /** "healthy" | "rate_limited" */
  readonly health: string
}

/** Public credential handed to callers. `resolvedSecret` is redacted. */
export interface Credential {
  readonly kind: string
  readonly accountId: string
  readonly secretRef: SecretRef
  readonly resolvedSecret: Redacted.Redacted<string>
}

/** Usage report passed to `report(...)` after a session or tool call. */
export type UsageReport =
  | { readonly accountId: string; readonly kind: "success" }
  | { readonly accountId: string; readonly kind: "error" }
  | {
      readonly accountId: string
      readonly kind: "rate_limit"
      readonly retryAfterMs?: number
    }
  | {
      /** B-phase spend-meter: token usage for one completed turn. Priced via
       * priceTurnUsd(rateFor(model, account.kind)) and accumulated against the
       * account's rolling cycle; if it crosses the account's budget the broker
       * cools the account down until the next cycle boundary. */
      readonly accountId: string
      readonly kind: "usage"
      readonly model: string
      readonly tokensIn: number
      readonly tokensOut: number
      readonly cacheRead?: number
      readonly cacheWrite?: number
    }

/** Seed shape used by the layer factory. */
export interface AccountSeed {
  readonly id: string
  readonly label?: string
  readonly kind: string
  readonly secretRef: SecretRef
  /** Optional per-account spend ceiling in USD (B-phase). Seed-level fallback;
   * a chain step's `budgetUsd` takes precedence when present. */
  readonly budgetUsd?: number
}

/**
 * Result of acquiring a session credential. Widened in the B-phase to carry the
 * overflow-chain resolution alongside the credential:
 *   - `credential` — the resolved {@link Credential} (kind/accountId/secret).
 *   - `model`      — the model string the SDK should be pointed at for the
 *     winning chain step (the caller's model when no chain is configured).
 *   - `stepIndex`  — index of the winning step in the lane's chain (0 when no
 *     chain — the single-step fallback).
 *   - `advancedFrom` — the lane's last winning step index when it DIFFERS from
 *     `stepIndex` (i.e. the chain advanced past a previously-used step), so the
 *     adapter can emit an AccountSwitch alert. Undefined when no advance / no
 *     chain.
 */
export interface AcquiredSession {
  readonly credential: Credential
  readonly model: string
  readonly stepIndex: number
  readonly advancedFrom?: number
}

export type AccountError = AllAccountsExhaustedError | ConfigError

export interface AccountBrokerApi {
  readonly acquireSession: (opts: {
    readonly model: string
    readonly budgetUsd?: number
    readonly boundAccountId?: string
  }) => Effect.Effect<AcquiredSession, AccountError, Scope.Scope>

  readonly acquireTool: (
    toolName: string,
  ) => Effect.Effect<Credential, AccountError, Scope.Scope>

  readonly report: (usage: UsageReport) => Effect.Effect<void>

  /**
   * Returns public account summaries — no secrets, no resolvedSecret.
   * Used by the account-switcher dropdown.
   * @param kindFilter — if provided, only return accounts matching this kind.
   */
  readonly list: (kindFilter?: string) => Effect.Effect<ReadonlyArray<AccountSummary>>

  /**
   * Test-only inspector. NOT part of the design-frozen §7.5 surface;
   * exposed for tests/sim. Production callers should not rely on this.
   */
  readonly _inspect: () => Effect.Effect<ReadonlyArray<AccountRecord>>
}

export class AccountBroker extends Effect.Tag(
  "luna/AccountBroker",
)<AccountBroker, AccountBrokerApi>() {}

const DEFAULT_COOLDOWN_MS = 60_000

/**
 * Build an AccountBroker layer from a static seed. Depends on
 * `SecretProvider` and `Clock`.
 */
const fromAccounts = (
  seeds: ReadonlyArray<AccountSeed>,
): Layer.Layer<AccountBroker, never, SecretProvider | Clock> =>
  Layer.effect(
    AccountBroker,
    Effect.gen(function* () {
      const secrets = yield* SecretProvider
      const clock = yield* Clock
      const initial: ReadonlyArray<AccountRecord> = seeds.map((s) => ({
        id: s.id,
        label: s.label ?? s.id,
        kind: s.kind,
        secretRef: s.secretRef,
        inFlight: 0,
        lastUsedMs: 0,
        ...(s.budgetUsd !== undefined ? { budgetUsd: s.budgetUsd } : {}),
      }))
      const ref = yield* Ref.make<ReadonlyArray<AccountRecord>>(initial)
      // B6: last winning step index per lane, so the adapter can detect a chain
      // advance (advancedFrom !== stepIndex). Keyed by lane name; absent until
      // the first acquire on a lane that resolves a chain.
      const lastStepRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
      const cycleMs = readCycleMs()

      /**
       * Shared acquire core. `pick` runs INSIDE the atomic Ref.modify and
       * returns either the chosen target (account + the model/stepIndex the
       * chain resolved) or null (exhausted → AllAccountsExhaustedError with
       * `kind`). The inFlight bump + finalizer are identical to the prior
       * single-kind path; only the selection logic is pluggable.
       */
      const acquireWith = (
        kind: string,
        pick: (
          accounts: ReadonlyArray<AccountRecord>,
          now: number,
        ) => { account: AccountRecord; model: string; stepIndex: number } | null,
      ): Effect.Effect<AcquiredSession, AccountError, Scope.Scope> =>
        Effect.gen(function* () {
          const now = yield* clock.nowMs()
          // Atomic pick + inFlight bump in a single Ref.modify.
          const picked = yield* Ref.modify(ref, (accounts) => {
            const chosen = pick(accounts, now)
            if (chosen === null) return [null, accounts] as const
            const next = accounts.map((a) =>
              a.id === chosen.account.id
                ? { ...a, inFlight: a.inFlight + 1, lastUsedMs: now }
                : a,
            )
            return [chosen, next] as const
          })
          if (picked === null) {
            return yield* Effect.fail(
              new AllAccountsExhaustedError({ kind }),
            )
          }
          // Decrement inFlight on Scope close — this IS the release path.
          yield* Effect.addFinalizer(() =>
            Ref.update(ref, (accounts) =>
              accounts.map((a) =>
                a.id === picked.account.id
                  ? { ...a, inFlight: Math.max(0, a.inFlight - 1) }
                  : a,
              ),
            ),
          )
          // Resolve the secret AFTER the finalizer is registered, so a
          // resolution failure still releases inFlight.
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
          } satisfies AcquiredSession
        })

      /**
       * Provider routing + overflow chain (B6). The model string names a logical
       * lane; we resolve the lane's chain from `LUNA_OVERFLOW_CHAINS` and walk it
       * with `pickChainTarget` (REUSING pickAccount's cooldown/LRU/pin logic). No
       * chain configured ⇒ single-step fallback that is BYTE-IDENTICAL to today:
       * kind = resolveProfile(model).kind, model = caller's model, stepIndex = 0.
       */
      const acquireSession: AccountBrokerApi["acquireSession"] = (opts) =>
        Effect.gen(function* () {
          const lane = opts.model
          const chain = resolveChain(lane, readOverflowConfig())
          const fallbackKind = resolveProfile(lane).kind
          const acq = yield* acquireWith(fallbackKind, (accounts, now) => {
            if (chain === null || chain.length === 0) {
              // Single-step fallback — identical to the pre-B6 path.
              const account = pickAccount(
                accounts,
                fallbackKind,
                now,
                opts.boundAccountId,
              )
              if (account === null) return null
              return { account, model: lane, stepIndex: 0 }
            }
            const hit = pickChainTarget(
              chain as ReadonlyArray<ChainStep>,
              accounts,
              now,
              opts.boundAccountId,
            )
            if (hit === null) return null
            return {
              account: hit.account,
              model: hit.step.model,
              stepIndex: hit.stepIndex,
            }
          })
          // Compute advancedFrom against the lane's last winning step. Only
          // meaningful when a chain exists; the no-chain path keeps stepIndex 0
          // and never advances → advancedFrom stays undefined (back-compat).
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
          return { account, model: toolName, stepIndex: 0 }
        }).pipe(Effect.map((acq) => acq.credential))

      const report: AccountBrokerApi["report"] = (usage) =>
        Effect.gen(function* () {
          if (usage.kind === "rate_limit") {
            const now = yield* clock.nowMs()
            const cooldownUntil =
              now + (usage.retryAfterMs ?? DEFAULT_COOLDOWN_MS)
            yield* Ref.update(ref, (accounts) =>
              accounts.map((a) =>
                a.id === usage.accountId
                  ? { ...a, cooldownUntilMs: cooldownUntil }
                  : a,
              ),
            )
            return
          }
          if (usage.kind !== "usage") return
          // B2 spend-meter: price + accumulate against the account's rolling
          // cycle; if the spend crosses the account's budget, cool it down until
          // the next cycle boundary. A no-budget account accumulates only.
          const now = yield* clock.nowMs()
          const rateTable = readRateTable()
          yield* Ref.update(ref, (accounts) =>
            accounts.map((a) => {
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
                a.budgetUsd,
                now,
                cycleMs,
                rateTable,
              )
              return {
                ...a,
                usage: update.usage,
                ...(update.cooldownUntilMs !== undefined
                  ? { cooldownUntilMs: update.cooldownUntilMs }
                  : {}),
              }
            }),
          )
        })

      const _inspect: AccountBrokerApi["_inspect"] = () => Ref.get(ref)

      const list: AccountBrokerApi["list"] = (kindFilter) =>
        Effect.gen(function* () {
          const now = yield* clock.nowMs()
          const accounts = yield* Ref.get(ref)
          const filtered = kindFilter
            ? accounts.filter((a) => a.kind === kindFilter)
            : accounts
          return filtered.map((a) => ({
            id: a.id,
            label: a.label ?? a.id,
            kind: a.kind,
            health:
              a.cooldownUntilMs !== undefined && a.cooldownUntilMs > now
                ? "rate_limited"
                : "healthy",
          }))
        })

      return {
        acquireSession,
        acquireTool,
        report,
        _inspect,
        list,
      } satisfies AccountBrokerApi
    }),
  )

/** Layer factories namespaced under the Tag for ergonomic call sites. */
export const AccountBrokerLayer = {
  fromAccounts,
} as const
