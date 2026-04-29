/**
 * OnePasswordSecretProvider — resolves native `op://VAULT/ITEM/FIELD
 * SecretRefs by shelling out to the `op` CLI.
 *
 * Design notes:
 *   - Refs not starting with `op://` → ConfigError (so `firstOf` falls
 *     through cleanly to other backends). The backend is `op://`-only
 *     by hard contract — `luna-op://` never reaches here; the
 *     RoutedOpSecretProvider rewrites and dispatches above this layer.
 *   - Auth: `OP_SERVICE_ACCOUNT_TOKEN` is forwarded to the spawned
 *     process; tests can override via the `token` option.
 *   - Cache: Layer-scoped Map keyed by ref, TTL 5min default. Race on
 *     two concurrent misses is accepted (extra spawn — no correctness
 *     impact). Documented inline.
 *   - Errors are mapped to ConfigError per §6.1; no new error class.
 */
import { spawn } from "node:child_process"
import { Effect, Layer, Redacted, Ref } from "effect"
import { ConfigError } from "../errors.js"
import { Clock } from "../clock.js"
import { SecretProvider, type SecretProviderApi } from "./secret-provider.js"
import {
  ACCOUNT_LABEL_RE,
  RESERVED_LABELS,
} from "./routed-op-provider.js"

const OP_PREFIX = "op://"
const DEFAULT_TTL_MS = 300_000 // 5 minutes

export interface OnePasswordOptions {
  /**
   * Required: account label this layer represents. Used for diagnostic
   * context at the wrapper layer (RoutedOpSecretProvider) — the
   * backend itself does not thread it through error messages. Must
   * match `^[a-z][a-z0-9-]{0,30}$` and not be in {env, file, op}.
   * Defense-in-depth — bypassing the wrapper still rejects bad labels.
   */
  readonly accountLabel: string
  /** Optional service-account token; defaults to OP_SERVICE_ACCOUNT_TOKEN env. */
  readonly token?: string
  /** TTL for the in-memory cache; defaults to 5 minutes. */
  readonly ttlMs?: number
}

interface CacheEntry {
  readonly redacted: Redacted.Redacted<string>
  readonly expiresAt: number
}

/**
 * Spawn `op read --no-newline -- <ref>`, capture stdout/stderr, return
 * the trimmed stdout or a ConfigError. Token (if provided) is passed via
 * the spawned process env as `OP_SERVICE_ACCOUNT_TOKEN`.
 *
 * Error mapping (all → ConfigError, module "OnePasswordSecretProvider"):
 *   - ENOENT (missing `op` binary) → field "op", message about PATH/install
 *   - non-zero exit                → field "op", message includes stderr tail
 *   - empty stdout (after trim)    → field "ref", message "empty secret"
 */
const spawnOpRead = (
  ref: string,
  token: string | undefined,
): Effect.Effect<string, ConfigError> =>
  Effect.async<string, ConfigError>((resume) => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (token !== undefined) env.OP_SERVICE_ACCOUNT_TOKEN = token
    let child
    try {
      child = spawn("op", ["read", "--no-newline", "--", ref], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (cause) {
      resume(
        Effect.fail(
          new ConfigError({
            module: "OnePasswordSecretProvider",
            key: "op",
            message: `failed to spawn 'op': ${String(cause)}`,
          }),
        ),
      )
      return
    }
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d: Buffer | string) => {
      stdout += typeof d === "string" ? d : d.toString("utf8")
    })
    child.stderr?.on("data", (d: Buffer | string) => {
      stderr += typeof d === "string" ? d : d.toString("utf8")
    })
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        resume(
          Effect.fail(
            new ConfigError({
              module: "OnePasswordSecretProvider",
              key: "op",
              message:
                "'op' binary not found on PATH; install the 1Password CLI " +
                "(https://developer.1password.com/docs/cli/) and ensure it is on PATH",
            }),
          ),
        )
      } else {
        resume(
          Effect.fail(
            new ConfigError({
              module: "OnePasswordSecretProvider",
              key: "op",
              message: `'op' spawn error: ${err.message}`,
            }),
          ),
        )
      }
    })
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().slice(-400)
        resume(
          Effect.fail(
            new ConfigError({
              module: "OnePasswordSecretProvider",
              key: "op",
              message: `'op read' exited with code ${code}: ${tail}`,
            }),
          ),
        )
        return
      }
      const trimmed = stdout.replace(/\n+$/, "")
      if (trimmed.length === 0) {
        resume(
          Effect.fail(
            new ConfigError({
              module: "OnePasswordSecretProvider",
              key: "ref",
              message: "empty secret",
            }),
          ),
        )
        return
      }
      resume(Effect.succeed(trimmed))
    })
  })

const make = (
  opts: OnePasswordOptions,
): Layer.Layer<SecretProvider, ConfigError, Clock> => {
  // Defense-in-depth label validation. RoutedOpSecretProvider already
  // validates at construction; a future caller bypassing the wrapper
  // still gets the same guarantee here. Surfacing as a Layer.fail puts
  // the error in the Layer's error channel without forcing every
  // caller into Effect.gen at the make() call site.
  if (typeof opts.accountLabel !== "string") {
    return Layer.fail(
      new ConfigError({
        module: "OnePasswordSecretProvider",
        key: "accountLabel",
        message: `accountLabel is required`,
      }),
    )
  }
  if (RESERVED_LABELS.has(opts.accountLabel)) {
    return Layer.fail(
      new ConfigError({
        module: "OnePasswordSecretProvider",
        key: "accountLabel",
        message: `account label "${opts.accountLabel}" is reserved (env, file, op)`,
      }),
    )
  }
  if (!ACCOUNT_LABEL_RE.test(opts.accountLabel)) {
    return Layer.fail(
      new ConfigError({
        module: "OnePasswordSecretProvider",
        key: "accountLabel",
        message: `account label "${opts.accountLabel}" does not match ${ACCOUNT_LABEL_RE.source}`,
      }),
    )
  }
  return Layer.effect(
    SecretProvider,
    Effect.gen(function* () {
      const clock = yield* Clock
      const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
      const token =
        opts.token !== undefined
          ? opts.token
          : process.env.OP_SERVICE_ACCOUNT_TOKEN
      // Layer-scoped cache. Concurrent miss-on-same-ref races accepted
      // (worst case: two `op` spawns); cache is best-effort, not a lock.
      const cacheRef = yield* Ref.make<Map<string, CacheEntry>>(new Map())

      const get: SecretProviderApi["get"] = (ref) =>
        Effect.gen(function* () {
          // Hard contract: backend only handles op://. luna-op:// is
          // dispatched + rewritten by RoutedOpSecretProvider one layer up.
          if (!ref.startsWith(OP_PREFIX)) {
            return yield* Effect.fail(
              new ConfigError({
                module: "OnePasswordSecretProvider",
                key: "ref",
                message: `not an op:// reference: "${ref}"`,
              }),
            )
          }
          const now = yield* clock.nowMs()
          const cache = yield* Ref.get(cacheRef)
          const hit = cache.get(ref)
          if (hit && hit.expiresAt > now) return hit.redacted
          const value = yield* spawnOpRead(ref, token)
          const redacted = Redacted.make(value)
          yield* Ref.update(cacheRef, (m) => {
            const next = new Map(m)
            next.set(ref, { redacted, expiresAt: now + ttlMs })
            return next
          })
          return redacted
        })

      return { get } satisfies SecretProviderApi
    }),
  )
}

export const OnePasswordSecretProvider = {
  make,
} as const
