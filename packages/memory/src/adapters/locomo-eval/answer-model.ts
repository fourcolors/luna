/**
 * answer-model — generates an answer from ONLY the retrieved memory context
 * (no full conversation, no ground truth). This is the "fair comparison"
 * step per the task brief: it tests whether Luna's retrieval surfaced the
 * right memory, not whether a model with the whole transcript can answer.
 *
 * Three backends, selected via `LUNA_LOCOMO_ANSWER_BACKEND`:
 *   - `ollama` (default) — local Ollama daemon, `/api/chat`, zero API cost,
 *     same daemon/base-URL convention `packages/core/src/embedder/embedder.ts`
 *     uses for embeddings via `LUNA_OLLAMA_BASE_URL`.
 *   - `ollama-cloud` — Ollama's HOSTED cloud API (`https://ollama.com/api`),
 *     same `/api/chat` request/response shape as local Ollama, authenticated
 *     via a Bearer API key (`OLLAMA_CLOUD_KEY`, provisioned in 1Password —
 *     see README.md). Much faster than local CPU inference and gives access
 *     to larger hosted models (default `gpt-oss:120b`, override via
 *     `LUNA_LOCOMO_CLOUD_MODEL` or `LUNA_LOCOMO_ANSWER_MODEL`).
 *   - `anthropic` — the original Anthropic Messages API path, kept behind
 *     `LUNA_LOCOMO_ANSWER_BACKEND=anthropic` for future flexibility. Blocked
 *     in this environment (no `ANTHROPIC_API_KEY`).
 *
 * All three are deliberately dependency-free (plain `fetch`, no SDK),
 * mirroring the embedder module's own HTTP client rather than introducing a
 * new one.
 *
 * Cost tracking: for the local `ollama` path this is always $0 (see
 * `packages/core/src/pricing.ts`'s `ollama` rate — 0/0 per million tokens).
 * `ollama-cloud` reuses the same free-tier accounting (`rateFor` treats any
 * `ollama*` kind as $0 — see pricing.ts) since the harness is spending
 * against a pre-provisioned API key, not per-token billing we can price
 * here; token counts are still filled in for observability, not a budget
 * cap — see `run.ts` for why the budget guard was replaced with a
 * wall-clock estimate instead of a dollar cap.
 *
 * `ollama-cloud` failure handling: HTTP 429 and 5xx responses (and network
 * errors) are retried with short exponential backoff (a handful of
 * attempts — see `backoffDelayMs`). A HARD failure — auth error (401/403),
 * a quota/billing/payment-required signal, or persistent 429/5xx that
 * doesn't clear after retries — throws `LocomoHardStopError` instead of
 * retrying forever. `run.ts` catches that specifically and stops the whole
 * run cleanly (not just the one QA pair), so a broken key or an exhausted
 * quota can't silently burn through the rest of the dataset one failed
 * retry-loop at a time. `classifyOllamaCloudResponse` is the pure decision
 * function (retry vs. hard-stop vs. plain fail) and is unit-tested directly
 * — see `test/locomo-eval.test.ts`.
 */
import { priceTurnUsd, rateFor } from "@luna/core"

export interface AnswerResult {
  readonly text: string
  readonly tokensIn: number
  readonly tokensOut: number
  readonly costUsd: number
}

export interface CostTracker {
  totalTokensIn: number
  totalTokensOut: number
  totalCostUsd: number
  calls: number
}

export function newCostTracker(): CostTracker {
  return { totalTokensIn: 0, totalTokensOut: 0, totalCostUsd: 0, calls: 0 }
}

/**
 * Thrown by `answerFromContextOllamaCloud` when a failure is HARD — i.e.
 * retrying will not help and continuing to call the API for the remaining
 * QA pairs would just repeat the same failure (and burn quota/time) once
 * per pair. `run.ts` catches this specifically (vs. a plain `Error`, which
 * is recorded as a single failed QA pair and the run continues) and stops
 * the entire run, writing partial results — same discipline as the
 * wall-clock time cap.
 */
export class LocomoHardStopError extends Error {
  readonly reason: "auth" | "quota" | "rate_limit" | "server"
  constructor(reason: "auth" | "quota" | "rate_limit" | "server", message: string) {
    super(message)
    this.name = "LocomoHardStopError"
    this.reason = reason
  }
}

