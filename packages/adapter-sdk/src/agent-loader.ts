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
 * Frontmatter parser is intentionally hand-rolled: we only support scalar
 * strings (optionally quoted) and block lists. Anything more complex would
 * be a smell in an agent definition file.
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

  const flushList = () => {
    if (currentListKey !== null) {
      fields[currentListKey] = currentList
      currentListKey = null
      currentList = []
    }
  }

  for (const line of lines) {
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
    const value = kv[2] ?? ""
    if (value.trim() === "") {
      currentListKey = key
      currentList = []
    } else {
      fields[key] = stripQuotes(value)
    }
  }
  flushList()

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
