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
 *     timeout_ms?:    number         (wall-clock; default 10 min)
 *     deliver_to?:    DeliverySink
 *   }
 *
 * Delivery sinks:
 *
 *   { kind: "obs_note", kind_tag?, session_id? }   — write to agent_notes
 *   { kind: "log" }                                — log only (default behaviour)
 *   { kind: "chat_thread", thread_id }             — post the result back INTO
 *                                                    a chat thread as an
 *                                                    assistant message (issue
 *                                                    #124, via ChatThreadPoster)
 *
 * The `file` sink remains deferred; its dispatch shape can land later without
 * API churn.
 *
 * Failure modes:
 *   - bad payload                 → WorkerError(reason:"bad_payload")
 *   - SDK stream errors           → WorkerError(reason:"worker_failed", cause)
 *   - turn exceeds timeout_ms     → WorkerError(reason:"worker_failed") + subprocess aborted
 *   - SDK yields no success msg   → WorkerError(reason:"worker_failed")
 *   - delivery write fails        → logged at WARN, worker still returns success
 *                                   (the result text is preserved in job_runs.output_text)
 */
import { Effect, Layer, Option } from "effect"
import {
  AgentNotesService,
  WorkerRegistry,
  WorkerError,
  type AgentNotesApi,
  type Worker,
  type WorkerResult,
} from "@luna/core"
import {
  SDKClient,
  type SDKClientService,
  type QueryParams,
} from "./sdk-client.js"
import { runBoundedQuery, DEFAULT_QUERY_TIMEOUT_MS } from "./bounded-query.js"
import {
  JobRunToolsProviderTag,
  type JobRunToolsProvider,
} from "./job-run-tools.js"
import {
  ChatThreadPosterTag,
  type ChatThreadPoster,
} from "./chat-thread-poster.js"

// ── Public payload types ────────────────────────────────────────────────────

export type DeliverySink =
  | { readonly kind: "obs_note"; readonly kind_tag?: string; readonly session_id?: string }
  | { readonly kind: "log" }
  | { readonly kind: "chat_thread"; readonly thread_id: string }

export interface PromptPayload {
  readonly user_prompt: string
  readonly system_prompt?: string
  readonly model?: string
  readonly allowed_tools?: ReadonlyArray<string>
  readonly max_turns?: number
  /**
   * Wall-clock ceiling for the whole turn. On expiry the worker fails and the
   * SDK subprocess is aborted, so a hung turn cannot wedge the single-fiber V2
   * ticker. Defaults to `DEFAULT_QUERY_TIMEOUT_MS` (10 min) when omitted.
   */
  readonly timeout_ms?: number
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
  if (typeof p["timeout_ms"] === "number" && Number.isFinite(p["timeout_ms"])) {
    out.timeout_ms = Math.max(1, Math.trunc(p["timeout_ms"] as number))
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
    } else if (d["kind"] === "chat_thread") {
      const threadId = d["thread_id"]
      if (typeof threadId !== "string" || threadId.length === 0) {
        return "deliver_to.chat_thread requires a non-empty thread_id"
      }
      out.deliver_to = { kind: "chat_thread", thread_id: threadId }
    } else {
      return `deliver_to.kind must be "obs_note", "log", or "chat_thread" (got ${JSON.stringify(d["kind"])})`
    }
  }

  return out as PromptPayload
}

// ── Bounded SDK result collector ────────────────────────────────────────────

/**
 * Run the turn under a wall-clock deadline (shared `runBoundedQuery`) and map
 * its outcome onto the worker's typed error channel. A timeout / stream error /
 * empty stream all surface as `WorkerError({reason:"worker_failed"})` so the
 * ticker writes a typed row to `job_runs.error`. The subprocess is aborted on
 * timeout, so a hung turn cannot wedge the single-fiber V2 ticker.
 */
function boundedResultText(
  sdk: SDKClientService,
  params: QueryParams,
  timeoutMs: number,
): Effect.Effect<string, WorkerError> {
  return runBoundedQuery(sdk, params, timeoutMs).pipe(
    Effect.flatMap((outcome): Effect.Effect<string, WorkerError> => {
      switch (outcome._tag) {
        case "result":
          return Effect.succeed(outcome.text)
        case "timeout":
          return Effect.fail(
            new WorkerError({
              reason: "worker_failed",
              kind: "prompt",
              message: `SDK query timed out after ${outcome.timeoutMs}ms`,
            }),
          )
        case "error":
          return Effect.fail(
            new WorkerError({
              reason: "worker_failed",
              kind: "prompt",
              message: `SDK stream error: ${String(outcome.cause)}`,
              cause: outcome.cause,
            }),
          )
        case "empty":
          return Effect.fail(
            new WorkerError({
              reason: "worker_failed",
              kind: "prompt",
              message:
                "SDK stream produced no type:result/subtype:success message",
            }),
          )
      }
    }),
  )
}

// ── Closure builder (pure, exported for tests) ──────────────────────────────

/** The human label for a run: the job payload's `label`, else the jobId. */
const jobNameFrom = (rawPayload: unknown, jobId: string): string => {
  if (typeof rawPayload === "object" && rawPayload !== null) {
    const label = (rawPayload as { label?: unknown }).label
    if (typeof label === "string" && label.length > 0) return label
  }
  return jobId
}

