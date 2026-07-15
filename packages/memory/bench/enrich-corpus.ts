/**
 * enrich-corpus — generates SIRA-style alias phrases for the bench corpus.
 *
 * For each corpus record, asks an LLM for up to 10 short phrases (synonyms,
 * hypernyms, colloquialisms, category labels, description-by-effect) that a
 * future query might use but that do NOT appear in the record's own text.
 * Writes a cached sidecar file the bench reads at run time (bench never
 * calls an LLM itself — see memory-suite.ts's LUNA_BENCH_ENRICHMENT).
 *
 * LLM access: shells out to the `claude` CLI (`claude -p --model <model>
 * <prompt>`), batching 10 records per call. Requires the CLI to be
 * installed and authenticated; this script does not fall back to a
 * different model on failure — it stops and reports.
 *
 * Idempotent: records already present in the sidecar are skipped unless
 * --force. Safe to re-run after a partial failure (Ctrl-C, a bad batch).
 *
 * Run via:
 *   bun packages/memory/bench/enrich-corpus.ts
 *   bun packages/memory/bench/enrich-corpus.ts --force
 *   bun packages/memory/bench/enrich-corpus.ts --model sonnet --concurrency 2
 *
 * Exit codes:
 *   0  completed, every record enriched (or already cached)
 *   1  one or more batches failed after the retry-once guard
 *   3  corpus invalid, load error, or invalid configuration
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

// node:child_process, not `Bun.spawn` - the project avoids @types/bun (see
// DESIGN.md and the sqlite backend comments), and execFile with an argv
// array (no shell) is the established idiom for shelling out (see
// packages/core/src/secret-provider/keychain-helper.ts).
const execFileAsync = promisify(execFile)

interface CorpusRecord {
  readonly id: string
  readonly kind: string
  readonly text: string
}

interface Corpus {
  readonly records: ReadonlyArray<CorpusRecord>
}

interface EnrichmentSidecar {
  readonly version: string
  readonly model: string
  readonly generatedAt: string
  readonly phrases: Record<string, ReadonlyArray<string>>
}

const SIDECAR_VERSION = "1"

function parseArgs(argv: ReadonlyArray<string>) {
  let corpusPath: string | undefined
  let outPath: string | undefined
  let model = "haiku"
  let batchSize = 10
  let concurrency = 4
  let force = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--force") force = true
    else if (a === "--corpus") corpusPath = argv[++i]
    else if (a === "--out") outPath = argv[++i]
    else if (a === "--model") model = argv[++i] ?? model
    else if (a === "--batch-size") batchSize = Number(argv[++i])
    else if (a === "--concurrency") concurrency = Number(argv[++i])
  }
  return { corpusPath, outPath, model, batchSize, concurrency, force }
}

function loadCorpus(path: string): Corpus {
  const raw = readFileSync(path, "utf8")
  const parsed = JSON.parse(raw) as { records?: unknown }
  if (!Array.isArray(parsed.records) || parsed.records.length === 0) {
    throw new Error(`corpus: missing or empty \`records\` array (${path})`)
  }
  const records: CorpusRecord[] = parsed.records.map((raw, i) => {
    const rec = raw as Partial<CorpusRecord>
    if (typeof rec.id !== "string" || rec.id.length === 0) {
      throw new Error(`corpus.records[${i}]: missing or invalid \`id\``)
    }
    if (typeof rec.text !== "string" || rec.text.length === 0) {
      throw new Error(`corpus.records[${i}] (${rec.id}): missing or invalid \`text\``)
    }
    return { id: rec.id, kind: typeof rec.kind === "string" ? rec.kind : "unknown", text: rec.text }
  })
  return { records }
}

function loadSidecar(path: string): EnrichmentSidecar | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf8")
    const parsed = JSON.parse(raw) as Partial<EnrichmentSidecar>
    if (parsed.phrases === undefined || typeof parsed.phrases !== "object") {
      throw new Error("sidecar missing `phrases` object")
    }
    return {
      version: parsed.version ?? SIDECAR_VERSION,
      model: parsed.model ?? "unknown",
      generatedAt: parsed.generatedAt ?? new Date(0).toISOString(),
      phrases: parsed.phrases as Record<string, ReadonlyArray<string>>,
    }
  } catch (e) {
    throw new Error(
      `sidecar at ${path} exists but is unreadable/corrupt - fix or delete it before re-running: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

// ─── LLM batch call ───────────────────────────────────────────────────────

const PROMPT_RULES = `You generate SEARCH ALIAS PHRASES for a memory record, adapted from SIRA-style
corpus enrichment. For each record below, produce up to 10 NEW short phrases
(1-4 words each) that a FUTURE SEARCH QUERY might plausibly use to find this
record, but that do NOT appear verbatim in the record's own text. Favor:
synonyms, hypernyms (broader category terms), colloquialisms, category
labels, and description-by-effect (what it does / why it matters).

Forbid:
- any word that already appears in the record's text (even inflected forms)
- generic filler words ("information", "system", "data", "thing", "stuff")
- full sentences or anything longer than 4 words

Output ONLY a single JSON object mapping each record id to an array of
phrase strings. No markdown code fences, no explanation, no extra keys.
Example shape: {"rec_001": ["phrase one", "phrase two"], "rec_002": []}`

function buildPrompt(batch: ReadonlyArray<CorpusRecord>): string {
  const records = batch
    .map((r) => `- id: ${r.id}\n  text: ${r.text}`)
    .join("\n")
  return `${PROMPT_RULES}\n\nRecords:\n${records}\n\nRespond with the JSON object now.`
}

async function callClaude(prompt: string, model: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("claude", ["-p", "--model", model, prompt], {
      // A batch of 10 records' worth of phrases is small text, but give
      // plenty of headroom over execFile's 1MB default.
      maxBuffer: 10 * 1024 * 1024,
    })
    return stdout
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    throw new Error(
      `claude CLI failed: ${(err.stderr ?? "").slice(0, 1000) || err.message || String(e)}`,
    )
  }
}

/** Strips optional ```json fences and surrounding prose the model may add
 * despite instructions, then JSON.parses. Returns null (not a throw) on
 * failure so callers can drive the retry-once policy explicitly. */
