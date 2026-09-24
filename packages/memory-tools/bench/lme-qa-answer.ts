/**
 * LongMemEval end-to-end QA, answer stage: Claude answers every question
 * from the memories Luna would put in front of it, so the result can be
 * graded like published memory-system scores (bench/lme-qa-grade.ts in
 * @luna/memory grades it with the official LongMemEval judge prompts).
 *
 * Input: a LongMemEval sweep run with LUNA_LME_DUMP_TOP=1 (each config's
 * top-10 records per question, plus the question, its date and gold answer).
 * Each setup packs one config's ranking with Luna's production
 * packRecallContext (per-turn recall: 5 memories, 700 characters each, 3,000
 * in total) or a wider budget, and asks with the official LongMemEval
 * reading prompt (src/generation/run_generation.py, retrieval, no
 * chain-of-thought): "I will give you several history chats ... Current
 * Date: ... Question: ... Answer:".
 *
 * The model runs through the Agent SDK on the Claude subscription with the
 * default thinking of the model, isolated like bench/isolated-claude.ts: no
 * setting sources, tools, MCP servers or session persistence, a fresh empty
 * working directory. The CLI still injects the account email into every
 * call, so answer texts are NOT for committing (commit graded labels only).
 *
 * Usage:
 *   bun bench/lme-qa-answer.ts <sweep-dump.json> <out-dir>
 * Env:
 *   LUNA_QA_MODEL        default "sonnet"
 *   LUNA_QA_SETUPS       comma-separated subset of the setups below (default: all)
 *   LUNA_QA_CONCURRENCY  parallel calls (default 3)
 * Writes <out-dir>/hyp-<setup>.jsonl ({ question_id, hypothesis, ... } per
 * line, the official hypothesis format plus timing). Rerunning resumes: a
 * question already answered for a setup is skipped. Exits 2 when a question
 * still fails after 3 attempts (the run is incomplete; rerun to resume).
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { makeRecord } from "@luna/memory"
import { DEFAULT_RECALL_CONTEXT_OPTIONS, packRecallContext, type RecallContextOptions } from "@luna/memory-tools"

interface DumpQuestion {
  readonly questionId: string
  readonly questionType: string
  readonly qa?: { readonly question: string; readonly questionDate: string; readonly answer: string }
  readonly perConfig: Readonly<
    Record<string, { readonly top?: ReadonlyArray<{ readonly id: string; readonly text: string; readonly updatedAt: number }> }>
  >
}

export interface Setup {
  readonly name: string
  readonly config: string
  readonly packing: RecallContextOptions
}

export const SETUPS: ReadonlyArray<Setup> = [
  { name: "luna-today", config: "hybrid", packing: DEFAULT_RECALL_CONTEXT_OPTIONS },
  { name: "luna-jev", config: "hybrid:rr=jev@40", packing: DEFAULT_RECALL_CONTEXT_OPTIONS },
  { name: "luna-jev-wide", config: "hybrid:rr=jev@40", packing: { maxHits: 10, maxRecordChars: 2_000, maxTotalChars: 20_000 } },
]

/** The official LongMemEval retrieval reading prompt (no chain-of-thought), with Luna's packed memories as the history. */
export function answerPrompt(history: string, questionDate: string, question: string): string {
  return `I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.


History Chats:

${history}

Current Date: ${questionDate}
Question: ${question}
Answer:`
}

/** Luna's packed recall block for one config's ranking; "" when nothing survives packing. */
export function packedHistory(q: DumpQuestion, setup: Setup): string {
  const top = q.perConfig[setup.config]?.top
  if (top === undefined) throw new Error(`${q.questionId}: dump has no top records for ${setup.config} (run the sweep with LUNA_LME_DUMP_TOP=1)`)
  const ranked = top.map((t, i) => ({
    record: makeRecord({ id: t.id, namespace: "longmemeval", kind: "episodic", content: { text: t.text }, now: t.updatedAt }),
    score: top.length - i,
  }))
  return packRecallContext(ranked, setup.packing)?.text ?? ""
}