/** The job payload's `source` (e.g. "suggested-action"), or null when unset.
 *  Used to mark a chat_thread delivery so the UI can render it "from a
 *  background task" rather than as a live reply. */
const sourceOf = (rawPayload: unknown): string | null => {
  if (typeof rawPayload === "object" && rawPayload !== null) {
    const source = (rawPayload as { source?: unknown }).source
    if (typeof source === "string" && source.length > 0) return source
  }
  return null
}

/**
 * Build a `Worker<never>` from a resolved SDKClient + optional AgentNotesService.
 * Tests use this directly with a faked SDK and an in-memory AgentNotesService;
 * production goes through `PromptWorkerLayer` below.
 *
 * `jobTools` (optional, widget-system.md Phase 5) is the per-run tool
 * factory: when present, each dispatch gets a fresh MCP server bound to its
 * own runId (the `request_input` tool), spliced into the query's
 * `mcpServers`/`allowedTools` plus a system-prompt addendum. Absent →
 * byte-identical query options to the tool-free worker.
 *
 * `chatPoster` (optional, issue #124) is the chat-thread delivery capability.
 * When present and the payload carries `deliver_to.chat_thread`, the finished
 * result is posted back into the target thread as an assistant message. Absent
 * → a `chat_thread` sink logs-and-drops (the result still lands in
 * `job_runs.output_text`).
 */
export const buildPromptWorker = (
  sdk: SDKClientService,
  notes: AgentNotesApi | null,
  jobTools: JobRunToolsProvider | null = null,
  chatPoster: ChatThreadPoster | null = null,
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

      // Per-run tool wiring (request_input). The binding is built fresh per
      // dispatch so the tool closure carries THIS run's id.
      const binding = jobTools
        ? jobTools.forRun({
            jobId: ctx.jobId,
            runId: ctx.runId,
            jobName: jobNameFrom(rawPayload, ctx.jobId),
          })
        : null

      const systemText = [
        ...(parsed.system_prompt ? [parsed.system_prompt] : []),
        ...(binding ? [binding.systemPromptAddendum] : []),
      ].join("\n\n")
      const prompt = systemText
        ? `${systemText}\n\n${parsed.user_prompt}`
        : parsed.user_prompt

      // allowedTools is permissive-additive in the SDK (it pre-approves,
      // it does not restrict others), so appending the binding's names is
      // safe whether or not the payload set its own list.
      const allowedTools = [
        ...(parsed.allowed_tools ?? []),
        ...(binding ? binding.allowedTools : []),
      ]

      const resultText = yield* boundedResultText(
        sdk,
        {
          prompt,
          options: {
            maxTurns: parsed.max_turns ?? 1,
            ...(allowedTools.length > 0 ? { allowedTools } : {}),
            ...(binding
              ? { mcpServers: { [binding.serverName]: binding.server } }
              : {}),
            ...(parsed.model ? { model: parsed.model } : {}),
          },
        },
        parsed.timeout_ms ?? DEFAULT_QUERY_TIMEOUT_MS,
      )

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
      } else if (parsed.deliver_to?.kind === "chat_thread") {
        // Post the finished result back INTO a chat thread as an assistant
        // message (issue #124). Best-effort: a missing/closed thread is
        // logged-and-dropped inside the poster, and the result text still
        // lands in job_runs.output_text below.
        if (!chatPoster) {
          yield* Effect.logWarning(
            `[luna/prompt-worker] deliver_to=chat_thread requested but ChatThreadPoster not available; dropping delivery for job=${ctx.jobId}`,
          )
        } else {
          yield* chatPoster.post({
            threadId: parsed.deliver_to.thread_id,
            text: resultText,
            source: sourceOf(rawPayload) ?? "background-job",
            label: jobNameFrom(rawPayload, ctx.jobId),
          })
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
      // Optional per-run tool wiring (request_input). Read via serviceOption
      // — same pattern as the dream cron's calibration sink — so the layer's
      // R does not grow and compositions without the provider (tests, boot
      // smokes) keep working unchanged.
      const jobTools = yield* Effect.serviceOption(JobRunToolsProviderTag)
      // Optional chat-thread delivery capability (issue #124). Read via
      // serviceOption — same pattern as jobTools — so the layer's R does not
      // grow and compositions without the poster (tests, boot smokes) keep
      // working unchanged.
      const chatPoster = yield* Effect.serviceOption(ChatThreadPosterTag)
      const worker = buildPromptWorker(
        sdk,
        notes,
        Option.getOrNull(jobTools),
        Option.getOrNull(chatPoster),
      )
      // job-ticker-oban-deadlines (Seam 2 boot wiring): register with the
      // worker's own inner ceiling (DEFAULT_QUERY_TIMEOUT_MS, 10 min; a
      // per-payload `timeout_ms` still overrides at dispatch time — see
      // job-ticker.ts's Seam-1 resolution) so the JobTicker's outer backstop
      // is `defaultTimeoutMs + grace` instead of the bare 5-min
      // `workerDeadline` fallback. Without this the ticker's global 5-min
      // deadline fires BEFORE this worker's own 10-min inner timeout ever
      // gets a chance to produce a descriptive `worker_failed` error.
      yield* reg.register(kind, { run: worker, defaultTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS })
    }),
  )
}
