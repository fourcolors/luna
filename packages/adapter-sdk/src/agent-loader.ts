/**
 * Agent loader — reads agent definition files from a directory and returns
 * `Record<string, AgentDefinition>` suitable for the SDK's `Options.agents`.
 *
 * File format: `<name>.md` with YAML frontmatter followed by a markdown body.
 * The body becomes the agent's system prompt (`prompt`). The frontmatter
 * declares all other `AgentDefinition` fields.
 *
 * Supported frontmatter scalar types:
 *   - Single-line strings (optionally quoted)
 *   - Folded scalars: `>` or `>-` (multi-line, joined with a single space)
 *   - Literal block scalars: `|` or `|-` (multi-line, joined with newlines)
 *   - Block lists: `key:\n  - item`
 *
 * Full YAML is not supported by design. Agent definition files should be
 * simple enough to read in seconds — if yours isn't, use `sdkOptions` instead.
 *
 * Supported AgentDefinition fields (all optional except `description`):
 *   description, model, effort, tools, disallowedTools, skills,
 *   mcpServers (string references only — inline server specs not supported),
 *   maxTurns, background, memory, permissionMode,
 *   initialPrompt, criticalSystemReminder_EXPERIMENTAL
 *
 * Malformed or unrecognised files are skipped with a console.warn. The loader
 * never throws — a missing or unreadable directory returns {}.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk"

// ── Frontmatter parser ────────────────────────────────────────────────────────

/** Fields parsed from YAML frontmatter. Values are strings or string arrays. */
type FrontmatterFields = Record<string, string | string[]>

interface ParsedFile {
  readonly fields: FrontmatterFields
  /** Markdown body used as the agent's system prompt. */
  readonly body: string
}

const DOCUMENT_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

const stripQuotes = (value: string): string => {
  const v = value.trim()
  if (v.length >= 2) {
    const first = v[0]
    const last = v[v.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1)
    }
  }
  return v
}

/**
 * Parser mode for multi-line block scalars.
 *   "folded"  — `>` / `>-`  lines joined with a single space
 *   "literal" — `|` / `|-`  lines joined with a newline
 */
type BlockMode = "folded" | "literal"

/**
 * Parse a YAML frontmatter block into typed fields. Returns null when the
 * document does not contain a valid `--- ... ---` frontmatter section.
 */
const parseFrontmatter = (raw: string): ParsedFile | null => {
  const match = DOCUMENT_RE.exec(raw)
  if (!match) return null

  const frontmatter = match[1] ?? ""
  const body = (match[2] ?? "").trim()
  const lines = frontmatter.split(/\r?\n/)
  const fields: FrontmatterFields = {}

  // Parser state — only one of these is active at a time.
  let listKey: string | null = null
  let listItems: string[] = []
  let blockKey: string | null = null
  let blockMode: BlockMode = "folded"
  let blockLines: string[] = []

  const commitList = () => {
    if (listKey !== null) {
      fields[listKey] = listItems
      listKey = null
      listItems = []
    }
  }

  const commitBlock = () => {
    if (blockKey !== null) {
      const sep = blockMode === "literal" ? "\n" : " "
      fields[blockKey] = blockLines.join(sep).trim()
      blockKey = null
      blockLines = []
    }
  }

  for (const line of lines) {
    // A block scalar accumulates indented lines AND blank lines within the block.
    if (blockKey !== null) {
      if (/^\s+/.test(line)) {
        // Indented content line — strip leading indent and accumulate.
        blockLines.push(line.trim())
        continue
      }
      if (line.trim() === "") {
        // Blank line inside a block scalar is a paragraph break — keep it.
        blockLines.push("")
        continue
      }
      // First non-indented, non-blank line terminates the block.
      commitBlock()
    }

    if (line.trim() === "") continue

    // Block list items (`  - value`) attach to the current list key.
    const listItemMatch = /^\s+-\s+(.*)$/.exec(line)
    if (listItemMatch !== null && listKey !== null) {
      listItems.push(stripQuotes(listItemMatch[1] ?? ""))
      continue
    }

    // Key-value pair — commits any in-flight list or block scalar first.
    const kvMatch = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (kvMatch === null) continue

    commitList()
    const key = kvMatch[1] ?? ""
    const value = (kvMatch[2] ?? "").trim()

    if (value === ">-" || value === ">") {
      // Folded block scalar — lines joined with a space.
      blockKey = key
      blockMode = "folded"
      blockLines = []
    } else if (value === "|-" || value === "|") {
      // Literal block scalar — lines joined with a newline.
      blockKey = key
      blockMode = "literal"
      blockLines = []
    } else if (value === "") {
      // Empty value means a block list follows.
      listKey = key
      listItems = []
    } else {
      fields[key] = stripQuotes(value)
    }
  }

  // Commit any trailing state after the last line.
  commitList()
  commitBlock()

  return { fields, body }
}

// ── AgentDefinition mapping ───────────────────────────────────────────────────

