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
