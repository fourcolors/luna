/**
 * agent-mention-addendum.ts — the @ mention contract, as a system-prompt
 * addendum (agent sidebar S3).
 *
 * STEERING, NOT ENFORCEMENT, by design (Mr. Cobb's ruling 2026-08-22 + the
 * SDK's own contract): naming an agent in the prompt is the Agent SDK's
 * documented explicit-invocation mechanism ("mention it by name in your
 * prompt... directly invokes the named subagent"). This addendum tells Luna
 * what an operator-typed `@name` MEANS — a per-turn CC, never a re-filing
 * and never an identity change — and enumerates the roster so the names
 * resolve. The mechanism itself is the SDK's; there is no parser and no
 * wire field.
 *
 * Roster rows come pre-projected ({name, description} only — see ui-ws
 * agent-roster.ts). Returns "" when the roster is empty so chat-server's
 * systemPrompt array filter drops it entirely (same contract as the other
 * addendum contributors: empty string = absent).
 *
 * Pure module: no I/O, no Effect. Imported by chat-server.ts (which reads
 * the roster per-thread via loadAgents + projectAgentRoster, matching the
 * hot-load behavior of Options.agents) and unit-tested directly.
 */

export interface MentionableAgent {
  readonly name: string
  readonly description: string
}

export const buildAgentMentionAddendum = (
  agents: ReadonlyArray<MentionableAgent>,
): string => {
  if (agents.length === 0) return ""
  const rows = agents
    .map((a) => `- @${a.name}${a.description ? `: ${a.description}` : ""}`)
    .join("\n")
  return [
    "## Agent mentions",
    "",
    "The operator can bring a registered subagent into a turn by typing",
    "`@<name>` in their message. When an operator message mentions one of",
    "the agents below, treat it as an instruction for THIS turn: delegate",
    "the relevant part of the message to that agent via the Agent tool",
    "(subagent_type = the mentioned name, run_in_background: false), wait",
    "for its report, and relay the outcome in your reply, crediting the",
    "agent.",
    "",
    "A mention is a per-turn CC, never a transfer: it does not change who",
    "you are, it does not route future turns, and a turn without a mention",
    "is yours alone. Mentions inside code blocks, quoted text, or email",
    "addresses are not requests. If several agents are mentioned, bring in",
    "each one whose expertise the message actually calls for.",
    "",
    "Mentionable agents:",
    rows,
  ].join("\n")
}
