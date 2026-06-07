// packages/adapter-sdk/src/wake-reasoner.ts
//
// Model-backed WakeReasoner layer. Mirrors dream-reasoner.ts:
//   1. Build a deterministic prompt from WakeInputs.
//   2. Call sdk.query({ prompt, options: { maxTurns: 1 } }) — single-shot,
//      no MCP access, no tool calls. Just JSON in / JSON out.
//   3. Collect the type:"result" / subtype:"success" message's `.result` string.
//   4. JSON.parse → validate shape → return WakeDigest.
//   5. Any parse / validation / SDK failure → WakeError (the cron loop
//      handles this without crashing).
//
// WHY HERE (not in core/wake/): adapter-sdk already depends on @luna/core;
// core does NOT depend on adapter-sdk. Putting an SDKClient-using impl in
// core would create a forbidden cycle.
import { Effect, Layer, Stream } from "effect"
import {
  WakeReasoner,
  WakeError,
} from "@luna/core"
import type {
  WakeDigest,
  WakeInputs,
  WakeProposedAction,
  WakeReasonerApi,
} from "@luna/core"
import type { SDKMessage } from "./sdk-client.js"
import { SDKClient } from "./sdk-client.js"

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
// Collect result text from the SDK stream
// ---------------------------------------------------------------------------

/**
 * Iterate the Query stream and extract the `.result` string from the
 * type:"result" / subtype:"success" message. Mirrors dream-reasoner's
 * helper; duplicated rather than shared because the error type is Wake-specific.
 */
function collectResultText(
  query: import("./sdk-client.js").Query,
): Effect.Effect<string, WakeError> {
  return Stream.fromAsyncIterable(
    query,
    (cause) =>
      new WakeError({
        op: "wake/sdk-stream",
        message: `SDK stream error: ${String(cause)}`,
        cause,
      }),
  ).pipe(
    Stream.runFold(
      null as string | null,
      (acc: string | null, msg: SDKMessage) => {
        const m = msg as {
          type?: string
          subtype?: string
          result?: string
        }
        if (
          m.type === "result" &&
          m.subtype === "success" &&
          typeof m.result === "string"
        ) {
          return m.result
        }
        return acc
      },
    ),
    Effect.flatMap((result) => {
      if (result === null) {
        return Effect.fail(
          new WakeError({
            op: "wake/sdk-stream",
            message:
              "SDK stream produced no type:result/subtype:success message",
          }),
        )
      }
      return Effect.succeed(result)
    }),
  )
}

// ---------------------------------------------------------------------------
// Parse the model's JSON output → WakeDigest
// ---------------------------------------------------------------------------

/**
 * Parse and shape-validate the model's JSON output into a WakeDigest.
 * Exported for unit tests that want to verify parse behavior without
 * running a real SDK call.
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
      const raw = JSON.parse(trimmed) as Record<string, unknown>

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
 * Model-backed WakeReasoner. Requires SDKClient. The returned `reason`
 * effect has R=never (SDKClient is closed over at layer build time).
 */
export const WakeReasonerDefault: Layer.Layer<WakeReasoner, never, SDKClient> =
  Layer.effect(
    WakeReasoner,
    Effect.gen(function* () {
      const sdk = yield* SDKClient

      // Same Bun-on-linux musl-vs-glibc footgun as dream-reasoner: the SDK
      // ships a per-arch claude binary lookup that resolves to a musl variant
      // on a glibc container. The chat-server sets LUNA_CLAUDE_CODE_EXECUTABLE
      // — we forward it here so the cron tick uses the same binary as
      // interactive ChatService threads.
      const pathToClaudeCodeExecutable =
        process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]?.trim() || undefined

      const reason: WakeReasonerApi["reason"] = (inputs: WakeInputs) =>
        Effect.gen(function* () {
          const prompt = buildWakePrompt(inputs)
          yield* Effect.logInfo("[luna/wake] reasoner.reason: starting", {
            workspace: inputs.workspaceSlug,
            goals: inputs.openGoals.length,
            actions: inputs.openNextActions.length,
            pathToClaudeCodeExecutable:
              pathToClaudeCodeExecutable ?? "(unset)",
          })
          const query = yield* sdk.query({
            prompt,
            options: {
              maxTurns: 1,
              ...(pathToClaudeCodeExecutable
                ? { pathToClaudeCodeExecutable }
                : {}),
            },
          })
          const resultText = yield* collectResultText(query)
          const digest = yield* parseDigest(inputs.workspaceSlug, resultText)
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
