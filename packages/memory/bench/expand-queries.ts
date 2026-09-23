/**
 * expand-queries - simulates a calling agent writing QUERY-EXPANSION
 * keywords for memory search, so the bench can measure whether expansion
 * helps or hurts recall/precision.
 *
 * For each query the model sees ONLY the query text - never a memory
 * record, never the gold answer/relevantIds - and is asked for up to 8
 * short keywords/phrases (synonyms, related entities, alternate phrasings,
 * terms a relevant stored memory might contain) that do NOT just restate
 * the query's own words. This mirrors what a real calling agent would do:
 * it only ever sees the user's query, not the memory store's contents.
 *
 * Each sample is its OWN independent LLM request/batch (never "give me 3
 * variants in one response") so repeated samples are genuinely independent
 * draws from the model, not one call's imagined diversity.
 *
 * Sources (--source):
 *   memory-suite  - queries[] from memory-suite-corpus.json (id, text)
 *   longmemeval   - first N questions (--limit, default 260) of the
 *                   LongMemEval oracle split, via selectSubset(seed 42)
 *
 * LLM access: shells out to the `claude` CLI (`claude -p --model <model>`,
 * prompt piped over stdin), batching --batch queries per call, one call per
 * (sample, batch) pair. Requires the CLI installed and authenticated; this
 * script does not fall back to a different model on failure - it stops and
 * reports.
 *
 * Idempotent: a (query id, sample index) slot already present in the
 * sidecar is skipped unless --force. Samples are filled in index order per
 * query (sample i is only attempted once sample i-1 is filled) so the
 * on-disk `keywords[id]` array is always dense, never holey. Safe to
 * re-run after a partial failure - the sidecar is flushed atomically to
 * disk after every completed batch, and a query id missing or malformed in
 * a response is left absent from that sample slot (never stored as []) so
 * the next run retries it.
 *
 * The sidecar's `promptHash` pins the exact prompt template text. If the
 * template changes, an existing sidecar (built from stale samples) refuses
 * to be reused unless --force explicitly discards it - a prompt change can
 * never silently mix old and new samples.
 *
 * Run via:
 *   bun packages/memory/bench/expand-queries.ts --source memory-suite --model haiku
 *   bun packages/memory/bench/expand-queries.ts --source longmemeval --model sonnet --limit 260
 *   bun packages/memory/bench/expand-queries.ts --source memory-suite --force
 *
 * Exit codes:
 *   0  completed, every requested (query, sample) slot filled (or already
 *      cached)
 *   1  one or more batches failed, or some ids were missing from a
 *      response, after the retry-once guard
 *   3  bad config/input (invalid flags, corpus/dataset load error, or a
 *      promptHash/model mismatch on an existing sidecar without --force)
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { sleep } from "../src/sleep.js"
import { fetchDataset, selectSubset, SPLIT_URLS } from "../src/adapters/longmemeval-eval/dataset.js"

// node:child_process, not `Bun.spawn` - the project avoids @types/bun (see
// DESIGN.md and enrich-corpus.ts). The prompt is piped over stdin rather
// than passed as an argv element so large batches can't hit ARG_MAX.

type Source = "memory-suite" | "longmemeval"

interface QueryItem {
  readonly id: string
  readonly text: string
}

interface ExpansionSidecar {
  readonly source: string
  readonly model: string
  readonly promptHash: string
  readonly generatedAt: string
  readonly samples: number
  readonly keywords: Record<string, ReadonlyArray<ReadonlyArray<string>>>
}

const DEFAULT_LONGMEMEVAL_LIMIT = 260

function parseArgs(argv: ReadonlyArray<string>) {
  let source: string | undefined
  let model = "haiku"
  let samples = 3
  let limit: number | undefined
  let concurrency = 2
  let batchSize = 10
  let force = false
  let outPath: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--force") force = true
    else if (a === "--source") source = argv[++i]
    else if (a === "--model") model = argv[++i] ?? model
    else if (a === "--samples") samples = Number(argv[++i])
    else if (a === "--limit") limit = Number(argv[++i])
    else if (a === "--concurrency") concurrency = Number(argv[++i])
    else if (a === "--batch") batchSize = Number(argv[++i])
    else if (a === "--out") outPath = argv[++i]
  }
  return { source, model, samples, limit, concurrency, batchSize, force, outPath }
}

// ─── query loading ────────────────────────────────────────────────────────

function loadMemorySuiteQueries(corpusPath: string, limit: number | undefined): QueryItem[] {
  const raw = readFileSync(corpusPath, "utf8")
  const parsed = JSON.parse(raw) as { queries?: unknown }
  if (!Array.isArray(parsed.queries) || parsed.queries.length === 0) {
    throw new Error(`memory-suite corpus: missing or empty \`queries\` array (${corpusPath})`)
  }
  const queries: QueryItem[] = parsed.queries.map((raw, i) => {
    const q = raw as Partial<QueryItem>
    if (typeof q.id !== "string" || q.id.length === 0) {
      throw new Error(`memory-suite corpus queries[${i}]: missing or invalid \`id\``)
    }
    if (typeof q.text !== "string" || q.text.length === 0) {
      throw new Error(`memory-suite corpus queries[${i}] (${q.id}): missing or invalid \`text\``)
    }
    return { id: q.id, text: q.text }
  })
  return limit !== undefined ? queries.slice(0, limit) : queries
}

async function loadLongMemEvalQueries(limit: number): Promise<QueryItem[]> {
  const loaded = await fetchDataset(SPLIT_URLS.oracle)
  const subset = selectSubset(loaded.instances, limit, 42)
  return subset.map((inst) => ({ id: inst.question_id, text: inst.question }))
}

// ─── LLM batch call ───────────────────────────────────────────────────────

const PROMPT_RULES = `You are simulating a calling agent that writes QUERY-EXPANSION keywords to
help a memory-search system find relevant stored notes. You are given
several search queries below. For EACH query you see ONLY the query text -
you do NOT have access to any stored memory record, document, or the
correct answer.

For each query, produce up to 8 short keywords or phrases (each at most 6
words) that a relevant stored memory might plausibly contain: synonyms,
related entities, alternate phrasings, and specific terms tied to the
query's topic.

Do NOT just restate the query's own words back - every keyword must add
something the query text itself does not already say.

Output ONLY a single JSON object mapping each query id to an array of
keyword/phrase strings. No markdown code fences, no explanation, no extra
keys. Example shape: {"q_001": ["term one", "term two"], "q_002": []}`

const PROMPT_HASH = createHash("sha256").update(PROMPT_RULES).digest("hex").slice(0, 16)

function buildPrompt(batch: ReadonlyArray<QueryItem>): string {
  const queries = batch.map((q) => `- id: ${q.id}\n  query: ${q.text}`).join("\n")
  return `${PROMPT_RULES}\n\nQueries:\n${queries}\n\nRespond with the JSON object now.`
}

const CALL_TIMEOUT_MS = 90_000

/** Spawns one `claude -p --model <model>` call with the prompt piped over
 * stdin (avoids ARG_MAX on large batches). Rejects on nonzero exit or a
 * timeout so callClaudeWithRetry can treat both as a transient failure. */
