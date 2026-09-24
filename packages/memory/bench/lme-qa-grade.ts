/**
 * LongMemEval end-to-end QA, grade stage: the official judge, so a score
 * here means what published LongMemEval QA accuracy means.
 *
 * Prompts, parameters and parsing are the official ones
 * (github.com/xiaowu0162/LongMemEval src/evaluation/evaluate_qa.py at
 * 9e0b455f): one template per question type plus the abstention template
 * for ids ending "_abs", temperature 0, max_tokens 10, n 1, and a response
 * counts as correct when "yes" appears anywhere in the judge's reply.
 * Metrics follow print_qa_metrics.py: Overall = mean over every question
 * (abstention included), Task-averaged = mean of the six per-type means,
 * Abstention = mean over "_abs" questions.
 *
 * Graders: `gpt-4o` (gpt-4o-2024-08-06, the paper's judge; OPENAI_API_KEY)
 * and `grok-4.5` (the judge Mitosis reports with; XAI_API_KEY).
 *
 * Usage:
 *   bun bench/lme-qa-grade.ts <hyp.jsonl> [<hyp.jsonl> ...]
 * Env: LUNA_QA_GRADERS (default "gpt-4o,grok-4.5"), LUNA_QA_GRADE_CONCURRENCY (default 8)
 * Writes <hyp>.eval-results-<grader>.jsonl next to each input (the official
 * log format: the hypothesis entry plus autoeval_label { model, label });
 * rerunning resumes. Prints the metrics and, when several setups are given,
 * paired correct / wrong counts between them with an exact sign test.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs"
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

async function judgeOnce(grader: (typeof GRADERS)[string], key: string, prompt: string): Promise<{ content: string; model: string }> {
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
      const json = (await res.json()) as { model?: string; choices?: Array<{ message?: { content?: string | null } }>; error?: unknown }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json.error).slice(0, 200)}`)
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== "string") throw new Error("judge reply has no content")
      return { content: content.trim(), model: json.model ?? grader.model }
    } catch (e) {
      last = e
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

interface Hyp {
  readonly question_id: string
  readonly hypothesis: string
  readonly setup?: string
}

const readJsonl = <T>(path: string): T[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T)

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
  }
  const concurrency = Math.max(1, Number(process.env["LUNA_QA_GRADE_CONCURRENCY"] ?? 8) || 8)
  const { instances } = await fetchDataset(SPLIT_URLS.s)
  const ref = new Map(instances.map((i) => [i.question_id, i]))

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
      const done = new Map<string, boolean>()
      if (existsSync(out)) for (const e of readJsonl<Hyp & { autoeval_label: { label: boolean } }>(out)) done.set(e.question_id, e.autoeval_label.label)
      const todo = hyps.filter((h) => !done.has(h.question_id))
      console.log(`# ${setup} / ${g}: ${done.size} graded, ${todo.length} to go`)
      let next = 0
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          for (;;) {
            const h = todo[next++]
            if (h === undefined) return
            const inst = ref.get(h.question_id)
            if (inst === undefined) throw new Error(`${h.question_id} is not in LongMemEval S`)
            const prompt = anscheckPrompt(inst.question_type, inst.question, String(inst.answer), h.hypothesis, h.question_id.includes("_abs"))
            try {
              const r = await judgeOnce(grader, key, prompt)
              const label = r.content.toLowerCase().includes("yes")
              appendFileSync(out, JSON.stringify({ ...h, autoeval_label: { model: r.model, label } }) + "\n")
              done.set(h.question_id, label)
            } catch (e) {
              console.error(`[lme-qa-grade] ${setup} / ${g} ${h.question_id}: ${e instanceof Error ? e.message : String(e)}`)
              failed++
            }
          }
        }),
      )
      ;((labels[g] ??= {})[setup] = Object.fromEntries(done))
    }
  }

  const types = ["single-session-user", "single-session-preference", "single-session-assistant", "multi-session", "temporal-reasoning", "knowledge-update"]
  const mean = (xs: ReadonlyArray<boolean>) => (xs.length === 0 ? Number.NaN : xs.filter(Boolean).length / xs.length)
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  for (const g of graderNames) {
    console.log(`\n## grader ${g} (${GRADERS[g]!.model})`)
    console.log(`| setup | graded | Overall | Task-averaged | Abstention | ${types.join(" | ")} |`)
    console.log(`|:---|---:|---:|---:|---:|${types.map(() => "---:").join("|")}|`)
    for (const [setup, byQ] of Object.entries(labels[g] ?? {})) {
      const ids = Object.keys(byQ)
      const perType = types.map((t) => mean(ids.filter((id) => ref.get(id)!.question_type === t).map((id) => byQ[id]!)))
      const overall = mean(ids.map((id) => byQ[id]!))
      const abst = mean(ids.filter((id) => id.includes("_abs")).map((id) => byQ[id]!))
      console.log(`| ${setup} | ${ids.length} | ${pct(overall)} | ${pct(perType.reduce((a, b) => a + b, 0) / types.length)} | ${pct(abst)} | ${perType.map(pct).join(" | ")} |`)
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
