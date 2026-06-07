/**
 * PromptWorker — first payload-bearing Phase-12b worker (DESIGN.md §5.3).
 *
 * Pattern mirrors `wake-reasoner.ts`: closure built at boot once SDKClient is
 * resolved, then registered into WorkerRegistry under a configurable kind
 * (default "prompt"). The closure swallows `SDKClient + AgentNotesService`
 * so the resulting `Worker<never>` matches `WorkerRegistry.register`'s
 * contract — the ticker's dispatch surface stays free of upstream deps.
 *
 * V1 payload shape (parsed defensively — no schema lib in core; we hand-roll
 * the validator so missing fields surface as `WorkerError({reason:"bad_payload"})`
 * before the worker even hits the SDK):
 *
 *   {
 *     user_prompt:    string         (required)
 *     system_prompt?: string
 *     model?:         string         (e.g. "claude-sonnet-4-5")
 *     allowed_tools?: string[]       (e.g. ["mcp__memory__memory_search"])
 *     max_turns?:     number         (default 1)
 *     deliver_to?:    DeliverySink
 *   }
 *
 * V1 delivery sinks:
 *
 *   { kind: "obs_note", kind_tag?, session_id? }   — write to agent_notes
 *   { kind: "log" }                                — log only (default behaviour)
 *
 * `chat_thread` + `file` sinks are explicitly deferred to P5+; their dispatch
 * shape is reserved in DeliverySink so they can land without API churn.
 *
 * Failure modes:
 *   - bad payload                 → WorkerError(reason:"bad_payload")
 *   - SDK query fails             → WorkerError(reason:"worker_failed", cause)
 *   - SDK yields no success msg   → WorkerError(reason:"worker_failed")
 *   - delivery write fails        → logged at WARN, worker still returns success
 *                                   (the result text is preserved in job_runs.output_text)
 */
import { Effect, Layer, Stream } from "effect"
import {
  AgentNotesService,
  WorkerRegistry,
  WorkerError,
  type AgentNotesApi,
  type Worker,
  type WorkerResult,
} from "@luna/core"
import { SDKClient, type SDKClientService, type SDKMessage } from "./sdk-client.js"

// ── Public payload types ────────────────────────────────────────────────────

export type DeliverySink =
  | { readonly kind: "obs_note"; readonly kind_tag?: string; readonly session_id?: string }
  | { readonly kind: "log" }

export interface PromptPayload {
  readonly user_prompt: string
  readonly system_prompt?: string
  readonly model?: string
  readonly allowed_tools?: ReadonlyArray<string>
  readonly max_turns?: number
  readonly deliver_to?: DeliverySink
}

// ── Payload parser (pure, exported for tests) ───────────────────────────────

/**
 * Validate and shape-check a raw payload (as it comes off the
 * `jobs.payload_json` column). On success returns the typed PromptPayload;
 * on failure returns a human-readable diagnostic string. The worker maps
 * the string into a `WorkerError({reason:"bad_payload"})`.
 */
export function parsePromptPayload(raw: unknown): PromptPayload | string {
  if (typeof raw !== "object" || raw === null) {
    return "payload must be an object"
  }
  const p = raw as Record<string, unknown>

  const userPrompt = p["user_prompt"]
  if (typeof userPrompt !== "string" || userPrompt.length === 0) {
    return "user_prompt must be a non-empty string"
  }

  const out: {
    -readonly [K in keyof PromptPayload]: PromptPayload[K]
  } = { user_prompt: userPrompt }

  if (typeof p["system_prompt"] === "string") {
    out.system_prompt = p["system_prompt"] as string
  }
  if (typeof p["model"] === "string") {
    out.model = p["model"] as string
  }
  if (Array.isArray(p["allowed_tools"])) {
    const filtered: string[] = []
    for (const t of p["allowed_tools"]) {
      if (typeof t === "string") filtered.push(t)
    }
    out.allowed_tools = filtered
  }
  if (typeof p["max_turns"] === "number" && Number.isFinite(p["max_turns"])) {
    out.max_turns = Math.max(1, Math.trunc(p["max_turns"] as number))
  }

  const deliverTo = p["deliver_to"]
  if (typeof deliverTo === "object" && deliverTo !== null) {
    const d = deliverTo as Record<string, unknown>
    if (d["kind"] === "obs_note") {
      out.deliver_to = {
        kind: "obs_note",
        ...(typeof d["kind_tag"] === "string"
          ? { kind_tag: d["kind_tag"] as string }
          : {}),
        ...(typeof d["session_id"] === "string"
          ? { session_id: d["session_id"] as string }
          : {}),
      }
    } else if (d["kind"] === "log") {
      out.deliver_to = { kind: "log" }
    } else {
      return `deliver_to.kind must be "obs_note" or "log" (got ${JSON.stringify(d["kind"])})`
    }
  }

  return out as PromptPayload
}

