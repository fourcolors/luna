/**
 * Agent loader — reads markdown agent definitions from disk and produces
 * `Record<string, AgentDefinition>` suitable for the SDK's `Options.agents`
 * field.
 *
 * Format: `<name>.md` files with YAML frontmatter:
 *   ---
 *   name: advisor
 *   description: "..."
 *   model: opus
 *   effort: max
 *   tools:
 *     - Read
 *     - Grep
 *   ---
 *   <markdown body — used as the agent's system prompt>
 *
 * Frontmatter parser is intentionally hand-rolled: we support scalar strings
 * (single-line, optionally quoted), folded scalars (>- multiline joined with
 * spaces), and block lists (- item). Anything more complex would be a smell
 * in an agent definition file.
 *
 * Supported AgentDefinition fields (all optional except description + prompt):
 *   description, model, effort, tools, disallowedTools, skills, mcpServers
 *   (string refs only), maxTurns, background, memory, permissionMode,
 *   initialPrompt, criticalSystemReminder_EXPERIMENTAL
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk"

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

interface ParsedFrontmatter {
  readonly fields: Record<string, string | string[]>
  readonly body: string
}

const stripQuotes = (s: string): string => {
  const t = s.trim()
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1)
  }
  return t
}

const parseFrontmatter = (raw: string): ParsedFrontmatter | null => {
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) return null
  const head = m[1] ?? ""
  const body = m[2] ?? ""
  const lines = head.split(/\r?\n/)
  const fields: Record<string, string | string[]> = {}

  let currentListKey: string | null = null
  let currentList: string[] = []
  let currentFoldedKey: string | null = null
  let currentFoldedLines: string[] = []

  const flushList = () => {
    if (currentListKey !== null) {
      fields[currentListKey] = currentList
      currentListKey = null
      currentList = []
    }
  }

  const flushFolded = () => {
    if (currentFoldedKey !== null) {
      fields[currentFoldedKey] = currentFoldedLines.join(" ").trim()
      currentFoldedKey = null
      currentFoldedLines = []
    }
  }

  for (const line of lines) {
    // Continuation lines for a folded scalar (indented)
    if (currentFoldedKey !== null) {
      if (line.match(/^\s+/)) {
        currentFoldedLines.push(line.trim())
        continue
      }
      // Non-indented line ends the folded scalar
      flushFolded()
    }

    if (line.trim() === "") continue

    const listItem = /^\s*-\s+(.*)$/.exec(line)
    if (listItem && currentListKey !== null) {
      currentList.push(stripQuotes(listItem[1] ?? ""))
      continue
    }

    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    flushList()
    const key = kv[1] ?? ""
    const value = (kv[2] ?? "").trim()

    if (value === ">-" || value === ">" || value === "|" || value === "|-") {
      // Folded or literal block scalar — collect indented continuation lines
      currentFoldedKey = key
      currentFoldedLines = []
    } else if (value === "") {
      currentListKey = key
      currentList = []
    } else {
      fields[key] = stripQuotes(value)
    }
  }
  flushList()
  flushFolded()

  return { fields, body: body.trim() }
}

const toAgentDefinition = (
  parsed: ParsedFrontmatter,
): AgentDefinition | null => {
  const desc = parsed.fields["description"]
  if (typeof desc !== "string" || desc.length === 0) return null
  const def: AgentDefinition = {
    description: desc,
    prompt: parsed.body,
  }
  const model = parsed.fields["model"]
  if (typeof model === "string" && model.length > 0) {
    def.model = model
  }
  const effort = parsed.fields["effort"]
  if (typeof effort === "string" && effort.length > 0) {
    const numeric = Number(effort)
    if (Number.isFinite(numeric)) {
      def.effort = numeric
    } else if (
      effort === "low" ||
      effort === "medium" ||
      effort === "high" ||
      effort === "xhigh" ||
      effort === "max"
    ) {
      def.effort = effort
    }
  }
  const tools = parsed.fields["tools"]
  if (Array.isArray(tools) && tools.length > 0) {
    def.tools = tools
  }
  const disallowed = parsed.fields["disallowedTools"]
  if (Array.isArray(disallowed) && disallowed.length > 0) {
    def.disallowedTools = disallowed
  }
  const skills = parsed.fields["skills"]
  if (Array.isArray(skills) && skills.length > 0) {
    def.skills = skills
  }
  // mcpServers: block list items are treated as string references.
  // Inline object specs are not supported in frontmatter — use sdkOptions directly.
  const mcpServers = parsed.fields["mcpServers"]
  if (Array.isArray(mcpServers) && mcpServers.length > 0) {
    def.mcpServers = mcpServers
  }
  const maxTurns = parsed.fields["maxTurns"]
  if (typeof maxTurns === "string" && maxTurns.length > 0) {
    const n = Number(maxTurns)
    if (Number.isInteger(n) && n > 0) def.maxTurns = n
  }
  const background = parsed.fields["background"]
  if (background === "true") def.background = true
  else if (background === "false") def.background = false

  const memory = parsed.fields["memory"]
  if (memory === "user" || memory === "project" || memory === "local") {
    def.memory = memory
  }
  const permissionMode = parsed.fields["permissionMode"]
  if (
    permissionMode === "default" ||
    permissionMode === "acceptEdits" ||
    permissionMode === "auto" ||
    permissionMode === "bypassPermissions" ||
    permissionMode === "dontAsk" ||
    permissionMode === "plan"
  ) {
    def.permissionMode = permissionMode
  }
  const initialPrompt = parsed.fields["initialPrompt"]
  if (typeof initialPrompt === "string" && initialPrompt.length > 0) {
    def.initialPrompt = initialPrompt
  }
  const criticalReminder = parsed.fields["criticalSystemReminder_EXPERIMENTAL"]
  if (typeof criticalReminder === "string" && criticalReminder.length > 0) {
    def.criticalSystemReminder_EXPERIMENTAL = criticalReminder
  }
  return def
}

export const loadAgents = (
  agentsDir: string = join(homedir(), ".luna", "agents"),
): Record<string, AgentDefinition> => {
  if (!existsSync(agentsDir)) return {}
  let entries: string[]
  try {
    entries = readdirSync(agentsDir)
  } catch {
    return {}
  }
  const result: Record<string, AgentDefinition> = {}
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    const path = join(agentsDir, entry)
    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch {
      continue
    }
    const parsed = parseFrontmatter(raw)
    if (!parsed) continue
    const def = toAgentDefinition(parsed)
    if (!def) continue
    const name = parsed.fields["name"]
    const key =
      typeof name === "string" && name.length > 0
        ? name
        : entry.replace(/\.md$/, "")
    result[key] = def
  }
  return result
}
