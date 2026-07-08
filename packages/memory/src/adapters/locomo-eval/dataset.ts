/**
 * LoCoMo dataset fetch + parse.
 *
 * Source: https://github.com/snap-research/locomo (data/locomo10.json),
 * mirrored on HuggingFace by the paper's lead author as adymaharana/locomo.
 * License: CC BY-NC 4.0 (Attribution-NonCommercial) — see README.md for the
 * full license discussion.
 *
 * IMPORTANT: we deliberately do NOT vendor the dataset into this repo.
 * `fetchDataset()` downloads to a git-ignored local cache directory
 * (`.cache/` inside this adapter dir) on first use and reads from cache on
 * subsequent runs. This keeps the NC-licensed dataset out of Luna's git
 * history entirely — only our own harness code (which is ours to license)
 * is committed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { FlatTurn, LocomoSample } from "./types.js"

const DATASET_URL =
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"

const here = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = resolve(here, ".cache")
const CACHE_PATH = resolve(CACHE_DIR, "locomo10.json")

/**
 * Download (if not cached) and parse the LoCoMo10 dataset. Returns the raw
 * array of 10 conversation samples.
 */
export async function fetchDataset(): Promise<ReadonlyArray<LocomoSample>> {
  if (!existsSync(CACHE_PATH)) {
    mkdirSync(CACHE_DIR, { recursive: true })
    const res = await fetch(DATASET_URL)
    if (!res.ok) {
      throw new Error(
        `locomo-eval: failed to fetch dataset from ${DATASET_URL} — HTTP ${res.status}`,
      )
    }
    const body = await res.text()
    writeFileSync(CACHE_PATH, body, "utf8")
  }
  const raw = readFileSync(CACHE_PATH, "utf8")
  const parsed = JSON.parse(raw) as ReadonlyArray<LocomoSample>
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `locomo-eval: parsed dataset at ${CACHE_PATH} is empty or malformed`,
    )
  }
  return parsed
}

/**
 * Flatten a sample's `conversation` object into an ordered list of turns.
 * Sessions are visited in numeric order (1, 2, 3, ...), not object key
 * insertion order, since the dataset's own key order isn't guaranteed.
 */
export function flattenTurns(sample: LocomoSample): ReadonlyArray<FlatTurn> {
  const conv = sample.conversation
  const sessionNums: number[] = []
  for (const key of Object.keys(conv)) {
    const m = /^session_(\d+)$/.exec(key)
    if (m) sessionNums.push(Number(m[1]))
  }
  sessionNums.sort((a, b) => a - b)

  const out: FlatTurn[] = []
  for (const n of sessionNums) {
    const turns = conv[`session_${n}`]
    const dateTime = conv[`session_${n}_date_time`]
    if (!Array.isArray(turns) || typeof dateTime !== "string") continue
    for (const t of turns) {
      const text = t.blip_caption
        ? `${t.text} [shared an image: ${t.blip_caption}]`
        : t.text
      out.push({
        sampleId: sample.sample_id,
        sessionNum: n,
        sessionDateTime: dateTime,
        speaker: t.speaker,
        diaId: t.dia_id,
        text,
      })
    }
  }
  return out
}
