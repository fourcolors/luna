export interface SlashCommand { readonly name: string; readonly help: string }
export interface SlashState {
  readonly active: boolean
  readonly query: string
  readonly matches: ReadonlyArray<SlashCommand>
}

export const slashState = (
  input: string,
  commands: ReadonlyArray<SlashCommand>,
): SlashState => {
  // Defensive: callers wire this to live UI state that can momentarily be a
  // non-string (e.g. an editor change-event object). Never throw on bad input.
  if (typeof input !== "string" || !input.startsWith("/")) {
    return { active: false, query: "", matches: [] }
  }
  const query = input.slice(1)
  const matches = commands.filter((c) => c.name.startsWith(query))
  return { active: true, query, matches }
}

/**
 * Tab-completion for a slash command. Returns the completed input string, or
 * null when there's nothing useful to complete (not a slash, no matches, or
 * completing wouldn't add any characters). Shell-style: a single match
 * completes fully and appends a space; multiple matches complete to their
 * longest common prefix.
 */
export const slashComplete = (
  input: string,
  commands: ReadonlyArray<SlashCommand>,
): string | null => {
  const s = slashState(input, commands)
  if (!s.active || s.matches.length === 0) return null
  if (s.matches.length === 1) return `/${s.matches[0]!.name} `
  const names = s.matches.map((m) => m.name)
  let prefix = names[0]!
  for (const n of names) {
    while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  const completed = `/${prefix}`
  return completed.length > input.length ? completed : null
}