function callClaudeOnce(prompt: string, model: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("claude", ["-p", "--model", model], { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`claude call timed out after ${CALL_TIMEOUT_MS}ms`))
    }, CALL_TIMEOUT_MS)
    child.stdout.on("data", (d) => (stdout += String(d)))
    child.stderr.on("data", (d) => (stderr += String(d)))
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    // EPIPE guard: the child can exit before consuming stdin (crash, bad
    // model name); without this listener that throws an unhandled 'error'
    // event instead of letting the 'close' handler report the real cause.
    child.stdin.on("error", () => {})
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`claude CLI failed: ${stderr.slice(0, 1000) || `exited ${code}`}`))
        return
      }
      resolvePromise(stdout)
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

/** Retries once on a transient CLI failure (nonzero exit, timeout) after a
 * short backoff. This is separate from the bad-JSON retry in runBatch,
 * which needs to alter the prompt rather than just resend it. */
async function callClaudeWithRetry(prompt: string, model: string): Promise<string> {
  try {
    return await callClaudeOnce(prompt, model)
  } catch (e) {
    console.warn(
      `[expand-queries] transient CLI failure, retrying after 2s backoff: ${e instanceof Error ? e.message : String(e)}`,
    )
    await sleep(2000)
    return await callClaudeOnce(prompt, model)
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

/** Sanitizes one query's raw keyword array: trim, drop empties, drop
 * anything longer than 6 words, dedupe case-insensitively, cap at 8. */
function sanitizeKeywords(raw: ReadonlyArray<unknown>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== "string") continue
    const kw = item.trim()
    if (kw.length === 0) continue
    if (kw.split(/\s+/).length > 6) continue
    const key = kw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(kw)
    if (out.length >= 8) break
  }
  return out
}

