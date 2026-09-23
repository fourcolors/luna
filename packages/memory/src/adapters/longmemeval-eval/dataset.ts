/**
 * LongMemEval dataset fetch + flatten.
 *
 * Source: official cleaned release, HuggingFace
 * `xiaowu0162/longmemeval-cleaned` (MIT). The paper repo is
 * https://github.com/xiaowu0162/LongMemEval (ICLR 2025).
 *
 * Never vendor the 15MB+ JSON into git. `fetchDataset()` caches it under
 * this adapter's gitignored `.cache/` directory.
 *
 * Default file is `longmemeval_oracle.json` - the official "oracle
 * retrieval" split (only evidence sessions in the haystack). That is the
 * smallest official haystack, not a 10-20 question sample, and there is
 * no official 10-20 question sample file. `SPLIT_URLS` lists the larger
 * S / M haystacks. `selectSubset` picks N instances via a seeded shuffle
 * (default seed 42) because the files are type-clustered.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { FlatTurn, LmeInstance } from "./types.js"

const HF_BASE = "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main"

/**
 * The three official splits: the same 500 questions, different haystacks.
 * oracle = evidence sessions only; s = ~50 sessions (~500 turns) per
 * question; m = ~500 sessions. NB: the files list questions in DIFFERENT
 * orders, which is why `selectSubset` sorts by id before shuffling.
 */
export const SPLIT_URLS = {
  oracle: `${HF_BASE}/longmemeval_oracle.json`,
  s: `${HF_BASE}/longmemeval_s_cleaned.json`,
  m: `${HF_BASE}/longmemeval_m_cleaned.json`,
} as const
export type LmeSplit = keyof typeof SPLIT_URLS

const DEFAULT_DATASET_URL = SPLIT_URLS.oracle

const here = dirname(fileURLToPath(import.meta.url))
export const CACHE_DIR = resolve(here, ".cache")

export function isAbstentionId(questionId: string): boolean {
  return questionId.includes("_abs")
}

export interface LoadedDataset {
  /** File name of the split, e.g. `longmemeval_oracle.json`. */
  readonly file: string
  readonly instances: ReadonlyArray<LmeInstance>
}

/**
 * Download (if not cached) and parse an official LongMemEval JSON (oracle by
 * default). The cache is keyed by file name, so overriding the URL with
 * another split never reuses or mislabels the oracle cache. Subsetting
 * happens in `selectSubset`.
 */
export async function fetchDataset(
  url: string = process.env["LUNA_LME_DATASET_URL"] || DEFAULT_DATASET_URL,
): Promise<LoadedDataset> {
  const file = basename(new URL(url).pathname)
  const CACHE_PATH = resolve(CACHE_DIR, file)
  if (!existsSync(CACHE_PATH)) {
    mkdirSync(CACHE_DIR, { recursive: true })
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(
        `longmemeval-eval: failed to fetch dataset from ${url} - HTTP ${res.status}`,
      )
    }
    const body = await res.text()
    writeFileSync(CACHE_PATH, body, "utf8")
  }
  const raw = readFileSync(CACHE_PATH, "utf8")
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`longmemeval-eval: parsed dataset at ${CACHE_PATH} is empty or malformed`)
  }
  return { file, instances: parsed as ReadonlyArray<LmeInstance> }
}

/**
 * Deterministic subset. The official oracle file is grouped by
 * `question_type` (first ~N are all temporal-reasoning), so a raw
 * file-order slice is a one-category smoke. Default is a seeded
 * Fisher-Yates shuffle (seed 42) then first `limit` - still
 * non-cherry-picked, just not type-clustered. The shuffle runs over the
 * questions SORTED BY ID, so every split picks the same questions for a
 * given seed and results are comparable across haystacks. Set `seed` to
 * null to take file order instead.
 */
export function seededShuffle<T>(items: ReadonlyArray<T>, seed: number): T[] {
  const arr = items.slice()
  let s = seed >>> 0
  for (let i = arr.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    // Use the LCG's HIGH bits: its low bits cycle with short periods.
    const j = Math.floor((s / 2 ** 32) * (i + 1))
    const tmp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = tmp
  }
  return arr
}

export function selectSubset(
  dataset: ReadonlyArray<LmeInstance>,
  limit: number,
  seed: number | null = 42,
): ReadonlyArray<LmeInstance> {
  if (limit <= 0) return []
  if (seed === null) return dataset.slice(0, limit)
  const byId = dataset
    .slice()
    .sort((a, b) => (a.question_id < b.question_id ? -1 : a.question_id > b.question_id ? 1 : 0))
  return seededShuffle(byId, seed).slice(0, limit)
}

/**
 * Flatten one instance's haystack into ordered turns. Sessions stay in the
 * file's haystack array order (oracle is not timestamp-sorted per the
 * official README; S/M are).
 */
export function flattenTurns(instance: LmeInstance): ReadonlyArray<FlatTurn> {
  const out: FlatTurn[] = []
  const sessions = instance.haystack_sessions ?? []
  const ids = instance.haystack_session_ids ?? []
  const dates = instance.haystack_dates ?? []
  for (let s = 0; s < sessions.length; s++) {
    const turns = sessions[s]
    if (!Array.isArray(turns)) continue
    const sessionId = ids[s] ?? `session-${s}`
    const sessionDate = dates[s] ?? instance.question_date
    for (let t = 0; t < turns.length; t++) {
      const turn = turns[t]
      if (!turn || typeof turn.content !== "string") continue
      out.push({
        questionId: instance.question_id,
        sessionId,
        sessionIdx: s,
        sessionDate,
        turnIdx: t,
        role: typeof turn.role === "string" ? turn.role : "unknown",
        text: turn.content,
        hasAnswer: turn.has_answer === true,
      })
    }
  }
  return out
}
