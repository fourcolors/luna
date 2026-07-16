/**
 * bulletin-eval.ts - eval harness for the HOT-TIER bulletin (see BULLETIN.md).
 *
 * Ships BEFORE any bulletin generator exists (eval-first). Measures how well
 * an answering model handles cross-thread "observational" questions under
 * three conditions:
 *
 *   none      - no digest injected (today's production behavior; the floor)
 *   oracle    - the fixture's hand-written ideal digest (the ceiling)
 *   generated - a digest read from LUNA_BULLETIN_FILE (how a future
 *               generator plugs in unchanged; only run when the env is set)
 *
 * Scoring is deterministic keyword matching over the model's answer under a
 * strict protocol: the model must reply exactly NO-RECORD when it has no
 * information. Every probe runs N samples (default 3) because LLM answers
 * vary run to run; there is deliberately NO response cache - a cached replay
 * is one draw pretending to be a distribution.
 *
 * Env:
 *   LUNA_BULLETIN_MODEL        claude CLI model alias (default "haiku")
 *   LUNA_BULLETIN_SAMPLES      samples per probe per condition (default 3)
 *   LUNA_BULLETIN_CONCURRENCY  parallel claude calls (default 6)
 *   LUNA_BULLETIN_FILE         path to a generated digest to evaluate
 *
 * Exit codes: 0 ok; 3 config/fixture error; 5 claude CLI unavailable.
 *
 * The claude CLI plumbing mirrors rerank-eval.ts deliberately (neutral cwd,
 * json output, tool lockdown, EPIPE guard); it is duplicated rather than
 * extracted so this new harness cannot destabilize the validated rerank
 * artifact generator.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Probe {
  readonly id: string
  readonly category: string
  readonly question: string
  readonly requiredKeywords: ReadonlyArray<string>
  readonly forbiddenKeywords: ReadonlyArray<string>
}

interface Fixture {
  readonly meta: { readonly nowIso: string }
  readonly threads: ReadonlyArray<{ readonly id: string; readonly status: string }>
  readonly oracleBulletin: string
  readonly probes: ReadonlyArray<Probe>
}

const BENCH_DIR = dirname(fileURLToPath(import.meta.url))

function loadFixture(): Fixture {
  const path = resolve(BENCH_DIR, "bulletin-fixture.json")
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    console.error(`[bulletin] cannot read fixture at ${path}: ${String(e)}`)
    process.exit(3)
  }
  const f = raw as Fixture
  if (typeof f.meta?.nowIso !== "string" || typeof f.oracleBulletin !== "string" || !Array.isArray(f.probes)) {
    console.error("[bulletin] fixture missing meta.nowIso / oracleBulletin / probes")
    process.exit(3)
  }
  for (const [i, p] of f.probes.entries()) {
    if (
      typeof p.id !== "string" ||
      typeof p.category !== "string" ||
      typeof p.question !== "string" ||
      !Array.isArray(p.requiredKeywords) ||
      !Array.isArray(p.forbiddenKeywords)
    ) {
      console.error(`[bulletin] probes[${i}] is malformed`)
      process.exit(3)
    }
  }
  return f
}

// ---------------------------------------------------------------------------
// claude CLI plumbing (mirrors rerank-eval.ts; see header for why duplicated)
// ---------------------------------------------------------------------------

const MODEL = process.env["LUNA_BULLETIN_MODEL"] ?? "haiku"
const SAMPLES = resolvePositiveInt("LUNA_BULLETIN_SAMPLES", 3)
const CONCURRENCY = resolvePositiveInt("LUNA_BULLETIN_CONCURRENCY", 6)
const CLAUDE_DISALLOWED_TOOLS = "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task"
const CALL_TIMEOUT_MS = 45_000
const RETRY_ATTEMPTS = 2

function resolvePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) {
    console.error(`[bulletin] invalid ${name} "${raw}" - must be a finite number >= 1`)
    process.exit(3)
  }
  return Math.trunc(n)
}

const NEUTRAL_CWD = resolve(tmpdir(), "luna-bulletin-eval-cwd")
if (!existsSync(NEUTRAL_CWD)) mkdirSync(NEUTRAL_CWD, { recursive: true })

function callClaudeOnce(prompt: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--model",
        MODEL,
        "--output-format",
        "json",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--disallowedTools",
        CLAUDE_DISALLOWED_TOOLS,
      ],
      { cwd: NEUTRAL_CWD, stdio: ["pipe", "pipe", "pipe"] },
    )
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
    child.stdin.on("error", () => {})
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown> | ReadonlyArray<Record<string, unknown>>
        const events = Array.isArray(parsed) ? parsed : [parsed]
        const resultEvent = [...events].reverse().find((e) => e["type"] === "result")
        if (resultEvent === undefined || resultEvent["is_error"] === true) {
          reject(new Error(`claude returned no usable result: ${stdout.slice(0, 200)}`))
          return
        }
        resolvePromise(String(resultEvent["result"] ?? ""))
      } catch (e) {
        reject(new Error(`claude output parse failure: ${String(e)}`))
      }
    })
    child.stdin.end(prompt)
  })
}

async function callClaude(prompt: string): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await callClaudeOnce(prompt)
    } catch (e) {
      lastError = e
      await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)))
    }
  }
  throw lastError
}

async function mapLimit<T, R>(items: ReadonlyArray<T>, limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i]!)
      }
    }),
  )
  return results
}

// ---------------------------------------------------------------------------
// Prompt + scoring
// ---------------------------------------------------------------------------

function buildPrompt(nowIso: string, digest: string | null, question: string): string {
  const digestBlock =
    digest === null
      ? ""
      : `Here is your digest of recent activity across all of the team's conversation threads:\n\n---\n${digest}\n---\n\n`
  return (
    `You are the assistant for a small product team. The current time is ${nowIso}.\n\n` +
    digestBlock +
    `Answer the question below in 1-3 short sentences, using ONLY information you actually have` +
    (digest === null ? "" : " from the digest above") +
    `. Do not guess or invent details.\n` +
    `If you have no information about what is being asked, reply with exactly: NO-RECORD\n\n` +
    `Question: ${question}`
  )
}

function scoreAnswer(probe: Probe, answer: string): boolean {
  const a = answer.toLowerCase()
  for (const kw of probe.requiredKeywords) {
    if (!a.includes(kw.toLowerCase())) return false
  }
  for (const kw of probe.forbiddenKeywords) {
    if (a.includes(kw.toLowerCase())) return false
  }
  return true
}

const estimateTokens = (s: string): number => Math.round(s.length / 4)

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface ProbeResult {
  readonly probeId: string
  readonly category: string
  readonly answers: ReadonlyArray<string>
  readonly correctVotes: number
  readonly correct: boolean
  readonly flipped: boolean
}

async function runCondition(
  name: string,
  digest: string | null,
  fixture: Fixture,
): Promise<{ name: string; results: ProbeResult[] }> {
  const calls = fixture.probes.flatMap((probe) =>
    Array.from({ length: SAMPLES }, (_, sample) => ({ probe, sample })),
  )
  const answers = await mapLimit(calls, CONCURRENCY, async ({ probe }) =>
    callClaude(buildPrompt(fixture.meta.nowIso, digest, probe.question)),
  )
  const results: ProbeResult[] = fixture.probes.map((probe, pi) => {
    const probeAnswers = answers.slice(pi * SAMPLES, (pi + 1) * SAMPLES)
    const votes = probeAnswers.filter((a) => scoreAnswer(probe, a)).length
    return {
      probeId: probe.id,
      category: probe.category,
      answers: probeAnswers,
      correctVotes: votes,
      // Majority vote across samples is the headline call; flips are surfaced
      // separately so variance is visible instead of averaged away.
      correct: votes * 2 > SAMPLES,
      flipped: votes !== 0 && votes !== SAMPLES,
    }
  })
  return { name, results }
}

function accuracy(results: ReadonlyArray<ProbeResult>, category?: string): string {
  const pool = category === undefined ? results : results.filter((r) => r.category === category)
  if (pool.length === 0) return "-"
  const ok = pool.filter((r) => r.correct).length
  return `${ok}/${pool.length}`
}

function accuracyRate(results: ReadonlyArray<ProbeResult>): number {
  return results.filter((r) => r.correct).length / results.length
}

async function main(): Promise<void> {
  const probe = spawnSync("claude", ["--version"], { stdio: "ignore" })
  if (probe.error !== undefined || probe.status !== 0) {
    console.error("[bulletin] claude CLI unavailable - install/authenticate it first")
    process.exit(5)
  }

  const fixture = loadFixture()
  const generatedPath = process.env["LUNA_BULLETIN_FILE"]
  const generated = generatedPath !== undefined && generatedPath !== "" ? readFileSync(generatedPath, "utf8") : null

  console.log(
    `[bulletin] model=${MODEL} samples=${SAMPLES} probes=${fixture.probes.length} ` +
      `oracle=${estimateTokens(fixture.oracleBulletin)}tok` +
      (generated !== null ? ` generated=${estimateTokens(generated)}tok` : ""),
  )
  if (generated !== null && estimateTokens(generated) > 1_500) {
    console.log(`[bulletin] WARNING: generated digest exceeds the 1,500-token hard cap (BULLETIN.md)`)
  }

  const conditions: Array<{ name: string; digest: string | null }> = [
    { name: "none", digest: null },
    { name: "oracle", digest: fixture.oracleBulletin },
    ...(generated !== null ? [{ name: "generated", digest: generated }] : []),
  ]

  const runs: Array<{ name: string; results: ProbeResult[] }> = []
  for (const c of conditions) {
    console.log(`[bulletin] running condition "${c.name}" (${fixture.probes.length * SAMPLES} calls)...`)
    runs.push(await runCondition(c.name, c.digest, fixture))
  }

  const categories = [...new Set(fixture.probes.map((p) => p.category))]
  console.log(`\n## bulletin eval (majority vote over ${SAMPLES} samples)\n`)
  console.log(`| condition | overall | ${categories.join(" | ")} | flipped probes |`)
  console.log(`|---|---:|${categories.map(() => "---:").join("|")}|---:|`)
  for (const run of runs) {
    const flips = run.results.filter((r) => r.flipped).length
    console.log(
      `| ${run.name} | ${accuracy(run.results)} | ` +
        categories.map((c) => accuracy(run.results, c)).join(" | ") +
        ` | ${flips} |`,
    )
  }

  const none = runs.find((r) => r.name === "none")!
  const oracle = runs.find((r) => r.name === "oracle")!
  const gap = accuracyRate(oracle.results) - accuracyRate(none.results)
  console.log(`\noracle-vs-none gap: ${(gap * 100).toFixed(1)} points`)
  if (gap <= 0.2) {
    console.log("VERDICT: oracle does not decisively beat none - fix the probes before building any mechanism")
  } else {
    console.log("VERDICT: probes discriminate - a generator must close >=70% of this gap to ship (BULLETIN.md)")
  }
  const gen = runs.find((r) => r.name === "generated")
  if (gen !== undefined) {
    const closed = gap > 0 ? (accuracyRate(gen.results) - accuracyRate(none.results)) / gap : 0
    console.log(`generated closes ${(closed * 100).toFixed(1)}% of the gap`)
  }

  const outPath = resolve(BENCH_DIR, `bulletin-baseline-${new Date().toISOString().slice(0, 10)}.json`)
  writeFileSync(
    outPath,
    JSON.stringify({ model: MODEL, samples: SAMPLES, at: new Date().toISOString(), runs }, null, 2),
  )
  console.log(`\nraw answers written to ${outPath}`)
}

await main()