function tryParseJson(raw: string): unknown | null {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  const candidate = fenced ? fenced[1]! : trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    // Last resort: find the outermost {...} span and try that (handles
    // stray leading/trailing prose the fence regex above didn't catch).
    const start = candidate.indexOf("{")
    const end = candidate.lastIndexOf("}")
    if (start === -1 || end === -1 || end <= start) return null
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

/** Mechanical post-filter: drop any phrase sharing a content-word stem
 * (5-char prefix, words >4 chars) with the record text - the model's
 * instruction-following is a soft constraint, this is the hard one. */
function contentStems(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const stems = new Set<string>()
  for (const w of words) {
    if (w.length > 4) stems.add(w.slice(0, 5))
  }
  return stems
}

function phraseSharesStem(phrase: string, stems: ReadonlySet<string>): boolean {
  const words = phrase.toLowerCase().match(/[a-z0-9]+/g) ?? []
  return words.some((w) => w.length > 4 && stems.has(w.slice(0, 5)))
}

function filterPhrases(
  rawPhrases: ReadonlyArray<string>,
  recordText: string,
): string[] {
  const stems = contentStems(recordText)
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of rawPhrases) {
    if (typeof raw !== "string") continue
    const phrase = raw.trim()
    if (phrase.length === 0) continue
    if (phrase.split(/\s+/).length > 4) continue
    if (phraseSharesStem(phrase, stems)) continue
    const key = phrase.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(phrase)
    if (out.length >= 10) break
  }
  return out
}

interface BatchResult {
  readonly ok: boolean
  readonly phrasesById: Record<string, string[]>
  readonly error?: string
}

