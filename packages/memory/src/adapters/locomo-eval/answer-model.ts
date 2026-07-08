/**
 * answer-model — thin wrapper around the Anthropic Messages API used to
 * generate an answer from ONLY the retrieved memory context (no full
 * conversation, no ground truth). This is the "fair comparison" step per
 * the task brief: it tests whether Luna's retrieval surfaced the right
 * memory, not whether a model with the whole transcript can answer.
 *
 * Deliberately dependency-free (plain `fetch`, no `@anthropic-ai/sdk`) to
 * avoid adding a new workspace dependency for a benchmark harness.
 *
 * Cost tracking: reuses @luna/core's `rateFor` / `priceTurnUsd` — the SAME
 * pricing table the chat-server's own cost-meter uses — so the harness's
 * dollar estimate is consistent with how Luna prices itself everywhere else.
 *
 * Model id: the raw Anthropic API requires an exact, dated model id (NOT
 * the "haiku"/"sonnet" tier aliases the Claude Agent SDK resolves
 * internally). We do NOT hardcode a guessed id — the caller MUST set
 * `LUNA_LOCOMO_ANSWER_MODEL`. See README.md "Running the harness" for how
 * to find the current id.
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

/**
 * Ask the configured Anthropic model to answer `question` using only
 * `context` (the memory_search hit texts). Mutates `tracker` with token/
 * cost totals as a side effect so callers can enforce a running budget cap.
 */
export async function answerFromContext(args: {
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
  const text =
    json.content?.find((c) => c.type === "text")?.text?.trim() ?? ""
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
