/**
 * LongMemEval end-to-end QA, answer stage: Claude answers every question
 * from retrieved memories, so the result can be graded like published
 * memory-system scores (bench/lme-qa-grade.ts in @luna/memory grades it
 * with the official LongMemEval judge prompts).
 *
 * Input: a LongMemEval sweep run with LUNA_LME_DUMP_TOP=1 (each config's
 * top-10 records per question, plus the question, its date and gold answer).
 * Every setup asks with the official LongMemEval reading prompt
 * (src/generation/run_generation.py at 9e0b455f, retrieval, no
 * chain-of-thought) and differs only in the history it shows:
 *
 *   luna-*      what Luna's per-turn recall would show: production
 *               packRecallContext (5 memories, 700 characters each, 3,000 in
 *               total), in rank order.
 *   official-*  the protocol's own format, for comparison with published
 *               numbers: the top 10 turns sorted by date, each as
 *               "### Session i: / Session Date: / Session Content:" with the
 *               turn as Python json.dumps({role, content}).
 *
 * Record ids are replaced by neutral names (m1, m2, ...): LongMemEval ids
 * mark unanswerable questions ("_abs") and the dataset's temporal questions
 * ("gpt4_"), and the answer model must not see either.
 *
 * The model runs through the Agent SDK on the Claude subscription with
 * thinking disabled (the official reader has no chain-of-thought), isolated
 * like bench/isolated-claude.ts: no setting sources, tools, MCP servers or
 * session persistence, a fresh empty working directory. On the subscription
 * the CLI still injects the real current date and the account email into
 * every call; a probe showed Sonnet then answers "What is today's date?"
 * with the real date despite "Current Date: 2023/..." in the prompt, and
 * with the system instruction below it uses the prompt's date. Answers that
 * mention the real current year are counted and reported. Answer texts can
 * contain the injected email: NOT for committing (commit graded labels only).
 *
 * Usage:
 *   bun bench/lme-qa-answer.ts <sweep-dump.json> <out-dir>
 * Env:
 *   LUNA_QA_MODEL        default "claude-sonnet-5"
 *   LUNA_QA_SETUPS       comma-separated subset of the setups below (default: all)
 *   LUNA_QA_CONCURRENCY  parallel calls (default 3)
 * Writes <out-dir>/hyp-<setup>.jsonl ({ question_id, hypothesis, ... } per
 * line, the official hypothesis format plus provenance). Rerunning resumes:
 * an answer is reused only when its prompt is unchanged. Exits 2 when a
 * question still fails after all attempts (rerun to resume).
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { makeRecord } from "@luna/memory"
import { DEFAULT_RECALL_CONTEXT_OPTIONS, packRecallContext } from "@luna/memory-tools"

interface DumpRecord {
  readonly id: string
  readonly text: string
  readonly updatedAt: number
}

export interface DumpQuestion {
  readonly questionId: string
  readonly questionType: string
  readonly qa?: { readonly question: string; readonly questionDate: string; readonly answer: string }
  readonly perConfig: Readonly<Record<string, { readonly top?: ReadonlyArray<DumpRecord> }>>
}

export interface Setup {
  readonly name: string
  readonly config: string
  readonly format: "luna" | "official"
}

export const SETUPS: ReadonlyArray<Setup> = [
  { name: "luna-today", config: "hybrid", format: "luna" },
  { name: "luna-jev", config: "hybrid:rr=jev@40", format: "luna" },
  { name: "official-today", config: "hybrid", format: "official" },
  { name: "official-jev", config: "hybrid:rr=jev@40", format: "official" },
]

/** The official LongMemEval retrieval reading prompt (no chain-of-thought). */
export function answerPrompt(history: string, questionDate: string, question: string): string {
  return `I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.


History Chats:

${history}

Current Date: ${questionDate}
Question: ${question}
Answer:`
}

