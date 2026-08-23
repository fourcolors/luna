/**
 * agent-roster.ts — pure validation + metadata-only projection for the
 * `agent-list` frame (agent sidebar S1).
 *
 * SECURITY INVARIANT, the reason this module exists: `loadAgents()`
 * (adapter-sdk) returns FULL AgentDefinitions — system prompts, tool
 * allowlists, MCP references, permission modes. None of that may reach the
 * wire. The projection below emits `{ name, description }` and NOTHING
 * else, constructed field-by-field (never a spread) so a new field added
 * to AgentDefinition upstream cannot silently leak. The unit tests pin
 * exact key sets on the output.
 *
 * NAME GRAMMAR: a mentionable name must survive the composer's mention
 * token parser (`@name` opens at start-of-input or after whitespace and
 * abandons on whitespace), so names are `^[A-Za-z0-9][A-Za-z0-9_-]*$`.
 * A definition whose name cannot be typed as a mention is dropped from
 * the roster with a warn — advertising it would offer a menu row that can
 * never be inserted.
 *
 * RESERVED: `luna` (any case). Luna is the main-thread voice, not a
 * subagent; mentioning her in her own thread is a no-op with an identity
 * collision attached (PRODUCT.md's Luna-identity constraint). A definition
 * named luna is dropped with a warn.
 *
 * Pure module: no I/O, no Effect, no DOM — mirrors threadList.ts's
 * discipline so it is trivially unit-testable and consumable from both
 * the server wiring (chat-server.ts) and tests.
 */

/** One roster row as the wire sees it — METADATA ONLY, by construction. */
export interface AgentRosterEntry {
  readonly name: string
  readonly description: string
}

/**
 * Mentionable-name grammar. Must match the client's mention token parser:
 * starts alphanumeric, then alphanumerics/underscore/hyphen. No spaces,
 * no unicode, no leading punctuation.
 */
export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** Names the roster never offers, compared case-insensitively. */
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set(["luna"])

/** True when `name` is grammatical AND not reserved. */
export const isValidAgentName = (name: string): boolean =>
  AGENT_NAME_RE.test(name) && !RESERVED_AGENT_NAMES.has(name.toLowerCase())

/**
 * Project a full agent-definition map (the `loadAgents()` shape — values
 * are opaque records that at minimum carry `description`) down to the
 * wire-safe roster. Invalid and reserved names are dropped (with an
 * optional warn callback so the server can log without this module
 * importing a logger). Output is sorted by name for deterministic frames.
 */
export const projectAgentRoster = (
  defs: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  warn?: (message: string) => void,
): ReadonlyArray<AgentRosterEntry> => {
  const out: AgentRosterEntry[] = []
  for (const [name, def] of Object.entries(defs)) {
    if (!AGENT_NAME_RE.test(name)) {
      warn?.(`[agent-roster] dropping "${name}": name cannot be @-mentioned (grammar)`)
      continue
    }
    if (RESERVED_AGENT_NAMES.has(name.toLowerCase())) {
      warn?.(`[agent-roster] dropping "${name}": reserved name`)
      continue
    }
    const rawDesc = def["description"]
    const description =
      typeof rawDesc === "string" && rawDesc.trim().length > 0
        ? rawDesc.trim()
        : ""
    // Field-by-field on purpose — never `...def` (see module doc).
    out.push({ name, description })
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}
