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
  laneSupportsStructuredOutput,
  profileForKind,
  readProviderEnv,
  resolveProfile,
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
 * (wake/dream). DEFAULT ON whenever `model`'s resolved provider profile
 * supports structured output - i.e. `laneSupportsStructuredOutput` (the
 * slice-09 capability check @luna/core's overflow-chain validator and the
 * provider-settings resolver already use) reports the lane's provider can
 * honor `outputFormat`. Today that's anthropic (the bare "default" lane) and
 * google; a "none" lane (openai, ollama-cloud, ollama-local, or an unrecognized
 * gateway kind) falls back to prompt-and-parse exactly as before this change.
 * `model` is resolved with the SAME `"default"` fallback the broker itself
 * applies in `runBrokeredReasonerTurn` (`args.model ?? "default"`), so the
 * capability check reflects the provider the turn actually routes to in the
 * common (non-overflow-chain) case.
 *
 * `LUNA_REASONER_STRUCTURED_OUTPUT` remains an explicit override in BOTH
 * directions: 1/true/yes/on FORCES structured output on even for a lane the
 * capability check would leave off (e.g. trying a new gateway build); 0/false/
 * no/off FORCES it off (the instant rollback lever if dream/wake op-validation
 * failure rates rise - see job_runs / dream_audit). An unset, blank, or
 * unrecognized value defers to the capability check. Read at layer-build time,
 * mirroring resolveReasonerModel / the *_TIMEOUT_MS vars.
 */
export function reasonerStructuredOutputEnabled(
  model: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env["LUNA_REASONER_STRUCTURED_OUTPUT"]?.trim().toLowerCase()
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true
  if (v === "0" || v === "false" || v === "no" || v === "off") return false
  return laneSupportsStructuredOutput(resolveProfile(model ?? "default", env))
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
            kind: cls.kind ?? "rate_limit",
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