/** "[2023/05/20 (Sat) 02:21] user: text" (longmemeval-eval ingest's record text) back into its parts. */
export function parseTurn(text: string): { date: string; role: string; content: string } {
  const m = /^\[([^\]]+)\] (user|assistant): ([\s\S]*)$/.exec(text)
  if (!m) throw new Error(`not a LongMemEval turn record: ${text.slice(0, 60)}`)
  return { date: m[1]!, role: m[2]!, content: m[3]! }
}

/** Python json.dumps (default separators, ensure_ascii) of a flat string map, as the official reader writes each turn. */
export function pyJsonDumps(obj: Readonly<Record<string, string>>): string {
  const str = (s: string) => JSON.stringify(s).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
  return `{${Object.entries(obj).map(([k, v]) => `${str(k)}: ${str(v)}`).join(", ")}}`
}

function top(q: DumpQuestion, setup: Setup): ReadonlyArray<DumpRecord> {
  const t = q.perConfig[setup.config]?.top
  if (t === undefined) throw new Error(`${q.questionId}: dump has no top records for ${setup.config} (run the sweep with LUNA_LME_DUMP_TOP=1)`)
  return t
}

/** The history block one setup shows for one question. */
export function history(q: DumpQuestion, setup: Setup): string {
  const records = top(q, setup)
  if (setup.format === "luna") {
    const ranked = records.map((r, i) => ({
      record: makeRecord({ id: `m${i + 1}`, namespace: "longmemeval", kind: "episodic", content: { text: r.text }, now: r.updatedAt }),
      score: records.length - i,
    }))
    return packRecallContext(ranked, DEFAULT_RECALL_CONTEXT_OPTIONS)?.text ?? ""
  }
  // run_generation.py: sort retrieved chunks by their date string (stable), then wrap each.
  const turns = records.map((r) => parseTurn(r.text)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return turns
    .map((t, i) => `\n### Session ${i + 1}:\nSession Date: ${t.date}\nSession Content:\n\n${pyJsonDumps({ role: t.role, content: t.content })}\n`)
    .join("")
}

const SYSTEM =
  'You are a helpful assistant that remembers past conversations with the user. The chat history you are given is from the past. Treat the "Current Date" stated in the user\'s message as today\'s date; ignore any other date you may have been told.'

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16)

