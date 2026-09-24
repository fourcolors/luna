/**
 * Spawn the `claude` CLI for bench data generation with NO ambient context.
 *
 * A plain `claude -p` run from the repo loads the user's and the project's
 * CLAUDE.md, auto-memory, hooks and MCP servers. For eval inputs that is a
 * leak: generated query keywords named internal terms the query never
 * mentioned (and personal details), inflating results and putting private
 * data into files meant for a public repo. It also persisted every call as
 * a session whose first "user" message is the generator prompt.
 *
 * `--bare` would be simplest but refuses subscription (OAuth) auth, so
 * isolation is assembled from: no setting sources (no user/project CLAUDE.md,
 * settings or hooks), no tools, no MCP servers, no session persistence, and a
 * fresh empty working directory per call (no project memory or files).
 * Verified: asked what to call the user, an isolated call answers "no
 * specific name"; a plain call answers with the user's name.
 *
 * Isolation is PARTIAL: the CLI still injects the logged-in account's email
 * into every call (outside the system prompt; --system-prompt does not remove
 * it, only --bare, which refuses subscription auth). Callers must sanitize
 * model output for identifiers (see expand-queries.ts sanitizeKeywords) and
 * scan generated files before committing them.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Bump when the isolation changes, so sidecars from an older generator are refused. */
export const GENERATOR_ISOLATION = "isolated-v1"

export const ISOLATED_CLAUDE_ARGS: ReadonlyArray<string> = [
  "--setting-sources",
  "",
  "--tools",
  "",
  "--strict-mcp-config",
  "--no-session-persistence",
]

/** `claude -p --model <model>` with no ambient context; the temp cwd is removed on exit. */
export function spawnIsolatedClaude(model: string): ChildProcessWithoutNullStreams {
  const cwd = mkdtempSync(join(tmpdir(), "luna-bench-claude-"))
  const child = spawn("claude", ["-p", "--model", model, ...ISOLATED_CLAUDE_ARGS], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  })
  child.on("close", () => rmSync(cwd, { recursive: true, force: true }))
  return child
}

const GENERIC_WORDS = new Set(["mail", "email", "gmail", "com", "net", "org", "io", "me", "co", "organization", "personal", "team", "workspace", "inc", "llc", "the", "and"])

/**
 * Lower-cased fragments of the identity the CLI injects into every call
 * (account email local part and provider, distinctive org-name words), read
 * at runtime from `claude auth status` so nothing personal is written into
 * the repo. A model can echo these partially ("user email <local-part>",
 * "<provider> mail address"), which no generic pattern catches, so
 * generated text containing any fragment must be dropped. Throws when the
 * identity cannot be read: without it, output cannot be guaranteed clean.
 */
export function identityFragments(): ReadonlyArray<string> {
  let status: { email?: unknown; orgName?: unknown }
  try {
    status = JSON.parse(execFileSync("claude", ["auth", "status"], { encoding: "utf8" })) as typeof status
  } catch (e) {
    throw new Error(`cannot read claude auth status to scrub the injected identity: ${String(e)}`)
  }
  const out = new Set<string>()
  const add = (s: string) => {
    for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 4 && !GENERIC_WORDS.has(w)) out.add(w)
  }
  if (typeof status.email === "string") {
    const [local = "", domain = ""] = status.email.split("@")
    out.add(local.toLowerCase())
    add(local)
    add(domain)
  }
  if (typeof status.orgName === "string") add(status.orgName)
  out.delete("")
  if (out.size === 0) throw new Error("claude auth status returned no identity to scrub")
  return [...out]
}