async function runBatch(
  batch: ReadonlyArray<CorpusRecord>,
  model: string,
): Promise<BatchResult> {
  const recordsById = new Map(batch.map((r) => [r.id, r]))
  const attempt = async (extraReminder: string): Promise<unknown | null> => {
    const prompt = buildPrompt(batch) + extraReminder
    const stdout = await callClaude(prompt, model)
    return tryParseJson(stdout)
  }

  let parsed = await attempt("")
  if (parsed === null) {
    // Retry-once-on-bad-JSON guard.
    parsed = await attempt(
      "\n\nYour previous output was not valid JSON. Output ONLY the raw JSON object - no markdown fences, no commentary.",
    )
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      phrasesById: {},
      error: `batch [${batch.map((r) => r.id).join(", ")}]: model did not return valid JSON after retry`,
    }
  }

  const out: Record<string, string[]> = {}
  const obj = parsed as Record<string, unknown>
  for (const [id, rec] of recordsById) {
    const raw = obj[id]
    if (!Array.isArray(raw)) {
      // eslint-disable-next-line no-console
      console.warn(`[enrich-corpus] warning: response missing phrases for ${id}; treating as empty`)
      out[id] = []
      continue
    }
    out[id] = filterPhrases(raw as string[], rec.text)
  }
  return { ok: true, phrasesById: out }
}

async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!, i)
    }
  })
  await Promise.all(workers)
  return results
}

function chunk<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  const { corpusPath, outPath, model, batchSize, concurrency, force } = parseArgs(
    process.argv.slice(2),
  )
  const resolvedCorpus = corpusPath !== undefined ? resolve(corpusPath) : resolve(here, "memory-suite-corpus.json")
  const resolvedOut = outPath !== undefined ? resolve(outPath) : resolve(here, "memory-suite-corpus.enrichment.json")

  if (!Number.isFinite(batchSize) || batchSize < 1) {
    console.error(`[enrich-corpus] invalid --batch-size`)
    process.exit(3)
  }
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    console.error(`[enrich-corpus] invalid --concurrency`)
    process.exit(3)
  }

  let corpus: Corpus
  try {
    corpus = loadCorpus(resolvedCorpus)
  } catch (e) {
    console.error(`[enrich-corpus] corpus load failed (${resolvedCorpus}): ${e instanceof Error ? e.message : String(e)}`)
    process.exit(3)
    return
  }

  let existing: EnrichmentSidecar | null
  try {
    existing = force ? null : loadSidecar(resolvedOut)
  } catch (e) {
    console.error(`[enrich-corpus] ${e instanceof Error ? e.message : String(e)}`)
    process.exit(3)
    return
  }

  const phrases: Record<string, ReadonlyArray<string>> = { ...(existing?.phrases ?? {}) }
  const pending = corpus.records.filter((r) => force || !(r.id in phrases))

  console.log(
    `[enrich-corpus] ${corpus.records.length} records, ${pending.length} pending (${corpus.records.length - pending.length} cached) - model=${model} batch=${batchSize} concurrency=${concurrency}`,
  )

  if (pending.length === 0) {
    console.log(`[enrich-corpus] nothing to do - all records already enriched (use --force to regenerate)`)
    return
  }

  const batches = chunk(pending, batchSize)
  let failures = 0
  let batchesDone = 0

  const results = await mapWithConcurrency(batches, concurrency, async (batch, i) => {
    const result = await runBatch(batch, model)
    batchesDone++
    if (!result.ok) {
      failures++
      console.error(`[enrich-corpus] batch ${i + 1}/${batches.length} FAILED: ${result.error}`)
    } else {
      console.log(`[enrich-corpus] batch ${i + 1}/${batches.length} ok (${batchesDone}/${batches.length} done)`)
    }
    return result
  })

  for (const result of results) {
    if (!result.ok) continue
    for (const [id, list] of Object.entries(result.phrasesById)) {
      phrases[id] = list
    }
  }

  const sidecar: EnrichmentSidecar = {
    version: SIDECAR_VERSION,
    model,
    generatedAt: new Date().toISOString(),
    phrases,
  }
  writeFileSync(resolvedOut, JSON.stringify(sidecar, null, 2) + "\n")
  console.log(`[enrich-corpus] wrote ${resolvedOut} (${Object.keys(phrases).length} records with phrases)`)

  if (failures > 0) {
    console.error(`[enrich-corpus] ${failures}/${batches.length} batches failed - re-run to retry (idempotent, only failed records are missing from the sidecar)`)
    process.exit(1)
  }
}

try {
  await main()
} catch (e) {
  console.error(`[enrich-corpus] runtime failure: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(3)
}