const SYSTEM = "You are a helpful assistant that remembers past conversations with the user."

async function answerOnce(prompt: string, model: string, cwd: string, timeoutMs: number) {
  const options: Options = {
    model,
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
      if (m.subtype !== "success" || m.is_error) throw new Error(`result ${m.subtype}${m.is_error ? " (is_error)" : ""}`)
      return { text: m.result.trim(), servedModel: Object.keys(m.modelUsage ?? {}).join(",") }
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

async function main(): Promise<void> {
  const [dumpPath, outDirArg] = process.argv.slice(2)
  if (dumpPath === undefined || outDirArg === undefined) {
    console.error("usage: bun bench/lme-qa-answer.ts <sweep-dump.json> <out-dir>")
    process.exit(4)
  }
  const outDir = resolve(outDirArg)
  mkdirSync(outDir, { recursive: true })
  const model = process.env["LUNA_QA_MODEL"]?.trim() || "sonnet"
  const concurrency = Math.max(1, Number(process.env["LUNA_QA_CONCURRENCY"] ?? 3) || 3)
  const wanted = process.env["LUNA_QA_SETUPS"]?.split(",").map((s) => s.trim()).filter(Boolean)
  const setups = wanted === undefined ? SETUPS : SETUPS.filter((s) => wanted.includes(s.name))
  if (wanted !== undefined && setups.length !== wanted.length) {
    console.error(`unknown setup in LUNA_QA_SETUPS (known: ${SETUPS.map((s) => s.name).join(", ")})`)
    process.exit(4)
  }

  const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as { questions: ReadonlyArray<DumpQuestion> }
  for (const q of dump.questions) {
    if (q.qa === undefined) throw new Error(`${q.questionId}: dump has no question text (run the sweep with LUNA_LME_DUMP_TOP=1)`)
    for (const s of setups) packedHistory(q, s) // fail before any model call, not halfway through
  }

  const cwd = mkdtempSync(join(tmpdir(), "luna-lme-qa-"))
  let failed = 0
  try {
    for (const setup of setups) {
      const out = join(outDir, `hyp-${setup.name}.jsonl`)
      const done = new Set<string>()
      if (existsSync(out)) {
        for (const line of readFileSync(out, "utf8").split("\n")) if (line.trim() !== "") done.add((JSON.parse(line) as { question_id: string }).question_id)
      }
      const todo = dump.questions.filter((q) => !done.has(q.questionId))
      console.log(`# ${setup.name}: ${done.size} already answered, ${todo.length} to go (model ${model}, concurrency ${concurrency})`)
      let next = 0
      let finished = 0
      const worker = async () => {
        for (;;) {
          const q = todo[next++]
          if (q === undefined) return
          const prompt = answerPrompt(packedHistory(q, setup), q.qa!.questionDate, q.qa!.question)
          const t0 = performance.now()
          for (let attempt = 1; ; attempt++) {
            try {
              const r = await answerOnce(prompt, model, cwd, 180_000)
              appendFileSync(
                out,
                JSON.stringify({
                  question_id: q.questionId,
                  hypothesis: r.text,
                  setup: setup.name,
                  model: r.servedModel,
                  attempts: attempt,
                  ms: Math.round(performance.now() - t0),
                  promptChars: prompt.length,
                }) + "\n",
              )
              break
            } catch (e) {
              if (attempt >= 3) {
                console.error(`[lme-qa] ${setup.name} ${q.questionId}: failed after 3 attempts: ${e instanceof Error ? e.message : String(e)}`)
                failed++
                break
              }
              await new Promise((r) => setTimeout(r, attempt * 5_000))
            }
          }
          if (++finished % 25 === 0) console.log(`# ${setup.name}: ${finished}/${todo.length}`)
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker))
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
