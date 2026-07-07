/**
 * Tool effect classification.
 *
 * Every tool the Luna framework may invoke is assigned one of six effect
 * classes. The class is used by downstream policy interceptors (e.g.
 * egressAllowlist) to decide quickly whether a given tool is in-scope
 * for a particular rule without repeating tool-name checks across modules.
 *
 * Classification is a pure lookup — no I/O, no side-effects.
 */

export type ToolEffectClass =
  | "read"    // reads local filesystem / notebook
  | "write"   // mutates local filesystem / notebook
  | "exec"    // executes arbitrary shell commands
  | "egress"  // reaches the external network (web fetch / search)
  | "spend"   // consumes paid external API credits
  | "meta"    // tool management, MCP tools, or anything unrecognised

/** All tool names that map to "egress". */
const EGRESS_TOOLS = new Set(["WebFetch", "WebSearch"])

/** All tool names that map to "read". */
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead"])

/** All tool names that map to "write". */
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"])

/** All tool names that map to "exec". */
const EXEC_TOOLS = new Set(["Bash", "mcp__local_shell__local_shell_run"])

/**
 * Return the {@link ToolEffectClass} for a given tool name.
 *
 * Unknown tool names — including arbitrary `mcp__*` names not listed above —
 * fall through to `"meta"`. This is intentionally conservative: an unknown
 * tool is not assumed to be safe for egress or filesystem write.
 */
export const classifyTool = (toolName: string): ToolEffectClass => {
  if (EGRESS_TOOLS.has(toolName)) return "egress"
  if (READ_TOOLS.has(toolName)) return "read"
  if (WRITE_TOOLS.has(toolName)) return "write"
  if (EXEC_TOOLS.has(toolName)) return "exec"
  return "meta"
}