async function answerOnce(prompt: string, model: string, cwd: string, timeoutMs: number) {
  const options: Options = {
    model,
    thinking: { type: "disabled" },
    systemPrompt: SYSTEM,
    settingSources: [],
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    persistSession: false,
    maxTurns: 1,
    cwd,
  }
  const q = query({ prompt, options })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no result after ${timeoutMs} ms`)), timeoutMs)
  })
  const drain = (async () => {
    for await (const m of q as AsyncIterable<SDKMessage>) {
      if (m.type !== "result") continue
      if (m.subtype !== "success") throw new Error(`result ${m.subtype}`)
      if (m.is_error) throw new Error(`result is_error: ${m.result.slice(0, 120)}`)
      const text = m.result.trim()
      if (text === "") throw new Error("empty answer")
      const servedModels = Object.keys(m.modelUsage ?? {})
      if (!servedModels.some((s) => s.startsWith(model))) throw new Error(`answer not from ${model} (served: ${servedModels.join(",")})`)
      return { text, servedModels }
    }
    throw new Error("stream ended without a result")
  })()
  drain.catch(() => {})
  try {
    return await Promise.race([drain, timeout])
  } finally {
    clearTimeout(timer)
    q.close()
  }
}

/** Pauses before retries 1..5: short for transient errors, long enough to outlast a usage-limit window. */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000]

async function main(): Promise<void> {
  const [dumpPath, outDirArg] = process.argv.slice(2)
  if (dumpPath === undefined || outDirArg === undefined) {
    console.error("usage: bun bench/lme-qa-answer.ts <sweep-dump.json> <out-dir>")
    process.exit(4)
  }
  const outDir = resolve(outDirArg)
  mkdirSync(outDir, { recursive: true })
  const model = process.env["LUNA_QA_MODEL"]?.trim() || "claude-sonnet-5"
  const concurrency = Math.max(1, Number(process.env["LUNA_QA_CONCURRENCY"] ?? 3) || 3)
  const wanted = process.env["LUNA_QA_SETUPS"]?.split(",").map((s) => s.trim()).filter(Boolean)
  const setups = wanted === undefined ? SETUPS : SETUPS.filter((s) => wanted.includes(s.name))
  if (wanted !== undefined && setups.length !== wanted.length) {
    console.error(`unknown setup in LUNA_QA_SETUPS (known: ${SETUPS.map((s) => s.name).join(", ")})`)
    process.exit(4)
  }

  const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as { questions: ReadonlyArray<DumpQuestion> }
  const prompts = new Map<string, string>()
  for (const q of dump.questions) {
    if (q.qa === undefined) throw new Error(`${q.questionId}: dump has no question text (run the sweep with LUNA_LME_DUMP_TOP=1)`)
    for (const s of setups) {
      const p = answerPrompt(history(q, s), q.qa.questionDate, q.qa.question) // fail before any model call
      if (p.includes(q.questionId) || /_abs\b/.test(p)) throw new Error(`${q.questionId}: prompt would leak the question id`)
      prompts.set(`${s.name}\u0000${q.questionId}`, p)
    }
  }
  const realYear = String(new Date().getUTCFullYear())

  const cwd = mkdtempSync(join(tmpdir(), "luna-lme-qa-"))
  let failed = 0
  try {
    for (const setup of setups) {
      const out = join(outDir, `hyp-${setup.name}.jsonl`)
      const done = new Set<string>()
      if (existsSync(out)) {
        for (const line of readFileSync(out, "utf8").split("\n")) {
          try {
            const e = JSON.parse(line) as { question_id: string; prompt_sha?: string }
            if (e.prompt_sha === sha(prompts.get(`${setup.name}\u0000${e.question_id}`) ?? "")) done.add(e.question_id)
          } catch {
            // blank or crash-truncated line: that question is simply redone
          }
        }
      }
      const todo = dump.questions.filter((q) => !done.has(q.questionId))
      console.log(`# ${setup.name}: ${done.size} already answered, ${todo.length} to go (model ${model}, concurrency ${concurrency})`)
      let next = 0
      let finished = 0
      let mentionsRealYear = 0
      const worker = async () => {
        for (;;) {
          const q = todo[next++]
          if (q === undefined) return
          const prompt = prompts.get(`${setup.name}\u0000${q.questionId}`)!
          const t0 = performance.now()
          for (let attempt = 1; ; attempt++) {
            try {
              const r = await answerOnce(prompt, model, cwd, 180_000)
              if (r.text.includes(realYear)) mentionsRealYear++
              appendFileSync(
                out,
                JSON.stringify({
                  question_id: q.questionId,
                  hypothesis: r.text,
                  setup: setup.name,
                  model: r.servedModels.join(","),
                  thinking: "disabled",
                  prompt_sha: sha(prompt),
                  promptChars: prompt.length,
                  attempts: attempt,
                  ms: Math.round(performance.now() - t0),
                }) + "\n",
              )
              break
            } catch (e) {
              const delay = RETRY_DELAYS_MS[attempt - 1]
              if (delay === undefined) {
                console.error(`[lme-qa] ${setup.name} ${q.questionId}: failed after ${attempt} attempts: ${e instanceof Error ? e.message : String(e)}`)
                failed++
                break
              }
              console.error(`[lme-qa] ${setup.name} ${q.questionId}: attempt ${attempt} failed, retrying in ${delay / 1000} s: ${e instanceof Error ? e.message : String(e)}`)
              await new Promise((r) => setTimeout(r, delay))
            }
          }
          if (++finished % 25 === 0) console.log(`# ${setup.name}: ${finished}/${todo.length}`)
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker))
      console.log(`# ${setup.name}: ${mentionsRealYear} new answers mention ${realYear} (the injected real date would show up here)`)
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
  if (failed > 0) {
    console.error(`[lme-qa] ${failed} answers missing; rerun the same command to resume.`)
    process.exit(2)
  }
  console.log("# all answers written")
}

if (import.meta.main) await main()
