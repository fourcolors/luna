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
 *   - `anthropic` → matches `acquireSession({model})`
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
import { SecretProvider, type SecretRef } from "../secret-provider/index.js"
import { pickAccount, type AccountRecord } from "./rotation-policy.js"

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

/** Seed shape used by the layer factory. */
export interface AccountSeed {
  readonly id: string
  readonly kind: string
  readonly secretRef: SecretRef
}

export type AccountError = AllAccountsExhaustedError | ConfigError

export interface AccountBrokerApi {
  readonly acquireSession: (opts: {
    readonly model: string
    readonly budgetUsd?: number
    readonly boundAccountId?: string
  }) => Effect.Effect<Credential, AccountError, Scope.Scope>

  readonly acquireTool: (
    toolName: string,
  ) => Effect.Effect<Credential, AccountError, Scope.Scope>

  readonly report: (usage: UsageReport) => Effect.Effect<void>

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
        kind: s.kind,
        secretRef: s.secretRef,
        inFlight: 0,
        lastUsedMs: 0,
      }))
      const ref = yield* Ref.make<ReadonlyArray<AccountRecord>>(initial)

      const acquireWithKind = (
        kind: string,
        boundId: string | undefined,
      ): Effect.Effect<Credential, AccountError, Scope.Scope> =>
        Effect.gen(function* () {
          const now = yield* clock.nowMs()
          // Atomic pick + inFlight bump in a single Ref.modify.
          const picked = yield* Ref.modify(ref, (accounts) => {
            const chosen = pickAccount(accounts, kind, now, boundId)
            if (chosen === null) return [null, accounts] as const
            const next = accounts.map((a) =>
              a.id === chosen.id
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
                a.id === picked.id
                  ? { ...a, inFlight: Math.max(0, a.inFlight - 1) }
                  : a,
              ),
            ),
          )
          // Resolve the secret AFTER the finalizer is registered, so a
          // resolution failure still releases inFlight.
          const resolved = yield* secrets.get(picked.secretRef)
          return {
            kind: picked.kind,
            accountId: picked.id,
            secretRef: picked.secretRef,
            resolvedSecret: resolved,
          } satisfies Credential
        })

      const acquireSession: AccountBrokerApi["acquireSession"] = (opts) =>
        acquireWithKind("anthropic", opts.boundAccountId)

      const acquireTool: AccountBrokerApi["acquireTool"] = (toolName) =>
        acquireWithKind(`tool-${toolName}`, undefined)

      const report: AccountBrokerApi["report"] = (usage) =>
        Effect.gen(function* () {
          if (usage.kind !== "rate_limit") return
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
        })

      const _inspect: AccountBrokerApi["_inspect"] = () => Ref.get(ref)

      return {
        acquireSession,
        acquireTool,
        report,
        _inspect,
      } satisfies AccountBrokerApi
    }),
  )

/** Layer factories namespaced under the Tag for ergonomic call sites. */
export const AccountBrokerLayer = {
  fromAccounts,
} as const