/** Exponential backoff (ms) for the Nth (1-based) failed attempt, capped at 4s. */
export function backoffDelayMs(attempt: number): number {
  return Math.min(400 * 2 ** (attempt - 1), 4000)
}

const QUOTA_SIGNAL_RE =
  /insufficient[_ ]?quota|quota[_ ]?exceeded|billing|spend(ing)?[_ ]?cap|payment required|out of credit|insufficient credit/i

export type OllamaCloudFailureAction =
  | { readonly kind: "retry"; readonly delayMs: number }
  | { readonly kind: "hard-stop"; readonly reason: "auth" | "quota" | "rate_limit" | "server" }
  | { readonly kind: "fail" }

/**
 * Pure decision function for how to react to a non-OK `ollama-cloud`
 * response. Kept side-effect-free and exported so it can be unit-tested
 * directly (no network) — see `test/locomo-eval.test.ts`.
 *
 *   - 401/403                      → hard-stop (auth): the key is bad; every
 *                                     subsequent call will fail the same way.
 *   - 402, or body mentions quota/
 *     billing/spend-cap/credit     → hard-stop (quota): a spend/quota cap,
 *                                     regardless of HTTP status.
 *   - 429                          → retry with backoff until `maxAttempts`,
 *                                     then hard-stop (rate_limit): sustained
 *                                     throttling that doesn't clear.
 *   - 5xx                          → retry with backoff until `maxAttempts`,
 *                                     then hard-stop (server): persistent
 *                                     infra failure, not a one-off blip.
 *   - anything else (4xx)          → plain "fail" — a normal per-QA-pair
 *                                     error (e.g. a malformed request for
 *                                     this one prompt), not systemic.
 */
export function classifyOllamaCloudResponse(args: {
  readonly status: number
  readonly body: string
  readonly attempt: number
  readonly maxAttempts: number
}): OllamaCloudFailureAction {
  const { status, body, attempt, maxAttempts } = args
  if (status === 401 || status === 403) {
    return { kind: "hard-stop", reason: "auth" }
  }
  if (status === 402 || QUOTA_SIGNAL_RE.test(body)) {
    return { kind: "hard-stop", reason: "quota" }
  }
  if (status === 429) {
    if (attempt >= maxAttempts) return { kind: "hard-stop", reason: "rate_limit" }
    return { kind: "retry", delayMs: backoffDelayMs(attempt) }
  }
  if (status >= 500) {
    if (attempt >= maxAttempts) return { kind: "hard-stop", reason: "server" }
    return { kind: "retry", delayMs: backoffDelayMs(attempt) }
  }
  return { kind: "fail" }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One session's number + its LoCoMo-annotated date/time string. */
export interface SessionDateEntry {
  readonly sessionNum: number
  readonly date: string
}

/**
 * Builds the explicit, clearly-labeled "Session dates for reference" block
 * injected into the answer prompt (Task 3 — deterministic temporal index,
 * no LLM call). Returns null when there's no date index to inject (empty
 * array), so callers can skip the block entirely rather than emit an empty
 * label. Kept as a small pure function so it's unit-testable without
 * building a full prompt string.
 */
export function buildDateIndexBlock(dateIndex: ReadonlyArray<SessionDateEntry> | undefined): string | null {
  if (!dateIndex || dateIndex.length === 0) return null
  return dateIndex.map((d) => `session ${d.sessionNum} = ${d.date}`).join(", ")
}

function buildPrompt(
  question: string,
  context: ReadonlyArray<string>,
  dateIndex?: ReadonlyArray<SessionDateEntry>,
): string {
  const contextBlock = context.length > 0 ? context.join("\n") : "(no memories retrieved)"
  const dateBlock = buildDateIndexBlock(dateIndex)
  const lines = [
    "You are answering a question using ONLY the memory excerpts below.",
    "Do not use any outside knowledge. Keep the answer short — a phrase or date, not a paragraph.",
    'If the excerpts do not contain enough information to answer, reply EXACTLY: "No information available."',
  ]
  if (dateBlock !== null) {
    lines.push(
      "",
      'Session dates for reference — resolve any relative date language ("last month", "next Friday", "the week before", etc) in the excerpts or question against these actual dates; do not guess:',
      dateBlock,
    )
  }
  lines.push("", "Memory excerpts:", contextBlock, "", `Question: ${question}`, "Answer:")
  return lines.join("\n")
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "")
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed
  return `http://${trimmed}`
}

