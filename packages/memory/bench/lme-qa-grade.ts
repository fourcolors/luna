/**
 * LongMemEval end-to-end QA, grade stage: the official judge, so a score
 * here means what published LongMemEval QA accuracy means.
 *
 * Prompts, parameters and parsing are the official ones
 * (github.com/xiaowu0162/LongMemEval src/evaluation/evaluate_qa.py at
 * 9e0b455f; the prompts are byte-identical to its get_anscheck_prompt): one
 * template per question type plus the abstention template for ids ending
 * "_abs", temperature 0, max_tokens 10, n 1, and a response counts as
 * correct when "yes" appears anywhere in the judge's reply. Metrics follow
 * print_qa_metrics.py: Overall = mean over every question (abstention
 * included), Task-averaged = mean of the six per-type means, Abstention =
 * mean over "_abs" questions. A table is only a score when every one of the
 * 500 questions is graded; otherwise it is printed as INCOMPLETE.
 *
 * Graders: `gpt-4o` (gpt-4o-2024-08-06, the paper's judge; OPENAI_API_KEY)
 * and `grok-4.5` (the judge Mitosis reports with; XAI_API_KEY). Each is
 * probed once before grading, so a bad key or model fails in seconds.
 *
 * Usage:
 *   bun bench/lme-qa-grade.ts <hyp.jsonl> [<hyp.jsonl> ...]
 * Env: LUNA_QA_GRADERS (default "gpt-4o,grok-4.5"), LUNA_QA_GRADE_CONCURRENCY (default 8)
 * Writes next to each input:
 *   <hyp>.eval-results-<grader>.jsonl  the official log format (hypothesis
 *     entry plus autoeval_label { model, label }), with the judge's raw reply
 *     and finish reason; contains answer text, NOT for committing.
 *   <hyp>.labels-<grader>.jsonl  question_id + label only, for committing.
 * Rerunning resumes; a grade is redone when its answer text changed. An
 * empty or length-cut judge reply is a failure, never a "no".
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { signTestP } from "../src/adapters/longmemeval-eval/baselines.js"
import { fetchDataset, SPLIT_URLS } from "../src/adapters/longmemeval-eval/dataset.js"

const BASE =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no."

/** evaluate_qa.py get_anscheck_prompt, verbatim. */
export function anscheckPrompt(task: string, question: string, answer: string, response: string, abstention: boolean): string {
  if (abstention) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`
  }
  if (task === "single-session-user" || task === "single-session-assistant" || task === "multi-session") {
    return `${BASE} \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
  }
  if (task === "temporal-reasoning") {
    return `${BASE} In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
  }
  if (task === "knowledge-update") {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
  }
  if (task === "single-session-preference") {
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
  }
  throw new Error(`unknown question type ${task}`)
}

export const GRADERS: Readonly<Record<string, { readonly url: string; readonly model: string; readonly keyEnv: string }>> = {
  "gpt-4o": { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-2024-08-06", keyEnv: "OPENAI_API_KEY" },
  "grok-4.5": { url: "https://api.x.ai/v1/chat/completions", model: "grok-4.5", keyEnv: "XAI_API_KEY" },
}

/** The official parse, plus the two replies it would silently turn into "no". */
export function judgeLabel(content: string, finishReason: string | undefined): boolean {
  if (content.trim() === "") throw new Error("empty judge reply")
  if (finishReason === "length" && !content.toLowerCase().includes("yes")) throw new Error(`judge reply cut off: ${JSON.stringify(content)}`)
  return content.toLowerCase().includes("yes")
}

class FatalJudgeError extends Error {}

async function judgeOnce(grader: (typeof GRADERS)[string], key: string, prompt: string) {
  let last: unknown
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt))
    try {
      const res = await fetch(grader.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: grader.model, messages: [{ role: "user", content: prompt }], n: 1, temperature: 0, max_tokens: 10 }),
        signal: AbortSignal.timeout(120_000),
      })
      if (res.status === 429 || res.status >= 500) {
        last = new Error(`HTTP ${res.status}`)
        continue
      }
      const json = (await res.json()) as {
        model?: string
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>
        error?: unknown
      }
      // Any other 4xx (bad key, unknown model, bad request) will never succeed on retry.
      if (!res.ok) throw new FatalJudgeError(`HTTP ${res.status}: ${JSON.stringify(json.error).slice(0, 200)}`)
      const choice = json.choices?.[0]
      const content = choice?.message?.content ?? ""
      const label = judgeLabel(content, choice?.finish_reason)
      return { label, content: content.trim(), finishReason: choice?.finish_reason ?? "", model: json.model ?? grader.model }
    } catch (e) {
      if (e instanceof FatalJudgeError) throw e
      last = e
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

export interface QaRef {
  readonly questionType: string
  readonly abstention: boolean
}

const QUESTION_TYPES = [
  "single-session-user",
  "single-session-preference",
  "single-session-assistant",
  "multi-session",
  "temporal-reasoning",
  "knowledge-update",
] as const

/** print_qa_metrics.py: Overall (micro, abstention included), Task-averaged (mean of the six type means), Abstention. */
export function computeMetrics(labels: Readonly<Record<string, boolean>>, ref: ReadonlyMap<string, QaRef>) {
  const ids = [...ref.keys()]
  const missing = ids.filter((id) => !(id in labels))
  const mean = (xs: ReadonlyArray<boolean>) => (xs.length === 0 ? Number.NaN : xs.filter(Boolean).length / xs.length)
  const graded = ids.filter((id) => id in labels)
  const perType = Object.fromEntries(
    QUESTION_TYPES.map((t) => [t, mean(graded.filter((id) => ref.get(id)!.questionType === t).map((id) => labels[id]!))]),
  ) as Record<(typeof QUESTION_TYPES)[number], number>
  return {
    complete: missing.length === 0,
    graded: graded.length,
    total: ids.length,
    overall: mean(graded.map((id) => labels[id]!)),
    taskAveraged: QUESTION_TYPES.reduce((a, t) => a + perType[t], 0) / QUESTION_TYPES.length,
    abstention: mean(graded.filter((id) => ref.get(id)!.abstention).map((id) => labels[id]!)),
    perType,
  }
}

interface Hyp {
  readonly question_id: string
  readonly hypothesis: string
  readonly setup?: string
}

/** JSONL lines, skipping a trailing line cut short by a crash (it is simply redone). */
export const readJsonl = <T>(path: string): T[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T]
      } catch {
        return []
      }
    })

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16)

async function main(): Promise<void> {
  const files = process.argv.slice(2)
  if (files.length === 0) {
    console.error("usage: bun bench/lme-qa-grade.ts <hyp.jsonl> [...]")
    process.exit(4)
  }
  const graderNames = (process.env["LUNA_QA_GRADERS"] ?? "gpt-4o,grok-4.5").split(",").map((s) => s.trim())
  for (const g of graderNames) {
    if (GRADERS[g] === undefined) throw new Error(`unknown grader ${g}`)
    if (!process.env[GRADERS[g]!.keyEnv]?.trim()) throw new Error(`grader ${g} needs ${GRADERS[g]!.keyEnv}`)
    // Probe: a bad key or model id must fail now, not after hours of retries.
    const probe = await judgeOnce(GRADERS[g]!, process.env[GRADERS[g]!.keyEnv]!.trim(), anscheckPrompt("single-session-user", "What is my dog's name?", "Biscuit", "Your dog is Biscuit.", false))
    if (!probe.label) throw new Error(`grader ${g} failed its probe (said ${JSON.stringify(probe.content)} to an obviously correct answer)`)
    console.log(`# grader ${g}: probe ok (${probe.model})`)
  }
  const concurrency = Math.max(1, Number(process.env["LUNA_QA_GRADE_CONCURRENCY"] ?? 8) || 8)
  const { instances } = await fetchDataset(SPLIT_URLS.s)
  const byId = new Map(instances.map((i) => [i.question_id, i]))
  const ref = new Map<string, QaRef>(instances.map((i) => [i.question_id, { questionType: i.question_type, abstention: i.question_id.includes("_abs") }]))

  // labels[grader][setup][questionId]
  const labels: Record<string, Record<string, Record<string, boolean>>> = {}
  let failed = 0
  for (const file of files) {
    const hyps = readJsonl<Hyp>(file)
    const setup = hyps[0]?.setup ?? file
    for (const g of graderNames) {
      const grader = GRADERS[g]!
      const key = process.env[grader.keyEnv]!.trim()
      const out = `${file}.eval-results-${g}.jsonl`
      const hypHash = new Map(hyps.map((h) => [h.question_id, sha(h.hypothesis)]))
      const done = new Map<string, boolean>()
      if (existsSync(out)) {
        for (const e of readJsonl<Hyp & { autoeval_label: { label: boolean }; hypothesis_sha?: string }>(out)) {
          if (e.hypothesis_sha === hypHash.get(e.question_id)) done.set(e.question_id, e.autoeval_label.label)
        }
      }
      const todo = hyps.filter((h) => !done.has(h.question_id))
      console.log(`# ${setup} / ${g}: ${done.size} graded, ${todo.length} to go`)
      let next = 0
      let fatal: unknown
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          for (;;) {
            if (fatal !== undefined) return
            const h = todo[next++]
            if (h === undefined) return
            const inst = byId.get(h.question_id)
            if (inst === undefined) throw new Error(`${h.question_id} is not in LongMemEval S`)
            const prompt = anscheckPrompt(inst.question_type, inst.question, String(inst.answer), h.hypothesis, h.question_id.includes("_abs"))
            try {
              const r = await judgeOnce(grader, key, prompt)
              appendFileSync(
                out,
                JSON.stringify({
                  ...h,
                  hypothesis_sha: hypHash.get(h.question_id),
                  autoeval_label: { model: r.model, label: r.label },
                  judge_reply: r.content,
                  finish_reason: r.finishReason,
                }) + "\n",
              )
              done.set(h.question_id, r.label)
            } catch (e) {
              console.error(`[lme-qa-grade] ${setup} / ${g} ${h.question_id}: ${e instanceof Error ? e.message : String(e)}`)
              if (e instanceof FatalJudgeError) fatal = e
              failed++
            }
          }
        }),
      )
      if (fatal !== undefined) throw fatal
      labels[g] ??= {}
      labels[g][setup] = Object.fromEntries(done)
      writeFileSync(
        `${file}.labels-${g}.jsonl`,
        [...done].map(([id, label]) => JSON.stringify({ question_id: id, setup, grader: grader.model, label })).join("\n") + "\n",
      )
    }
  }

  const pct = (x: number) => (Number.isNaN(x) ? "-" : `${(x * 100).toFixed(1)}%`)
  for (const g of graderNames) {
    console.log(`\n## grader ${g} (${GRADERS[g]!.model})`)
    console.log(`| setup | graded | Overall | Task-averaged | Abstention | ${QUESTION_TYPES.join(" | ")} |`)
    console.log(`|:---|---:|---:|---:|---:|${QUESTION_TYPES.map(() => "---:").join("|")}|`)
    for (const [setup, byQ] of Object.entries(labels[g] ?? {})) {
      const m = computeMetrics(byQ, ref)
      const flag = m.complete ? "" : " INCOMPLETE - not a score"
      console.log(
        `| ${setup}${flag} | ${m.graded}/${m.total} | ${pct(m.overall)} | ${pct(m.taskAveraged)} | ${pct(m.abstention)} | ${QUESTION_TYPES.map((t) => pct(m.perType[t])).join(" | ")} |`,
      )
    }
    const setups = Object.keys(labels[g] ?? {})
    for (let i = 0; i < setups.length; i++) {
      for (let j = i + 1; j < setups.length; j++) {
        const a = labels[g]![setups[i]!]!
        const b = labels[g]![setups[j]!]!
        const both = Object.keys(a).filter((id) => id in b)
        const w = both.filter((id) => a[id] && !b[id]).length
        const l = both.filter((id) => !a[id] && b[id]).length
        console.log(`  ${setups[i]} vs ${setups[j]}: right only in first ${w}, only in second ${l}, sign p = ${signTestP(w, l).toPrecision(2)}`)
      }
    }
  }
  if (graderNames.length === 2) {
    const [g1, g2] = graderNames as [string, string]
    for (const setup of Object.keys(labels[g1] ?? {})) {
      const a = labels[g1]![setup]!
      const b = labels[g2]?.[setup] ?? {}
      const both = Object.keys(a).filter((id) => id in b)
      console.log(`  graders agree on ${both.filter((id) => a[id] === b[id]).length}/${both.length} for ${setup}`)
    }
  }
  if (failed > 0) {
    console.error(`[lme-qa-grade] ${failed} grades missing; rerun the same command to resume.`)
    process.exit(2)
  }
}

if (import.meta.main) await main()
