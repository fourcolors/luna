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
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
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
