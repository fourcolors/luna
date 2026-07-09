// packages/adapter-sdk/src/wake-reasoner.ts
//
// Model-backed WakeReasoner layer. Mirrors dream-reasoner.ts:
//   1. Build a deterministic prompt from WakeInputs.
//   2. Call sdk.query({ prompt, options: { maxTurns: 1 } }) — single-shot,
//      no MCP access, no tool calls. Just JSON in / JSON out. When
//      LUNA_REASONER_STRUCTURED_OUTPUT is on (default OFF), the turn carries an
//      `outputFormat` json_schema (WAKE_DIGEST_SCHEMA).
//   3. Collect the type:"result" / subtype:"success" message — its
//      schema-validated `structured_output` when present, else `.result` string.
//   4. Structured path → validateDigest; text path → JSON.parse → parseDigest.
//      Both share validateDigestRaw, returning a WakeDigest.
//   5. Any parse / validation / SDK failure → WakeError (the cron loop
//      handles this without crashing).
//
// WHY HERE (not in core/wake/): adapter-sdk already depends on @luna/core;
// core does NOT depend on adapter-sdk. Putting an SDKClient-using impl in
// core would create a forbidden cycle.
import { Effect, Layer } from "effect"
import {
  WakeReasoner,
  WakeError,
  AccountBroker,
} from "@luna/core"
import type {
  WakeDigest,
  WakeInputs,
  WakeProposedAction,
  WakeReasonerApi,
} from "@luna/core"
import { SDKClient } from "./sdk-client.js"
import { DEFAULT_QUERY_TIMEOUT_MS } from "./bounded-query.js"
import {
  resolveReasonerModel,
  runBrokeredReasonerTurn,
  reasonerStructuredOutputEnabled,
} from "./brokered-turn.js"

