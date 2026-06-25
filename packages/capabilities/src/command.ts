/**
 * The "command" kind — slash commands. The generic, framework-free autocomplete +
 * line-parse lifted and generalized from agent-cli (apps/agent-cli/src/tui/slash.ts).
 * These operate on CapabilityDescriptor of kind:"command" and are behavior-locked to
 * agent-cli's slashState/slashComplete (see test/command.test.ts parity cases).
 *
 * Canonical prefix rule: a command's id is stored WITHOUT a leading "/". The "/" is a
 * presentation/transport detail of the typed input line only — stripped on read,
 * re-added exactly once when emitting a completed input string.
 */

import type { CapabilityDescriptor } from "./descriptor.js"

/** A parsed "/name args" line: the verb (no "/") and the raw, post-token argument text. */
export interface ParsedCommandLine {
  /** The command name WITHOUT the leading "/". "" for a bare "/". */
  readonly name: string
  /** Everything after the first whitespace run, trimmed. "" when no args. */
  readonly args: string
}

/**
 * Parse a "/name args" line. Returns null when `input` is not a command line (does not
 * start with "/") or is not a string. Never throws. The `name` never carries the "/".
 * The verb SEMANTICS (what "/copy 5" means) are a per-kind concern and live at the edge,
 * not here — args is returned raw and verbatim.
 */
export function parseCommandLine(input: string): ParsedCommandLine | null {
  if (typeof input !== "string" || !input.startsWith("/")) return null
  const rest = input.slice(1)
  const wsIndex = rest.search(/\s/)
  if (wsIndex === -1) return { name: rest, args: "" }
  return { name: rest.slice(0, wsIndex), args: rest.slice(wsIndex).trim() }
}

/**
 * Prefix-filter command capabilities for an autocomplete menu — the generalized
 * slashState. Returns only kind:"command" descriptors whose `id` starts with the typed
 * query (text after "/"). Non-command kinds and a non-"/" / non-string input yield [].
 * Input order preserved; output frozen; never throws.
 */
export function filterCommands(
  input: string,
  commands: readonly CapabilityDescriptor[],
): readonly CapabilityDescriptor[] {
  if (typeof input !== "string" || !input.startsWith("/")) return Object.freeze([])
  const query = input.slice(1)
  return Object.freeze(commands.filter((c) => c.kind === "command" && c.id.startsWith(query)))
}

/**
 * Tab-completion — the generalized slashComplete. Returns the completed INPUT string
 * (with leading "/"), or null when completing adds nothing (not a command line, no
 * matches, or already at the longest common prefix). Single match → "/<id> "; multiple
 * → "/<lcp>". Never throws.
 */
export function completeCommand(
  input: string,
  commands: readonly CapabilityDescriptor[],
): string | null {
  const matches = filterCommands(input, commands)
  if (matches.length === 0) return null
  if (matches.length === 1) return `/${matches[0]!.id} `

  let prefix = matches[0]!.id
  for (const c of matches) {
    while (!c.id.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  const completed = `/${prefix}`
  // `input` is a valid "/..." string here (matches is non-empty), so .length is safe.
  return completed.length > input.length ? completed : null
}