interface OllamaChatResponse {
  readonly message?: { readonly role?: string; readonly content?: string }
  readonly prompt_eval_count?: number
  readonly eval_count?: number
}

/**
 * Ask a local Ollama model to answer `question` using only `context` (the
 * memory_search hit texts) via `/api/chat` (non-streaming). Mutates
 * `tracker` with token totals as a side effect — cost is always $0 for the
 * `ollama` rate (see pricing.ts), kept only so the reported shape matches
 * the Anthropic path's.
 */
export async function answerFromContextOllama(args: {
  readonly question: string
  readonly context: ReadonlyArray<string>
  readonly baseUrl: string
  readonly model: string
  readonly tracker: CostTracker
  readonly dateIndex?: ReadonlyArray<SessionDateEntry>
}): Promise<AnswerResult> {
  const prompt = buildPrompt(args.question, args.context, args.dateIndex)
  const url = `${normalizeBaseUrl(args.baseUrl)}/api/chat`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: args.model,
      stream: false,
      messages: [{ role: "user", content: prompt }],
      options: { temperature: 0 },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>")
    throw new Error(
      `locomo-eval: Ollama /api/chat error ${res.status} for model "${args.model}": ${body}`,
    )
  }
  const json = (await res.json()) as OllamaChatResponse
  const text = json.message?.content?.trim() ?? ""
  const tokensIn = json.prompt_eval_count ?? 0
  const tokensOut = json.eval_count ?? 0
  const rate = rateFor(args.model, "ollama")
  const costUsd = priceTurnUsd({ tokensIn, tokensOut }, rate)

  args.tracker.totalTokensIn += tokensIn
  args.tracker.totalTokensOut += tokensOut
  args.tracker.totalCostUsd += costUsd
  args.tracker.calls += 1

  return { text, tokensIn, tokensOut, costUsd }
}

const OLLAMA_CLOUD_DEFAULT_BASE_URL = "https://ollama.com/api"
const OLLAMA_CLOUD_MAX_ATTEMPTS = 4
// Per-attempt request timeout. Without this, a hung connection (no response,
// no error) would block the harness indefinitely — worse than a clean hard
// stop. A timeout is treated the same as any other network-level failure:
// retried with backoff, hard-stop if it never clears.
const OLLAMA_CLOUD_REQUEST_TIMEOUT_MS = 60_000

export interface OllamaCloudChatResult {
  readonly text: string
  readonly tokensIn: number
  readonly tokensOut: number
}

/**
 * Shared retry/hard-stop HTTP client for Ollama's HOSTED cloud
 * `/api/chat` endpoint (`https://ollama.com/api/chat`), authenticated via
 * `Authorization: Bearer <apiKey>`. Retries 429/5xx/network errors with
 * short exponential backoff (see `backoffDelayMs`); throws
 * `LocomoHardStopError` on a hard failure (bad auth, a quota/billing
 * signal, or persistent 429/5xx that doesn't clear after
 * `OLLAMA_CLOUD_MAX_ATTEMPTS` attempts) — see the module docstring and
 * `classifyOllamaCloudResponse`.
 *
 * Extracted as a standalone function (no cost-tracker mutation, no
 * question/context prompt-building) so it can be reused by BOTH the
 * answer-generation step below (`answerFromContextOllamaCloud`) and the
 * LLM-judge re-scoring pass (`judge-rescore.ts`, a different prompt, same
 * auth/retry/hard-stop discipline) without duplicating the retry loop in
 * two places where it could drift.
 */
