/**
 * bulletin-generate.ts - run the PRODUCTION bulletin composition over the
 * eval fixture and write the resulting digest to a file, so the merged
 * decision gate can judge the real generator:
 *
 *   bun packages/memory/bench/bulletin-generate.ts            # writes bulletin-generated.txt
 *   LUNA_BULLETIN_FILE=packages/memory/bench/bulletin-generated.txt \
 *     bun packages/memory/bench/bulletin-eval.ts              # DECISION GATE: PASS/FAIL
 *
 * The prompt comes from @luna/core's composeBulletinPrompt +
 * shapeActivitySnapshot - the EXACT code path the chat-server holder uses -
 * so the gate verdict transfers to production. Eligibility mirrors
 * production: archived threads are excluded (chat.listThreads(active) in
 * production; status !== "archived" here). The writer model is the claude
 * CLI (default haiku via LUNA_BULLETIN_MODEL), the same model alias the
 * SDK-backed production writer defaults to.
 *
 * Exit codes: 0 ok; 3 fixture/config error; 5 claude CLI unavailable.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  composeBulletinPrompt,
  shapeActivitySnapshot,
  estimateBulletinTokens,
  bulletinWithinCap,
  BULLETIN_TOKEN_HARD_CAP,
  type BulletinActivitySnapshot,
} from "@luna/core"
import { unwrapDigestText } from "@luna/adapter-sdk"

const BENCH_DIR = dirname(fileURLToPath(import.meta.url))
const MODEL = process.env["LUNA_BULLETIN_MODEL"] ?? "haiku"
const CALL_TIMEOUT_MS = 90_000

interface FixtureThread {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly messages: ReadonlyArray<{ readonly ts: string; readonly role: string; readonly text: string }>
}

const fixture = (() => {
  try {
    return JSON.parse(readFileSync(resolve(BENCH_DIR, "bulletin-fixture.json"), "utf8")) as {
      meta: { nowIso: string }
      threads: ReadonlyArray<FixtureThread>
    }
  } catch (e) {
    console.error(`[bulletin-generate] cannot read fixture: ${String(e)}`)
    process.exit(3)
  }
})()

// Eligibility mirrors production's chat.listThreads(active): archived
// threads never reach the writer. (The eval's exclusion probes catch a
// generator that violates this.)
const eligible: BulletinActivitySnapshot = fixture.threads
  .filter((t) => t.status !== "archived")
  .map((t) => ({
    id: t.id,
    title: t.title,
    lastMessageAt: t.messages[t.messages.length - 1]?.ts ?? "1970-01-01T00:00:00Z",
    messages: t.messages,
  }))

const snapshot = shapeActivitySnapshot(eligible, Date.parse(fixture.meta.nowIso))
const prompt = composeBulletinPrompt(fixture.meta.nowIso, null, snapshot)

// claude CLI plumbing (same shape as bulletin-eval.ts, one-shot).
const NEUTRAL_CWD = resolve(tmpdir(), "luna-bulletin-eval-cwd")
if (!existsSync(NEUTRAL_CWD)) mkdirSync(NEUTRAL_CWD, { recursive: true })

function callClaude(text: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "claude",
      ["-p", "--model", MODEL, "--output-format", "json", "--strict-mcp-config", "--disable-slash-commands", "--disallowedTools", "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task"],
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
    child.on("error", (e) => { clearTimeout(timer); reject(e) })
    child.stdin.on("error", () => {})
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) { reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`)); return }
      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown> | ReadonlyArray<Record<string, unknown>>
        const events = Array.isArray(parsed) ? parsed : [parsed]
        const resultEvent = [...events].reverse().find((e) => e["type"] === "result")
        if (resultEvent === undefined || resultEvent["is_error"] === true) {
          reject(new Error(`no usable result: ${stdout.slice(0, 200)}`)); return
        }
        resolvePromise(String(resultEvent["result"] ?? ""))
      } catch (e) { reject(new Error(`parse failure: ${String(e)}`)) }
    })
    child.stdin.end(text)
  })
}

const probe = spawnSync("claude", ["--version"], { stdio: "ignore" })
if (probe.error !== undefined || probe.status !== 0) {
  console.error("[bulletin-generate] claude CLI unavailable")
  process.exit(5)
}

console.log(`[bulletin-generate] model=${MODEL} threads=${snapshot.length} (archived excluded: ${fixture.threads.length - eligible.length})`)
// Same unwrap + cap-retry-fail-closed pipeline as the production writer
// (unwrapDigestText is the writer's own export - bench/prod parity).
let digest = unwrapDigestText(await callClaude(prompt))

if (!bulletinWithinCap(digest)) {
  console.log(`[bulletin-generate] over cap (~${estimateBulletinTokens(digest)} tokens), corrective retry...`)
  digest = unwrapDigestText(await callClaude(
    `${prompt}\n\nYour previous attempt was ~${estimateBulletinTokens(digest)} tokens, OVER the ${BULLETIN_TOKEN_HARD_CAP}-token limit. Rewrite the digest far more tersely; keep the same structure and rules.`,
  ))
}
if (!bulletinWithinCap(digest) || digest.length === 0) {
  // Fail closed exactly like production: an over-cap or empty digest is
  // never written for the gate to accidentally bless.
  console.error(`[bulletin-generate] FAIL-CLOSED: digest ${digest.length === 0 ? "empty" : `still over cap (~${estimateBulletinTokens(digest)} tokens)`} after corrective retry`)
  process.exit(4)
}

const outPath = resolve(BENCH_DIR, "bulletin-generated.txt")
writeFileSync(outPath, digest)
console.log(`[bulletin-generate] wrote ~${estimateBulletinTokens(digest)} tokens to ${outPath}`)
console.log(`[bulletin-generate] next: LUNA_BULLETIN_FILE=${outPath} bun packages/memory/bench/bulletin-eval.ts`)
