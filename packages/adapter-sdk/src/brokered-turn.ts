// packages/adapter-sdk/src/brokered-turn.ts
//
// Shared "one brokered reasoner turn" helper for wake-reasoner.ts and
// dream-reasoner.ts. Both reasoners previously hand-copied a ~50-line
// acquire→model-gate→env-overlay block (differing only in env-var name and
// error class) and — the real bug — NEITHER reported usage or throttles back
// to the broker, so chain budgets and 429 failover were unenforced on exactly
// the always-on lanes (nightly Dream, wake cron) the overflow chain was built
// for. This module owns:
//
//   1. the reasoner-lane model env pick (primary var → LUNA_REASONER_MODEL),
//   2. the per-turn scoped acquire + SDK options fragment (model gate +
//      provider env overlay — Redacted unwrap stays INSIDE
//      buildBrokerEnvOverlay, preserving the single-unwrap invariant),
//   3. B4 parity: a `usage` report priced against the broker-resolved model
//      (with the winning step's effective budget) at the result frame,
//   4. B9 parity: a `rate_limit` report when the terminal error classifies as
//      a throttle AND the broker said failover is viable.
import { Effect } from "effect"
import {
  CLAUDE_CODE_LOGIN_SECRET_REF,
  profileForKind,
  readProviderEnv,
  toWireModel,
  type AccountBrokerApi,
  type AcquiredSession,
} from "@luna/core"
import {
  buildBrokerBaseEnv,
  buildBrokerEnvOverlay,
} from "./broker-env-overlay.js"
import { runBoundedQuery } from "./bounded-query.js"
import { classifyThrottle } from "./throttle.js"
import type { SDKClientService } from "./sdk-client.js"

/**
 * Resolve a reasoner lane's model from its primary env var, falling back to
 * the shared `LUNA_REASONER_MODEL`. Each var is trimmed INDEPENDENTLY so a
 * set-but-blank primary (`Environment=LUNA_WAKE_MODEL=` — the systemd "unset"
 * idiom) still falls through to the shared var instead of silently routing
 * the lane to the default (expensive) account. Unset/blank both ⇒ undefined.
 */
export function resolveReasonerModel(
  primaryVar: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    env[primaryVar]?.trim() || env["LUNA_REASONER_MODEL"]?.trim() || undefined
  )
}

/**
 * Feature gate for native SDK structured output on the reasoner lanes
 * (wake/dream). When OFF (the default), reasoners pass NO `outputFormat` and
 * fall back to prompt-and-parse — byte-identical to pre-change behavior, so
 * merging is zero-runtime-risk. Flip `LUNA_REASONER_STRUCTURED_OUTPUT` to
 * 1/true/yes/on to have reasoners request `outputFormat: { type:"json_schema" }`
 * and consume the schema-validated `structured_output` frame (the text-parse
 * path stays as a fallback for providers that don't honor it). Read at
 * layer-build time, mirroring resolveReasonerModel / the *_TIMEOUT_MS vars.
 */
export function reasonerStructuredOutputEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env["LUNA_REASONER_STRUCTURED_OUTPUT"]?.trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

/**
 * SDK options fragment for an acquired broker credential:
 *   - `model` whenever the broker resolved a NON-"default" model — the
 *     operator's lane model OR a chain step. NOT gated on the caller's env
 *     var: a chain on the bare "default" lane routes the credential to a
 *     gateway, and leaving Options.model unset would hit the gateway with no
 *     model. Bare "default" (no model, no chain) ⇒ unset, byte-identical to
 *     the pre-provider-seam behavior.
 *   - `env` overlay for any non-login credential (login-ref sentinel skips it
 *     so ambient-login back-compat is byte-identical).
 */
export function brokeredOptionsFragment(
  acq: AcquiredSession,
): { model?: string; env?: Record<string, string | undefined> } {
  return {
    ...(acq.model !== "default"
      ? { model: toWireModel(acq.model, acq.credential.kind) }
      : {}),
    ...(acq.credential.secretRef !== CLAUDE_CODE_LOGIN_SECRET_REF
      ? {
          // SDK Options.env is REPLACE, not merge — build the FULL subprocess
          // env: inherited process.env (auth vars scrubbed) under the broker
          // overlay. See buildBrokerBaseEnv.
          env: {
            ...buildBrokerBaseEnv(),
            ...buildBrokerEnvOverlay(
              profileForKind(acq.credential.kind, readProviderEnv()),
              acq.credential.resolvedSecret,
            ),
          },
        }
      : {}),
  }
}