export async function callOllamaCloudChat(args: {
  readonly prompt: string
  readonly apiKey: string
  readonly model: string
  readonly baseUrl?: string
}): Promise<OllamaCloudChatResult> {
  const url = `${normalizeBaseUrl(args.baseUrl ?? OLLAMA_CLOUD_DEFAULT_BASE_URL)}/chat`
  const maxAttempts = OLLAMA_CLOUD_MAX_ATTEMPTS

  for (let attempt = 1; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${args.apiKey}`,
        },
        body: JSON.stringify({
          model: args.model,
          stream: false,
          messages: [{ role: "user", content: args.prompt }],
          options: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(OLLAMA_CLOUD_REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      // Network-level failure (timeout, DNS, connection reset). Treated the
      // same as a 5xx: retry with backoff, hard-stop if it never clears.
      if (attempt >= maxAttempts) {
        throw new LocomoHardStopError(
          "server",
          `locomo-eval: Ollama Cloud network error after ${attempt} attempt(s): ${String(e)}`,
        )
      }
      await sleep(backoffDelayMs(attempt))
      continue
    }

    if (res.ok) {
      const json = (await res.json()) as OllamaChatResponse
      const text = json.message?.content?.trim() ?? ""
      const tokensIn = json.prompt_eval_count ?? 0
      const tokensOut = json.eval_count ?? 0
      return { text, tokensIn, tokensOut }
    }

    const body = await res.text().catch(() => "<no body>")
    const action = classifyOllamaCloudResponse({ status: res.status, body, attempt, maxAttempts })
    if (action.kind === "hard-stop") {
      throw new LocomoHardStopError(
        action.reason,
        `locomo-eval: Ollama Cloud hard stop (${action.reason}) after ${attempt} attempt(s) — HTTP ${res.status} for model "${args.model}": ${body.slice(0, 500)}`,
      )
    }
    if (action.kind === "retry") {
      await sleep(action.delayMs)
      continue
    }
    throw new Error(
      `locomo-eval: Ollama Cloud /api/chat error ${res.status} for model "${args.model}": ${body}`,
    )
  }
}

/**
 * Ask a model on Ollama's HOSTED cloud API to answer `question` using only
 * `context`. Builds the answer-generation prompt, delegates the HTTP
 * request/retry/hard-stop handling to `callOllamaCloudChat`, and records
 * token/cost totals on `tracker` — see that function's docstring for the
 * request semantics.
 */
export async function answerFromContextOllamaCloud(args: {
  readonly question: string
  readonly context: ReadonlyArray<string>
  readonly apiKey: string
  readonly model: string
  readonly tracker: CostTracker
  readonly baseUrl?: string
  readonly dateIndex?: ReadonlyArray<SessionDateEntry>
}): Promise<AnswerResult> {
  const prompt = buildPrompt(args.question, args.context, args.dateIndex)
  const { text, tokensIn, tokensOut } = await callOllamaCloudChat({
    prompt,
    apiKey: args.apiKey,
    model: args.model,
    ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
  })
  const rate = rateFor(args.model, "ollama-cloud")
  const costUsd = priceTurnUsd({ tokensIn, tokensOut }, rate)

  args.tracker.totalTokensIn += tokensIn
  args.tracker.totalTokensOut += tokensOut
  args.tracker.totalCostUsd += costUsd
  args.tracker.calls += 1

  return { text, tokensIn, tokensOut, costUsd }
}

/**
 * Anthropic Messages API path — preserved behind
 * `LUNA_LOCOMO_ANSWER_BACKEND=anthropic` for future flexibility (e.g. a
 * paid-model comparison run once an API key is available). NOT the default
 * — see module docstring.
 */
export async function answerFromContextAnthropic(args: {
  readonly question: string
  readonly context: ReadonlyArray<string>
  readonly apiKey: string
  readonly model: string
  readonly tracker: CostTracker
  readonly dateIndex?: ReadonlyArray<SessionDateEntry>
}): Promise<AnswerResult> {
  const prompt = buildPrompt(args.question, args.context, args.dateIndex)
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": args.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: 128,
      messages: [{ role: "user", content: prompt }],
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>")
    throw new Error(
      `locomo-eval: Anthropic API error ${res.status} for model "${args.model}": ${body}`,
    )
  }
  const json = (await res.json()) as {
    content?: ReadonlyArray<{ type: string; text?: string }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  const text = json.content?.find((c) => c.type === "text")?.text?.trim() ?? ""
  const tokensIn = json.usage?.input_tokens ?? 0
  const tokensOut = json.usage?.output_tokens ?? 0
  const rate = rateFor(args.model, "anthropic")
  const costUsd = priceTurnUsd({ tokensIn, tokensOut }, rate)

  args.tracker.totalTokensIn += tokensIn
  args.tracker.totalTokensOut += tokensOut
  args.tracker.totalCostUsd += costUsd
  args.tracker.calls += 1

  return { text, tokensIn, tokensOut, costUsd }
}