// ── SDK result collector (mirrors wake-reasoner.collectResultText) ─────────

/**
 * Iterate the Query stream and extract the `.result` string from the
 * `type:"result"` / `subtype:"success"` SDK message. Failures are surfaced
 * as `WorkerError({reason:"worker_failed"})` so the ticker writes a typed
 * row to `job_runs.error`.
 */
function collectResultText(
  query: import("./sdk-client.js").Query,
): Effect.Effect<string, WorkerError> {
  return Stream.fromAsyncIterable(
    query,
    (cause) =>
      new WorkerError({
        reason: "worker_failed",
        kind: "prompt",
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
    Effect.flatMap((result) =>
      result === null
        ? Effect.fail(
            new WorkerError({
              reason: "worker_failed",
              kind: "prompt",
              message:
                "SDK stream produced no type:result/subtype:success message",
            }),
          )
        : Effect.succeed(result),
    ),
  )
}

// ── Closure builder (pure, exported for tests) ──────────────────────────────

/**
 * Build a `Worker<never>` from a resolved SDKClient + optional AgentNotesService.
 * Tests use this directly with a faked SDK and an in-memory AgentNotesService;
 * production goes through `PromptWorkerLayer` below.
 */
export const buildPromptWorker = (
  sdk: SDKClientService,
  notes: AgentNotesApi | null,
): Worker<never> => {
  return (rawPayload, ctx) =>
    Effect.gen(function* () {
      const parsed = parsePromptPayload(rawPayload)
      if (typeof parsed === "string") {
        return yield* Effect.fail(
          new WorkerError({
            reason: "bad_payload",
            kind: "prompt",
            message: parsed,
          }),
        )
      }

      const prompt = parsed.system_prompt
        ? `${parsed.system_prompt}\n\n${parsed.user_prompt}`
        : parsed.user_prompt

      const query = yield* sdk
        .query({
          prompt,
          options: {
            maxTurns: parsed.max_turns ?? 1,
            ...(parsed.allowed_tools
              ? { allowedTools: [...parsed.allowed_tools] }
              : {}),
            ...(parsed.model ? { model: parsed.model } : {}),
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkerError({
                reason: "worker_failed",
                kind: "prompt",
                message: `SDK query() failed: ${String(cause)}`,
                cause,
              }),
          ),
        )

      const resultText = yield* collectResultText(query)

      // Delivery sink — V1: obs_note + log. Failures are non-fatal: the
      // result text still lands in job_runs.output_text below.
      if (parsed.deliver_to?.kind === "obs_note") {
        if (!notes) {
          yield* Effect.logWarning(
            `[luna/prompt-worker] deliver_to=obs_note requested but AgentNotesService not available; dropping delivery for job=${ctx.jobId}`,
          )
        } else {
          yield* notes
            .record({
              sessionId:
                parsed.deliver_to.session_id ??
                `prompt-worker:${ctx.jobId}`,
              kind:
                (parsed.deliver_to.kind_tag as never) ?? ("prompt_result" as never),
              summary: resultText.slice(0, 1024),
              payload: { jobId: ctx.jobId, runId: ctx.runId },
            })
            .pipe(
              Effect.catchAll((err) =>
                Effect.logWarning(
                  `[luna/prompt-worker] obs_note delivery failed for job=${ctx.jobId}: ${err.message}`,
                ),
              ),
            )
        }
      }

      return { outputText: resultText } satisfies WorkerResult
    })
}

// ── Layer that registers the worker at boot ─────────────────────────────────

export interface PromptWorkerLayerOptions {
  /** Override the kind discriminant. Default "prompt". */
  readonly kind?: string
}

/**
 * Build a layer that registers a prompt worker into the WorkerRegistry at
 * boot. Requires SDKClient + WorkerRegistry + AgentNotesService — the
 * chat-server provides all three. Returns nothing (Layer<never, never, …>) —
 * the side-effect IS the registration.
 *
 *   const promptL = PromptWorkerLayer().pipe(
 *     Layer.provide(Layer.mergeAll(sdkClientL, workerRegistryL, agentNotesL)),
 *   )
 */
export const PromptWorkerLayer = (
  opts?: PromptWorkerLayerOptions,
): Layer.Layer<never, never, SDKClient | WorkerRegistry | AgentNotesService> => {
  const kind = opts?.kind ?? "prompt"
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const sdk = yield* SDKClient
      const reg = yield* WorkerRegistry
      const notes = yield* AgentNotesService
      const worker = buildPromptWorker(sdk, notes)
      yield* reg.register(kind, worker)
    }),
  )
}