// ---------------------------------------------------------------------------
// JSON Schema for the wake digest — passed as the SDK `outputFormat` when
// structured output is enabled. Mirrors exactly what validateDigest enforces,
// so the schema-validated path and the text-parse fallback accept the same
// shape. `additionalProperties:false` keeps the model from inventing fields.
// ---------------------------------------------------------------------------
export const WAKE_DIGEST_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "observations",
    "picked_action_id",
    "picked_reason",
    "proposed_actions",
  ],
  properties: {
    observations: { type: "array", items: { type: "string" } },
    picked_action_id: { type: ["integer", "null"] },
    picked_reason: { type: "string" },
    proposed_actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "priority", "rationale", "goal_slug"],
        properties: {
          action: { type: "string", minLength: 1 },
          priority: { type: "integer", minimum: 1, maximum: 5 },
          rationale: { type: "string" },
          goal_slug: { type: ["string", "null"] },
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Prompt builder (pure, exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Build a deterministic wake prompt from WakeInputs. Pure function — no
 * side effects — so it can be unit-tested independently of any model call.
 */
export function buildWakePrompt(inputs: WakeInputs): string {
  const goals =
    inputs.openGoals.length === 0
      ? "(no active goals)"
      : inputs.openGoals
          .map((g) => `- (p${g.priority}) ${g.slug}: ${g.title}`)
          .join("\n")
  const actions =
    inputs.openNextActions.length === 0
      ? "(no open next_actions)"
      : inputs.openNextActions
          .map(
            (a) =>
              `- [#${a.id} ${a.status} p${a.priority} goal=${a.goalSlug}] ${a.action}`,
          )
          .join("\n")
  const wakes =
    inputs.recentWakes.length === 0
      ? "(no prior wakes)"
      : inputs.recentWakes
          .map(
            (w) =>
              `- @${new Date(w.wokeAt).toISOString()} [${w.outcome}] ${w.summary}`,
          )
          .join("\n")
  return [
    "You are Luna's wake reasoner. A cron just fired. Look at the workspace state",
    "below and emit a JSON digest describing the highest-leverage next action.",
    "",
    "Your output is observational — it will be written to wake_log for operator",
    "review. You are NOT executing anything; another process (or a human) will",
    "act on your picks. Be honest: if nothing is actionable, say so.",
    "",
    `Workspace: ${inputs.workspaceSlug}`,
    "",
    "## workspace.md (reference, truncated)",
    inputs.workspaceMd || "(workspace.md missing or empty)",
    "",
    "## Active goals",
    goals,
    "",
    "## Open next_actions (top 20 by priority)",
    actions,
    "",
    "## Recent wakes (last 5)",
    wakes,
    "",
    "## Output",
    "Reply with ONLY a JSON object — no prose before or after, no code fences.",
    "Shape:",
    "{",
    '  "observations": ["..."],         // 1-3 short observations about current state',
    '  "picked_action_id": <number|null>, // id from the open next_actions list, or null',
    '  "picked_reason": "...",          // why this action (or why none fits)',
    '  "proposed_actions": [            // 0-3 new actions to file (often empty)',
    '    { "action": "...", "priority": 1-5, "rationale": "...", "goal_slug": "..." | null }',
    "  ]",
    "}",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Parse the model's JSON output → WakeDigest
// ---------------------------------------------------------------------------

/**
 * Pure shape-validator: turn an already-parsed JSON value into a WakeDigest,
 * THROWING on any shape violation. Shared by both consumption paths —
 * `parseDigest` (text → JSON.parse → here) and `validateDigest` (the SDK's
 * schema-validated `structured_output` → here). Keeping ONE validator means the
 * structured and fallback paths can never drift in what they accept.
 */
function validateDigestRaw(workspaceSlug: string, rawValue: unknown): WakeDigest {
  const raw = rawValue as Record<string, unknown>

  const observations = raw["observations"]
      if (!Array.isArray(observations)) {
        throw new Error("observations must be an array")
      }
      const observationsArr = observations.map((o, i) => {
        if (typeof o !== "string") {
          throw new Error(`observations[${i}] must be a string`)
        }
        return o
      })

      const pickedRaw = raw["picked_action_id"]
      let pickedActionId: number | null
      if (pickedRaw === null || pickedRaw === undefined) {
        pickedActionId = null
      } else if (typeof pickedRaw === "number" && Number.isFinite(pickedRaw)) {
        pickedActionId = Math.trunc(pickedRaw)
      } else {
        throw new Error(
          `picked_action_id must be a finite number or null (got ${typeof pickedRaw})`,
        )
      }

      const pickedReason = raw["picked_reason"]
      if (typeof pickedReason !== "string") {
        throw new Error("picked_reason must be a string")
      }

      const proposedRaw = raw["proposed_actions"]
      if (!Array.isArray(proposedRaw)) {
        throw new Error("proposed_actions must be an array")
      }
      const proposedActions: WakeProposedAction[] = proposedRaw.map((p, i) => {
        const op = p as Record<string, unknown>
        const action = op["action"]
        const priority = op["priority"]
        const rationale = op["rationale"]
        const goalSlug = op["goal_slug"]
        if (typeof action !== "string" || action.length === 0) {
          throw new Error(`proposed_actions[${i}].action must be a non-empty string`)
        }
        if (typeof priority !== "number" || priority < 1 || priority > 5) {
          throw new Error(
            `proposed_actions[${i}].priority must be a number 1-5`,
          )
        }
        if (typeof rationale !== "string") {
          throw new Error(
            `proposed_actions[${i}].rationale must be a string`,
          )
        }
        const goalSlugNorm: string | null =
          goalSlug === null || goalSlug === undefined
            ? null
            : typeof goalSlug === "string"
              ? goalSlug
              : (() => {
                  throw new Error(
                    `proposed_actions[${i}].goal_slug must be string or null`,
                  )
                })()
        return {
          action,
          priority: Math.trunc(priority),
          rationale,
          goalSlug: goalSlugNorm,
        }
      })

  return {
    workspaceSlug,
    observations: observationsArr,
    pickedActionId,
    pickedReason,
    proposedActions,
  } satisfies WakeDigest
}

/**
 * Validate an already-parsed value (the SDK's schema-validated
 * `structured_output`) into a WakeDigest. No JSON.parse, no fence-stripping —
 * the SDK already guaranteed valid JSON conforming to WAKE_DIGEST_SCHEMA; this
 * is the defense-in-depth shape check.
 */
export function validateDigest(
  workspaceSlug: string,
  rawValue: unknown,
): Effect.Effect<WakeDigest, WakeError> {
  return Effect.try({
    try: (): WakeDigest => validateDigestRaw(workspaceSlug, rawValue),
    catch: (cause) =>
      new WakeError({
        op: "wake/parse",
        message: `failed to validate structured output: ${String(cause)}`,
        cause,
      }),
  })
}

/**
 * Parse and shape-validate the model's JSON output into a WakeDigest. The
 * text-parse fallback used when structured output is disabled or unavailable.
 * Exported for unit tests that verify parse behavior without a real SDK call.
 */
export function parseDigest(
  workspaceSlug: string,
  text: string,
): Effect.Effect<WakeDigest, WakeError> {
  return Effect.try({
    try: (): WakeDigest => {
      // Strip accidental markdown fences if the model wraps despite the
      // prompt — same defensive trim as dream-reasoner.
      const trimmed = text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim()
      return validateDigestRaw(workspaceSlug, JSON.parse(trimmed))
    },
    catch: (cause) =>
      new WakeError({
        op: "wake/parse",
        message: `failed to parse model output: ${String(cause)}`,
        cause,
      }),
  })
}

// ---------------------------------------------------------------------------
// WakeReasonerDefault — exported Layer
// ---------------------------------------------------------------------------

/**
 * Model-backed WakeReasoner. Requires SDKClient + AccountBroker. The returned
 * `reason` effect has R=never (both are closed over at layer build time); the
 * per-turn credential acquire runs inside `Effect.scoped` so the broker's
 * inFlight finalizer fires at turn end without leaking Scope into R.
 */
export const WakeReasonerDefault: Layer.Layer<
  WakeReasoner,
  never,
  SDKClient | AccountBroker
> = Layer.effect(
    WakeReasoner,
    Effect.gen(function* () {
      const sdk = yield* SDKClient
      const broker = yield* AccountBroker

      // Provider-seam routing: the wake cron can run on a cheap model. Pick the
      // model from LUNA_WAKE_MODEL (falling back to the shared LUNA_REASONER_MODEL,
      // each var trimmed independently so a set-but-blank primary falls through);
      // unset → undefined → broker is acquired with "default" → anthropic
      // login-ref account → no env overlay, no options.model → today's behavior.
      const wakeModel = resolveReasonerModel("LUNA_WAKE_MODEL")

      // Native structured output gate (default OFF). When on, the turn is issued
      // with an outputFormat json_schema and we consume the SDK's validated
      // structured_output; when off, behavior is byte-identical to before.
      const structuredOutputEnabled = reasonerStructuredOutputEnabled()

      // Same Bun-on-linux musl-vs-glibc footgun as dream-reasoner: the SDK
      // ships a per-arch claude binary lookup that resolves to a musl variant
      // on a glibc container. The chat-server sets LUNA_CLAUDE_CODE_EXECUTABLE
      // — we forward it here so the cron tick uses the same binary as
      // interactive ChatService threads.
      const pathToClaudeCodeExecutable =
        process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]?.trim() || undefined

      // Wall-clock ceiling for the single reasoning turn. Wake runs via the V2
      // JobTicker (kind:"wake" -> WakeWorker), which registers the BARE
      // back-compat form (no defaultTimeoutMs) and so gets the ticker's
      // ENFORCED 5-min workerDeadline — shorter than this 10-min inner
      // ceiling, so in practice the ticker interrupts an overrunning wake
      // first (deadline_passed, retried with backoff since Seam 3). This
      // inner ceiling still matters: it aborts a wedged subprocess even when
      // the layer is exercised outside the ticker, and it bounds the turn if
      // wake is ever registered with a wider defaultTimeoutMs. Overridable
      // via env; defaults to 10 min.
      const wakeTimeoutMs = (() => {
        const raw = process.env["LUNA_WAKE_TIMEOUT_MS"]?.trim()
        const n = raw ? Number(raw) : DEFAULT_QUERY_TIMEOUT_MS
        return Number.isFinite(n) && n > 0
          ? Math.trunc(n)
          : DEFAULT_QUERY_TIMEOUT_MS
      })()

      const reason: WakeReasonerApi["reason"] = (inputs: WakeInputs) =>
        Effect.gen(function* () {
          const prompt = buildWakePrompt(inputs)
          yield* Effect.logInfo("[luna/wake] reasoner.reason: starting", {
            workspace: inputs.workspaceSlug,
            goals: inputs.openGoals.length,
            actions: inputs.openNextActions.length,
            wakeModel: wakeModel ?? "(default)",
            pathToClaudeCodeExecutable:
              pathToClaudeCodeExecutable ?? "(unset)",
          })
          // One brokered turn (shared with dream-reasoner): scoped acquire so
          // the broker's inFlight finalizer fires at turn end, the model-gate +
          // provider env-overlay options fragment, and usage / rate-limit
          // reporting so chain budgets and 429 failover apply to this lane.
          const turn = yield* runBrokeredReasonerTurn({
            sdk,
            broker,
            model: wakeModel,
            prompt,
            baseOptions: {
              maxTurns: 1,
              ...(structuredOutputEnabled
                ? {
                    outputFormat: {
                      type: "json_schema",
                      schema: WAKE_DIGEST_SCHEMA,
                    },
                  }
                : {}),
              ...(pathToClaudeCodeExecutable
                ? { pathToClaudeCodeExecutable }
                : {}),
            },
            timeoutMs: wakeTimeoutMs,
            errors: {
              acquire: (cause) =>
                new WakeError({
                  op: "wake/acquire",
                  message: `failed to acquire account: ${String(cause)}`,
                  cause,
                }),
              timeout: (timeoutMs) =>
                new WakeError({
                  op: "wake/sdk-stream",
                  message: `SDK query timed out after ${timeoutMs}ms`,
                }),
              streamError: (cause) =>
                new WakeError({
                  op: "wake/sdk-stream",
                  message: `SDK stream error: ${String(cause)}`,
                  cause,
                }),
              empty: () =>
                new WakeError({
                  op: "wake/sdk-stream",
                  message:
                    "SDK stream produced no type:result/subtype:success message",
                }),
            },
          })
          // Prefer the SDK's schema-validated structured_output; fall back to
          // parsing the text result. structuredOutput is only ever present when
          // the gate is on AND the provider honored outputFormat — otherwise
          // this is exactly the prior parseDigest(text) path.
          const digest =
            turn.structuredOutput !== undefined
              ? yield* validateDigest(
                  inputs.workspaceSlug,
                  turn.structuredOutput,
                )
              : yield* parseDigest(inputs.workspaceSlug, turn.text)
          yield* Effect.logInfo("[luna/wake] reasoner.reason: digest ready", {
            workspace: inputs.workspaceSlug,
            picked: digest.pickedActionId,
            proposed: digest.proposedActions.length,
          })
          return digest
        })

      return { reason } satisfies WakeReasonerApi
    }),
  )
