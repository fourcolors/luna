/**
 * RoutedOpSecretProvider — explicit per-ref account routing for
 * 1Password (Phase 25d, DESIGN.md §2.2.11).
 *
 * Wraps N single-account `OnePasswordSecretProvider` layers, each
 * registered by `accountLabel`. Refs are dispatched as follows:
 *
 *   - `luna-op://<label>/<rest>` → routes to the layer registered
 *     under <label>. Unknown label / reserved label / malformed ref
 *     → ConfigError. NO fall-through to other accounts.
 *
 *   - `op://...` → allowed iff exactly one OP layer is registered;
 *     dispatches to that layer. With 0 or ≥2 accounts registered
 *     → ConfigError directing the operator to use luna-op://<label>/...
 *
 *   - Anything else → ConfigError (unsupported scheme). The error is
 *     shaped so `secretProviderFirstOf` falls through cleanly to the
 *     next provider in the chain (e.g. EnvSecretProvider).
 *
 * The dispatcher rewrites `luna-op://<label>/<rest>` → `op://<rest>`
 * before handing it to the inner backend; the backend never sees the
 * `luna-op://` prefix. Errors from the inner layer are wrapped via
 * `Effect.mapError` to prepend `(account=<label>) ` to the message.
 *
 * Tokens never appear in any error message — only the `accountLabel`
 * does, and only as a diagnostic breadcrumb.
 */
import { Context, Effect, Layer } from "effect"
import { ConfigError } from "../errors.js"
import { SecretProvider, type SecretProviderApi } from "./secret-provider.js"

/** Account-label regex (DESIGN §2.2.11). */
export const ACCOUNT_LABEL_RE = /^[a-z][a-z0-9-]{0,30}$/
/** Reserved labels — would collide with other ref schemes. */
export const RESERVED_LABELS: ReadonlySet<string> = new Set([
  "env",
  "file",
  "op",
])

const OP_PREFIX = "op://"
const LUNA_OP_PREFIX = "luna-op://"

export interface RoutedOpAccount {
  /** Matches ACCOUNT_LABEL_RE and is not in RESERVED_LABELS. */
  readonly label: string
  /** A single-account OnePasswordSecretProvider layer. */
  readonly layer: Layer.Layer<SecretProvider, ConfigError>
}

export interface RoutedOpOptions {
  readonly accounts: ReadonlyArray<RoutedOpAccount>
}

const validateLabel = (label: string): ConfigError | null => {
  if (RESERVED_LABELS.has(label)) {
    return new ConfigError({
      module: "RoutedOpSecretProvider",
      key: "accountLabel",
      message: `account label "${label}" is reserved (env, file, op)`,
    })
  }
  if (!ACCOUNT_LABEL_RE.test(label)) {
    return new ConfigError({
      module: "RoutedOpSecretProvider",
      key: "accountLabel",
      message: `account label "${label}" does not match ${ACCOUNT_LABEL_RE.source}`,
    })
  }
  return null
}