/** Error constructors the caller supplies to map the four bounded outcomes
 * onto its own error type (WakeError / DreamError). */
export interface BrokeredTurnErrors<E> {
  readonly acquire: (cause: unknown) => E
  readonly timeout: (timeoutMs: number) => E
  readonly streamError: (cause: unknown) => E
  readonly empty: () => E
}

/** The successful outcome of a brokered reasoner turn. `text` is the model's
 * text result (always present, for back-compat + as the structured fallback);
 * `structuredOutput` is the SDK's schema-validated payload, present ONLY when
 * the caller passed `options.outputFormat` AND the provider honored it. */
export interface BrokeredTurnResult {
  readonly text: string
  readonly structuredOutput?: unknown
}

/**
 * Run ONE brokered reasoner turn: scoped acquire (the broker's inFlight
 * finalizer fires at turn end) → bounded SDK query with the brokered options
 * fragment → usage / rate-limit reporting → result (text + optional
 * structuredOutput) or a caller-mapped error. The returned effect needs no
 * Scope (it is closed here).
 */
export function runBrokeredReasonerTurn<E>(args: {
  readonly sdk: SDKClientService
  readonly broker: AccountBrokerApi
  /** Lane model (resolveReasonerModel result); undefined ⇒ "default" lane. */
  readonly model: string | undefined
  readonly prompt: string
  /** Base SDK options (maxTurns, pathToClaudeCodeExecutable, outputFormat, …) —
   * the brokered fragment is spread ON TOP. */
  readonly baseOptions: Record<string, unknown>
  readonly timeoutMs: number
  readonly errors: BrokeredTurnErrors<E>
}): Effect.Effect<BrokeredTurnResult, E> {
  return Effect.scoped(
    Effect.gen(function* () {
      const acq = yield* args.broker
        .acquireSession({ model: args.model ?? "default" })
        .pipe(Effect.mapError(args.errors.acquire))
      const outcome = yield* runBoundedQuery(
        args.sdk,
        {
          prompt: args.prompt,
          options: { ...args.baseOptions, ...brokeredOptionsFragment(acq) },
        },
        args.timeoutMs,
      )
      // B4 parity: meter the turn so reasoner lanes enforce chain budgets.
      // Priced against the model that ACTUALLY served the turn when the SDK
      // reports exactly one (alias lanes like "default"/"opus" otherwise
      // price at a tier default); falls back to the broker-resolved acq.model.
      if (outcome._tag === "result" && outcome.usage !== undefined) {
        yield* args.broker.report({
          accountId: acq.credential.accountId,
          kind: "usage",
          model: outcome.usage.model ?? acq.model,
          tokensIn: outcome.usage.tokensIn,
          tokensOut: outcome.usage.tokensOut,
          cacheRead: outcome.usage.cacheRead,
          cacheWrite: outcome.usage.cacheWrite,
          ...(acq.budgetUsd !== undefined
            ? { budgetUsd: acq.budgetUsd }
            : {}),
        })
      }
      // B9 parity: cool the account on a throttle-classified terminal error —
      // but ONLY when the broker said failover is viable (another un-cooled
      // chain target exists), mirroring the chat adapter's BLOCKER #1 gate.
      if (outcome._tag === "error" && acq.failoverPossible === true) {
        const cls = classifyThrottle(outcome.cause)
        if (cls.throttled) {
          yield* args.broker.report({
            accountId: acq.credential.accountId,
            kind: "rate_limit",
            ...(cls.retryAfterMs !== undefined
              ? { retryAfterMs: cls.retryAfterMs }
              : {}),
          })
        }
      }
      switch (outcome._tag) {
        case "result":
          return {
            text: outcome.text,
            ...(outcome.structuredOutput !== undefined
              ? { structuredOutput: outcome.structuredOutput }
              : {}),
          } satisfies BrokeredTurnResult
        case "timeout":
          return yield* Effect.fail(args.errors.timeout(outcome.timeoutMs))
        case "error":
          return yield* Effect.fail(args.errors.streamError(outcome.cause))
        case "empty":
          return yield* Effect.fail(args.errors.empty())
      }
    }),
  )
}