interface BatchResult {
  readonly ok: boolean
  readonly keywordsById: Record<string, string[]>
  /** ids in this batch the model's response omitted entirely, or returned
   * malformed (not an array) - left absent so a rerun retries them. */
  readonly missingIds: ReadonlyArray<string>
  readonly error?: string
}

async function runBatch(batch: ReadonlyArray<QueryItem>, model: string): Promise<BatchResult> {
  const byId = new Map(batch.map((q) => [q.id, q]))
  let lastError: string | undefined
  const attempt = async (extraReminder: string): Promise<unknown | null> => {
    const prompt = buildPrompt(batch) + extraReminder
    try {
      const stdout = await callClaudeWithRetry(prompt, model)
      return tryParseJson(stdout)
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      return null
    }
  }

  let parsed = await attempt("")
  if (parsed === null) {
    // Retry-once-on-bad-JSON guard (separate from callClaudeWithRetry's
    // transient-CLI-failure retry above).
    parsed = await attempt(
      "\n\nYour previous output was not valid JSON. Output ONLY the raw JSON object - no markdown fences, no commentary.",
    )
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      keywordsById: {},
      missingIds: [],
      error:
        lastError !== undefined
          ? `batch [${batch.map((q) => q.id).join(", ")}]: claude CLI call failed after retry - ${lastError}`
          : `batch [${batch.map((q) => q.id).join(", ")}]: model did not return valid JSON after retry`,
    }
  }

  const out: Record<string, string[]> = {}
  const missingIds: string[] = []
  const obj = parsed as Record<string, unknown>
  for (const [id] of byId) {
    const raw = obj[id]
    if (!Array.isArray(raw)) {
      // Do NOT store [] here - an absent id is what marks it pending for
      // the next run. A model-returned [] (explicit empty list) is stored
      // normally below via sanitizeKeywords on an empty array.
      missingIds.push(id)
      console.warn(`[expand-queries] warning: response missing keywords for ${id}; will retry on next run`)
      continue
    }
    out[id] = sanitizeKeywords(raw)
  }
  return { ok: true, keywordsById: out, missingIds }
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

