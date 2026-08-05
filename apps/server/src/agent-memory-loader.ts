/**
 * Luna main-thread observational memory loader.
 *
 * Loads `MEMORY.md` for Luna's main thread (NOT a subagent — those are
 * auto-loaded by the Claude Agent SDK from
 * `~/.claude/agent-memory/<agentType>/` when their definition declares
 * `memory: user`). This loader fills the symmetric gap for the top-level
 * session: chat-server.ts injects the contents alongside DNA.md / SYSTEM.md
 * so Luna's observations persist across context resets.
 *
 * The discipline (priority emojis, dated bullets, observer pass at task
 * end, reflector pass at the 200-line cliff) is documented in the
 * `subagent-memory` skill at `seeds/skills/subagent-memory/SKILL.md`
 * — chat-server.ts adds a 3-line pointer to it so Luna can consult the
 * full rules when running observer / reflector. We do NOT inline the
 * whole skill in the main system prompt; DNA.md + SYSTEM.md already
 * carry behavioural framing and the per-thread context cost would be
 * meaningful.
 *
 * Imported by chat-server.ts. Extracted so tests can import it without
 * pulling the whole chat-server dependency tree.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve as resolvePath } from "node:path"

/**
 * Cap mirrors the subagent-memory skill's harness injection cliff:
 *   - 200 lines first; then
 *   - 25 KB (the byte cap is checked after the line cap so a single
 *     pathologically long line can't blow the budget).
 *
 * Same value as the SDK's auto-load cap so subagent and main-thread
 * memory feel symmetric in size.
 */
export const MAIN_MEMORY_CAP_LINES = 200
export const MAIN_MEMORY_CAP_BYTES = 25 * 1024

/**
 * Resolve the path Luna's main thread reads its observational memory from.
 * `$LUNA_HOME` is honoured, falling back to `~/.luna/`.
 */
export const resolveMainMemoryPath = (
  homeOverride?: string,
): string => {
  const lunaHome =
    homeOverride ?? process.env.LUNA_HOME ?? join(homedir(), ".luna")
  return resolvePath(lunaHome, "agent-memory", "luna-main", "MEMORY.md")
}

/**
 * Read MEMORY.md at the resolved path and cap the contents.
 *
 * Returns `null` when the file is absent — the caller decides whether to
 * inject nothing (clean prompt) or a placeholder block. Returns an empty
 * string when the file exists but is empty.
 *
 * Errors other than "file does not exist" surface to the caller — a
 * misconfigured permission failure should fail boot loudly rather than
 * be silently swallowed.
 */
export const loadMainMemory = (
  memoryPath: string = resolveMainMemoryPath(),
): string | null => {
  if (!existsSync(memoryPath)) return null
  const raw = readFileSync(memoryPath, "utf-8")
  return capContent(raw)
}

/** Visible for tests. */
export const capContent = (raw: string): string => {
  const lines = raw.split(/\r?\n/)
  const lineCapped = lines.slice(0, MAIN_MEMORY_CAP_LINES).join("\n")
  if (Buffer.byteLength(lineCapped, "utf8") <= MAIN_MEMORY_CAP_BYTES) {
    return lineCapped
  }
  // Binary-search the largest line prefix that fits the byte cap.
  let lo = 0
  let hi = lines.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    const candidate = lines.slice(0, mid).join("\n")
    if (Buffer.byteLength(candidate, "utf8") <= MAIN_MEMORY_CAP_BYTES) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return lines.slice(0, lo).join("\n")
}

/**
 * Build the system-prompt block. Returns `null` when there's nothing to
 * inject (file absent + we don't want to spam an empty header).
 *
 * The block opens with a one-paragraph pointer to the subagent-memory
 * SKILL.md so Luna knows the discipline lives there — and closes by
 * stating where the file is for observer-pass writes.
 */
export const buildMainMemoryBlock = (
  memoryContent: string | null,
  memoryPath: string = resolveMainMemoryPath(),
): string | null => {
  if (memoryContent === null || memoryContent.trim().length === 0) return null

  return [
    "## Your observational memory",
    "",
    "These are durable observations you've recorded across past invocations of",
    "this Luna thread. The discipline (priority emojis 🔴🟡🟢✅, dated bullets,",
    "observer pass at task end, reflector pass at ~195 lines) lives at",
    "`~/.claude/skills/subagent-memory/SKILL.md`. Read on start, append at the",
    "end of substantive turns. File: `" + memoryPath + "`.",
    "",
    "---",
    "",
    memoryContent,
  ].join("\n")
}
