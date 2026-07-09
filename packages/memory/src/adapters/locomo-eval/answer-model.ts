/**
 * answer-model — generates an answer from ONLY the retrieved memory context
 * (no full conversation, no ground truth). This is the "fair comparison"
 * step per the task brief: it tests whether Luna's retrieval surfaced the
 * right memory, not whether a model with the whole transcript can answer.
 *
 * Backend: **Ollama by default** (`/api/chat`, local, zero API cost — same
 * daemon/base-URL convention `packages/core/src/embedder/embedder.ts` uses
 * for embeddings via `LUNA_OLLAMA_BASE_URL`). Deliberately dependency-free
 * (plain `fetch`, no SDK), mirroring the embedder module's own HTTP client
 * rather than introducing a new one.
 *
 * The original Anthropic Messages API path is kept behind
 * `LUNA_LOCOMO_ANSWER_BACKEND=anthropic` for future flexibility (e.g. if an
 * operator later wants a paid-model comparison run) — but it is no longer
 * the default, since this harness now runs entirely on local compute and
 * needs no key.
 *
 * Cost tracking: for the Ollama path this is always $0 (see
 * `packages/core/src/pricing.ts`'s `ollama` rate — 0/0 per million tokens).
 * We still fill in token counts (Ollama reports `prompt_eval_count` /
 * `eval_count`) purely for observability/debugging, not for a budget cap —
 * see `run.ts` for why the budget guard was replaced with a wall-clock
 * estimate instead of a dollar cap.
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

function buildPrompt(question: string, context: ReadonlyArray<string>): string {
  const contextBlock = context.length > 0 ? context.join("\n") : "(no memories retrieved)"
  return [
    "You are answering a question using ONLY the memory excerpts below.",
    "Do not use any outside knowledge. Keep the answer short — a phrase or date, not a paragraph.",
    'If the excerpts do not contain enough information to answer, reply EXACTLY: "No information available."',
    "",
    "Memory excerpts:",
    contextBlock,
    "",
    `Question: ${question}`,
    "Answer:",
  ].join("\n")
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
}): Promise<AnswerResult> {
  const prompt = buildPrompt(args.question, args.context)
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
}): Promise<AnswerResult> {
  const prompt = buildPrompt(args.question, args.context)
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
