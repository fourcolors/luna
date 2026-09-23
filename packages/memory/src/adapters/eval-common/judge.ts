/**
 * Relevance judges for the eval harnesses' rerank stage (`rr=<judge>@<n>` in
 * a search-config label): score each (query, memory) pair, higher = more
 * relevant, so a wide lexical candidate pool can be re-ordered by a model
 * that actually reads both texts.
 *
 *   ce   the local cross-encoder production already uses for memory_search
 *        (Qwen3-Reranker-0.6B via llama-server /v1/rerank; see
 *        packages/adapter-sdk/src/cross-encoder-reranker.ts). Same model and
 *        endpoint; this client is the minimal eval version (no probe cache,
 *        no request splitting - documents are capped at MAX_DOC_CHARS).
 *   jev  TypeSafe's Jev (System One): one request, one Noul per candidate,
 *        state = the question. Needs TYPESAFE_API_KEY.
 *
 * Both return scores in candidate order and throw on any malformed or
 * partial response: a judge that silently drops candidates would bias the
 * ranking it is meant to measure.
 */

/** Per-candidate text cap: keeps every (query, doc) pair inside the CE's 4096-token batch. */
export const MAX_DOC_CHARS = 2000

export type JudgeName = "ce" | "jev"

export interface Judge {
  readonly name: JudgeName
  /** Relevance of each candidate to `query`, in candidate order. */
  readonly score: (query: string, candidates: ReadonlyArray<string>) => Promise<ReadonlyArray<number>>
}

const cap = (s: string) => (s.length > MAX_DOC_CHARS ? s.slice(0, MAX_DOC_CHARS) : s)

export function crossEncoderJudge(baseUrl: string, timeoutMs = 60_000): Judge {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/rerank`
  return {
    name: "ce",
    score: async (query, candidates) => {
      if (candidates.length === 0) return []
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "cross-encoder", query, documents: candidates.map(cap), top_n: candidates.length }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`cross-encoder HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const json = (await res.json()) as { results?: ReadonlyArray<{ index?: unknown; relevance_score?: unknown }> }
      const scores: Array<number | undefined> = candidates.map(() => undefined)
      for (const r of json.results ?? []) {
        if (typeof r.index !== "number" || typeof r.relevance_score !== "number") {
          throw new Error("cross-encoder: malformed result entry")
        }
        if (scores[r.index] !== undefined) throw new Error(`cross-encoder: duplicate index ${r.index}`)
        scores[r.index] = r.relevance_score
      }
      if (scores.some((s) => s === undefined)) throw new Error("cross-encoder: partial response")
      return scores as number[]
    },
  }
}

export const JEV_URL = "https://api.typesafe.ai/v1/systemone"

export function jevJudge(apiKey: string, model = "jev-latest", timeoutMs = 60_000): Judge {
  return {
    name: "jev",
    score: async (query, candidates) => {
      if (candidates.length === 0) return []
      const questions = Object.fromEntries(
        candidates.map((text, i) => [
          `c${i}`,
          {
            type: "noul",
            instructions: {
              task: "Does the `memory` contain information that helps answer the user's `question` (in state)?",
              memory: cap(text),
            },
            criteria: {
              true: "The memory states facts that answer or directly bear on the question.",
              false: "The memory is about something else, or only shares words or a topic with the question.",
            },
          },
        ]),
      )
      const res = await fetch(JEV_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, state: { question: query }, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`jev HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const json = (await res.json()) as { answers?: Record<string, { type?: unknown; noul?: unknown }> }
      return candidates.map((_, i) => {
        const a = json.answers?.[`c${i}`]
        if (a === undefined || typeof a.noul !== "number") throw new Error(`jev: missing or malformed answer c${i}`)
        return a.noul
      })
    },
  }
}

/**
 * Build the judges a set of configs names. A config naming a judge that
 * cannot be built (no API key) is a configuration error, never a silent
 * un-reranked run.
 */
export function makeJudges(
  names: ReadonlyArray<JudgeName>,
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<JudgeName, Judge> {
  const out = new Map<JudgeName, Judge>()
  for (const name of new Set(names)) {
    if (name === "ce") out.set("ce", crossEncoderJudge(env["LUNA_RERANK_CE_URL"]?.trim() || "http://127.0.0.1:8181"))
    else {
      const key = env["TYPESAFE_API_KEY"]?.trim()
      if (!key) throw new Error("rr=jev needs TYPESAFE_API_KEY")
      out.set("jev", jevJudge(key, env["LUNA_JEV_MODEL"]?.trim() || "jev-latest"))
    }
  }
  return out
}