const make = (
  opts: RoutedOpOptions,
): Layer.Layer<SecretProvider, ConfigError> =>
  Layer.effect(
    SecretProvider,
    Effect.gen(function* () {
      // 1. Construction-time invariants.
      const seen = new Set<string>()
      for (const a of opts.accounts) {
        const e = validateLabel(a.label)
        if (e !== null) return yield* Effect.fail(e)
        if (seen.has(a.label)) {
          return yield* Effect.fail(
            new ConfigError({
              module: "RoutedOpSecretProvider",
              key: "accountLabel",
              message: `duplicate account label "${a.label}"`,
            }),
          )
        }
        seen.add(a.label)
      }

      // 2. Build each inner layer once and capture its SecretProvider impl.
      const byLabel = new Map<string, SecretProviderApi>()
      for (const a of opts.accounts) {
        const ctx = yield* Layer.build(a.layer).pipe(Effect.scoped)
        byLabel.set(a.label, Context.get(ctx, SecretProvider))
      }
      const labels = Array.from(byLabel.keys())
      const labelsList = labels.length === 0 ? "[]" : `[${labels.join(", ")}]`

      const get: SecretProviderApi["get"] = (ref) => {
        if (ref.startsWith(LUNA_OP_PREFIX)) {
          const rest = ref.slice(LUNA_OP_PREFIX.length)
          const slash = rest.indexOf("/")
          if (slash < 0 || rest.length === 0) {
            return Effect.fail(
              new ConfigError({
                module: "RoutedOpSecretProvider",
                key: "ref",
                message: `malformed luna-op:// ref: missing <label> or <rest>`,
              }),
            )
          }
          const label = rest.slice(0, slash)
          const remainder = rest.slice(slash + 1)
          if (label.length === 0) {
            return Effect.fail(
              new ConfigError({
                module: "RoutedOpSecretProvider",
                key: "ref",
                message: `malformed luna-op:// ref: empty <label>`,
              }),
            )
          }
          if (remainder.length === 0) {
            return Effect.fail(
              new ConfigError({
                module: "RoutedOpSecretProvider",
                key: "ref",
                message: `malformed luna-op:// ref: empty <rest> after label`,
              }),
            )
          }
          // Validate label shape WITHOUT echoing the rest of the ref
          // (privacy — keep paths out of error strings).
          const labelErr = validateLabel(label)
          if (labelErr !== null) return Effect.fail(labelErr)
          const inner = byLabel.get(label)
          if (inner === undefined) {
            return Effect.fail(
              new ConfigError({
                module: "RoutedOpSecretProvider",
                key: "ref",
                message: `luna-op account "${label}" not registered; available: ${labelsList}`,
              }),
            )
          }
          // Rewrite to op:// and delegate. Wrap error with breadcrumb.
          const rewritten = `${OP_PREFIX}${remainder}`
          return inner.get(rewritten).pipe(
            Effect.mapError(
              (e) =>
                new ConfigError({
                  module: e.module,
                  key: e.key,
                  message: `(account=${label}) ${e.message}`,
                }),
            ),
          )
        }

        if (ref.startsWith(OP_PREFIX)) {
          if (byLabel.size === 1) {
            // Exactly one account registered — bare op:// resolves.
            const only = byLabel.values().next().value as SecretProviderApi
            return only.get(ref)
          }
          return Effect.fail(
            new ConfigError({
              module: "RoutedOpSecretProvider",
              key: "ref",
              message:
                `bare op:// requires exactly 1 registered OP account ` +
                `(have ${byLabel.size}); use luna-op://<label>/... — ` +
                `registered: ${labelsList}`,
            }),
          )
        }

        // Unsupported scheme — surface as ConfigError so firstOf falls
        // through to the next provider (matches OnePasswordBackend's
        // pattern).
        return Effect.fail(
          new ConfigError({
            module: "RoutedOpSecretProvider",
            key: "ref",
            message: `not an op:// or luna-op:// reference: "${ref}"`,
          }),
        )
      }

      return { get } satisfies SecretProviderApi
    }),
  )

export const RoutedOpSecretProvider = {
  make,
} as const

/**
 * Boot-time helper: given the secret_ref strings from the §5.1
 * `accounts` table and the set of registered OP account labels,
 * return the list of refs that point at unknown labels.
 *
 * Refs that are not `luna-op://...` are ignored (they are not
 * subject to label routing). Refs with malformed shapes are also
 * silently ignored — the wrapper itself reports those at resolve
 * time; this helper is a quick boot-time sanity check, not a
 * grammar validator.
 *
 * Caller responsibility: log the result. The wrapper does NOT read
 * the DB (separation of concerns).
 */
export interface DanglingRef {
  readonly ref: string
  readonly label: string
}

export const validateAccountsTableLabels = (
  refs: ReadonlyArray<string>,
  registeredLabels: ReadonlyArray<string>,
): ReadonlyArray<DanglingRef> => {
  const known = new Set(registeredLabels)
  const out: Array<DanglingRef> = []
  for (const ref of refs) {
    if (!ref.startsWith(LUNA_OP_PREFIX)) continue
    const rest = ref.slice(LUNA_OP_PREFIX.length)
    const slash = rest.indexOf("/")
    if (slash <= 0) continue
    const label = rest.slice(0, slash)
    if (label.length === 0) continue
    if (!known.has(label)) out.push({ ref, label })
  }
  return out
}
