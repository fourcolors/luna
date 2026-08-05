/**
 * install-claude-skills — mirror seeds/skills/ → ~/.claude/skills/
 *
 * The Claude Agent SDK (which Luna's adapter wraps) auto-loads skills from
 * `~/.claude/skills/<name>/` whenever an AgentDefinition's `skills: [...]`
 * frontmatter field names them. It also auto-loads `MEMORY.md` from
 * `~/.claude/agent-memory/<agent-name>/MEMORY.md` when `memory: user` is set.
 *
 * The SDK's hardcoded path is `.claude`, not `.luna` — skills + agent-memory
 * are shared with Claude Code by design.
 *
 * This script vendors Luna's curated skill set (currently: subagent-memory
 * from fourcolors/skills) into that shared location so Luna's subagents can
 * opt in by declaring:
 *
 *   ---
 *   name: my-agent
 *   description: "..."
 *   memory: user
 *   skills:
 *     - subagent-memory
 *   ---
 *
 * Usage:
 *   bun run apps/server/scripts/install-claude-skills.ts
 *   bun run apps/server/scripts/install-claude-skills.ts --dry-run
 *   bun run apps/server/scripts/install-claude-skills.ts --force
 *
 * Behavior:
 *   default   — install skills that aren't already present; skip existing
 *   --force   — overwrite existing skill files
 *   --dry-run — print what would happen; touch nothing
 *
 * The script does NOT delete anything in ~/.claude/skills/ — operator's
 * own skills (installed via the `skills` CLI from fourcolors/skills or
 * elsewhere) are untouched.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative } from "node:path"

const args = new Set(process.argv.slice(2))
const DRY = args.has("--dry-run")
const FORCE = args.has("--force")

const repoRoot = new URL("../../..", import.meta.url).pathname
const seedsDir = join(repoRoot, "seeds", "skills")
const targetDir = join(homedir(), ".claude", "skills")

console.log("[install-claude-skills] config:")
console.log(`  seedsDir : ${seedsDir}`)
console.log(`  targetDir: ${targetDir}`)
console.log(`  mode     : ${DRY ? "dry-run" : FORCE ? "force" : "default"}`)

if (!existsSync(seedsDir)) {
  console.error(`[install-claude-skills] FATAL: seedsDir not found: ${seedsDir}`)
  process.exit(1)
}

/** Recursively list files (not dirs), returning paths relative to root. */
const walk = (root: string): string[] => {
  const out: string[] = []
  const visit = (p: string) => {
    const s = statSync(p)
    if (s.isDirectory()) {
      for (const entry of readdirSync(p)) visit(join(p, entry))
    } else if (s.isFile()) {
      out.push(p)
    }
  }
  visit(root)
  return out
}

let installed = 0
let skippedExisting = 0
let overwrote = 0

for (const srcPath of walk(seedsDir)) {
  const rel = relative(seedsDir, srcPath)
  const dstPath = join(targetDir, rel)

  if (existsSync(dstPath) && !FORCE) {
    console.log(`  · skip (exists): ${rel}`)
    skippedExisting++
    continue
  }

  const action = existsSync(dstPath) ? "overwrite" : "install"
  console.log(`  ${DRY ? "[dry] " : ""}${action}: ${rel}`)

  if (!DRY) {
    mkdirSync(dirname(dstPath), { recursive: true })
    copyFileSync(srcPath, dstPath)
  }
  if (action === "overwrite") overwrote++
  else installed++
}

console.log("[install-claude-skills] summary:")
console.log(`  installed       : ${installed}`)
console.log(`  overwrote       : ${overwrote}`)
console.log(`  skipped (exists): ${skippedExisting}`)

if (DRY) {
  console.log("[install-claude-skills] dry-run — nothing was written.")
}