function loadSidecar(path: string): ExpansionSidecar | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf8")
    const parsed = JSON.parse(raw) as Partial<ExpansionSidecar>
    if (parsed.keywords === undefined || typeof parsed.keywords !== "object") {
      throw new Error("sidecar missing `keywords` object")
    }
    return {
      source: parsed.source ?? "unknown",
      model: parsed.model ?? "unknown",
      promptHash: parsed.promptHash ?? "unknown",
      generatedAt: parsed.generatedAt ?? new Date(0).toISOString(),
      samples: typeof parsed.samples === "number" ? parsed.samples : 0,
      keywords: parsed.keywords as Record<string, ReadonlyArray<ReadonlyArray<string>>>,
    }
  } catch (e) {
    throw new Error(
      `sidecar at ${path} exists but is unreadable/corrupt - fix or delete it before re-running: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/** Atomic write: temp file in the same dir + rename, so a crash mid-write
 * (or a concurrent reader) can never see a truncated/corrupt sidecar. */
function writeSidecarAtomic(sidecar: ExpansionSidecar, path: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(sidecar, null, 2) + "\n")
  renameSync(tmp, path)
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  const { source, model, samples, limit, concurrency, batchSize, force, outPath } = parseArgs(
    process.argv.slice(2),
  )

  if (source !== "memory-suite" && source !== "longmemeval") {
    console.error(`[expand-queries] invalid or missing --source (expected "memory-suite" or "longmemeval")`)
    process.exit(3)
    return
  }
  const resolvedSource: Source = source
  if (!Number.isFinite(samples) || samples < 1) {
    console.error(`[expand-queries] invalid --samples`)
    process.exit(3)
    return
  }
  if (!Number.isFinite(batchSize) || batchSize < 1) {
    console.error(`[expand-queries] invalid --batch`)
    process.exit(3)
    return
  }
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    console.error(`[expand-queries] invalid --concurrency`)
    process.exit(3)
    return
  }
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    console.error(`[expand-queries] invalid --limit`)
    process.exit(3)
    return
  }

  let queries: QueryItem[]
  try {
    if (resolvedSource === "memory-suite") {
      queries = loadMemorySuiteQueries(resolve(here, "memory-suite-corpus.json"), limit)
    } else {
      queries = await loadLongMemEvalQueries(limit ?? DEFAULT_LONGMEMEVAL_LIMIT)
    }
  } catch (e) {
    console.error(`[expand-queries] failed to load ${resolvedSource} queries: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(3)
    return
  }
  if (queries.length === 0) {
    console.error(`[expand-queries] ${resolvedSource}: no queries to expand`)
    process.exit(3)
    return
  }

  const resolvedOut =
    outPath !== undefined ? resolve(outPath) : resolve(here, "expansion", `${resolvedSource}-${model}.json`)
  mkdirSync(dirname(resolvedOut), { recursive: true })

  let existing: ExpansionSidecar | null
  try {
    existing = loadSidecar(resolvedOut)
  } catch (e) {
    console.error(`[expand-queries] ${e instanceof Error ? e.message : String(e)}`)
    process.exit(3)
    return
  }

  if (existing !== null && (existing.promptHash !== PROMPT_HASH || existing.model !== model)) {
    if (!force) {
      console.error(
        `[expand-queries] existing sidecar at ${resolvedOut} has promptHash=${existing.promptHash} model=${existing.model}, ` +
          `this run has promptHash=${PROMPT_HASH} model=${model} - refusing to mix stale samples with a changed prompt/model. ` +
          `Re-run with --force to discard the existing sidecar and start fresh.`,
      )
      process.exit(3)
      return
    }
    console.warn(`[expand-queries] --force: discarding existing sidecar (promptHash/model mismatch)`)
    existing = null
  }

  const keywords: Record<string, string[][]> = {}
  if (existing !== null) {
    for (const [id, list] of Object.entries(existing.keywords)) {
      keywords[id] = list.map((arr) => (Array.isArray(arr) ? [...arr] : []))
    }
  }
  const finalSamples = Math.max(existing?.samples ?? 0, samples)

  console.log(
    `[expand-queries] source=${resolvedSource} model=${model} queries=${queries.length} samples=${samples} ` +
      `(existing sidecar samples=${existing?.samples ?? 0}) batch=${batchSize} concurrency=${concurrency}`,
  )

  const persist = (): void => {
    const sidecar: ExpansionSidecar = {
      source: resolvedSource,
      model,
      promptHash: PROMPT_HASH,
      generatedAt: new Date().toISOString(),
      samples: finalSamples,
      keywords,
    }
    writeSidecarAtomic(sidecar, resolvedOut)
  }

  let failures = 0
  let missingIdTotal = 0
  let batchesRun = 0

  // Samples are filled in index order (stage s only attempted for queries
  // whose stage s-1 is already filled), so keywords[id] on disk is always a
  // DENSE array - never holey - even when this run's batches complete out
  // of order across concurrency workers.
  for (let s = 0; s < samples; s++) {
    const pending = queries.filter((q) => {
      const slot = keywords[q.id]?.[s]
      if (slot !== undefined) return false // already filled
      if (s === 0) return true
      return keywords[q.id]?.[s - 1] !== undefined // dense-fill gate
    })

    if (pending.length === 0) {
      console.log(`[expand-queries] sample ${s + 1}/${samples}: nothing pending (already cached or gated)`)
      continue
    }

    const batches = chunk(pending, batchSize)
    console.log(`[expand-queries] sample ${s + 1}/${samples}: ${pending.length} query(ies) pending, ${batches.length} batch(es)`)

    await mapWithConcurrency(batches, concurrency, async (batch, i) => {
      const result = await runBatch(batch, model)
      batchesRun++
      if (!result.ok) {
        failures++
        console.error(`[expand-queries] sample ${s + 1}/${samples} batch ${i + 1}/${batches.length} FAILED: ${result.error}`)
        return result
      }
      for (const [id, list] of Object.entries(result.keywordsById)) {
        const arr = (keywords[id] ??= [])
        arr[s] = list
      }
      if (result.missingIds.length > 0) {
        missingIdTotal += result.missingIds.length
      }
      persist()
      console.log(`[expand-queries] sample ${s + 1}/${samples} batch ${i + 1}/${batches.length} ok (flushed to disk)`)
      return result
    })
  }

  persist()
  console.log(`[expand-queries] ${resolvedOut}: ${Object.keys(keywords).length} query id(s) with keywords`)

  if (failures > 0 || missingIdTotal > 0) {
    console.error(
      `[expand-queries] ${failures} batch(es) failed, ${missingIdTotal} slot(s) missing from responses - re-run to retry ` +
        `(idempotent, only failed/missing slots are pending)`,
    )
    process.exit(1)
    return
  }

  if (batchesRun === 0) {
    console.log(`[expand-queries] nothing to do - all requested (query, sample) slots already cached (use --force to regenerate)`)
  }
}

try {
  await main()
} catch (e) {
  console.error(`[expand-queries] runtime failure: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(3)
}