const getString = (
  fields: FrontmatterFields,
  key: string,
): string | undefined => {
  const value = fields[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const getStringList = (
  fields: FrontmatterFields,
  key: string,
): string[] | undefined => {
  const value = fields[key]
  return Array.isArray(value) && value.length > 0 ? value : undefined
}

/**
 * Map parsed frontmatter fields to an `AgentDefinition`. Returns null when
 * the required `description` field is absent or empty.
 */
const toAgentDefinition = (parsed: ParsedFile): AgentDefinition | null => {
  const description = getString(parsed.fields, "description")
  if (description === undefined) return null

  const def: AgentDefinition = {
    description,
    prompt: parsed.body,
  }

  // ── String scalars ──────────────────────────────────────────────────────────

  const model = getString(parsed.fields, "model")
  if (model !== undefined) def.model = model

  const initialPrompt = getString(parsed.fields, "initialPrompt")
  if (initialPrompt !== undefined) def.initialPrompt = initialPrompt

  // Field name dictated by SDK — the _EXPERIMENTAL suffix is intentional.
  const criticalReminder = getString(
    parsed.fields,
    "criticalSystemReminder_EXPERIMENTAL",
  )
  if (criticalReminder !== undefined) {
    def.criticalSystemReminder_EXPERIMENTAL = criticalReminder
  }

  // ── Numeric scalars ─────────────────────────────────────────────────────────

  const effortRaw = getString(parsed.fields, "effort")
  if (effortRaw !== undefined) {
    if (
      effortRaw === "low" ||
      effortRaw === "medium" ||
      effortRaw === "high" ||
      effortRaw === "xhigh" ||
      effortRaw === "max"
    ) {
      def.effort = effortRaw
    } else {
      const numeric = Number(effortRaw)
      if (Number.isFinite(numeric) && numeric > 0) def.effort = numeric
    }
  }

  const maxTurnsRaw = getString(parsed.fields, "maxTurns")
  if (maxTurnsRaw !== undefined) {
    const maxTurns = Number(maxTurnsRaw)
    if (Number.isInteger(maxTurns) && maxTurns > 0) def.maxTurns = maxTurns
  }

  // ── Boolean scalars ─────────────────────────────────────────────────────────

  const backgroundRaw = getString(parsed.fields, "background")
  if (backgroundRaw === "true") def.background = true
  else if (backgroundRaw === "false") def.background = false

  // ── Enum scalars ────────────────────────────────────────────────────────────

  const memoryRaw = getString(parsed.fields, "memory")
  if (
    memoryRaw === "user" ||
    memoryRaw === "project" ||
    memoryRaw === "local"
  ) {
    def.memory = memoryRaw
  }

  const permissionModeRaw = getString(parsed.fields, "permissionMode")
  if (
    permissionModeRaw === "default" ||
    permissionModeRaw === "acceptEdits" ||
    permissionModeRaw === "auto" ||
    permissionModeRaw === "bypassPermissions" ||
    permissionModeRaw === "dontAsk" ||
    permissionModeRaw === "plan"
  ) {
    def.permissionMode = permissionModeRaw
  }

  // ── String lists ────────────────────────────────────────────────────────────

  const tools = getStringList(parsed.fields, "tools")
  if (tools !== undefined) def.tools = tools

  const disallowedTools = getStringList(parsed.fields, "disallowedTools")
  if (disallowedTools !== undefined) def.disallowedTools = disallowedTools

  const skills = getStringList(parsed.fields, "skills")
  if (skills !== undefined) def.skills = skills

  // mcpServers accepts string references only. Inline object specs require
  // the full McpServerConfigForProcessTransport shape — use sdkOptions instead.
  const mcpServers = getStringList(parsed.fields, "mcpServers")
  if (mcpServers !== undefined) def.mcpServers = mcpServers

  return def
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load all `*.md` agent definitions from `agentsDir`.
 *
 * - Missing or unreadable directory → returns `{}`
 * - Malformed or incomplete files → skipped with `console.warn`
 * - The agent's key in the returned map is its `name` frontmatter field,
 *   falling back to the filename stem if `name` is absent.
 *
 * Called on every SDK query so agents are hot-loaded without a restart.
 * Uses synchronous I/O — appropriate for a per-query filesystem read of
 * a small directory, not a hot loop.
 */
export const loadAgents = (
  agentsDir: string = join(homedir(), ".luna", "agents"),
): Record<string, AgentDefinition> => {
  if (!existsSync(agentsDir)) return {}

  let entries: string[]
  try {
    entries = readdirSync(agentsDir)
  } catch (err) {
    console.warn(`[agent-loader] Could not read agents directory: ${agentsDir}`, err)
    return {}
  }

  const agents: Record<string, AgentDefinition> = {}

  for (const filename of entries) {
    if (!filename.endsWith(".md")) continue

    const filePath = join(agentsDir, filename)
    let raw: string
    try {
      raw = readFileSync(filePath, "utf8")
    } catch (err) {
      console.warn(`[agent-loader] Could not read agent file: ${filePath}`, err)
      continue
    }

    const parsed = parseFrontmatter(raw)
    if (parsed === null) {
      console.warn(`[agent-loader] No frontmatter found, skipping: ${filePath}`)
      continue
    }

    const definition = toAgentDefinition(parsed)
    if (definition === null) {
      console.warn(`[agent-loader] Missing required 'description' field, skipping: ${filePath}`)
      continue
    }

    const nameField = getString(parsed.fields, "name")
    const agentKey = nameField ?? filename.replace(/\.md$/, "")
    agents[agentKey] = definition
  }

  return agents
}
