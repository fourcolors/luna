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
  if (!input.startsWith("/")) return { active: false, query: "", matches: [] }
  const query = input.slice(1)
  const matches = commands.filter((c) => c.name.startsWith(query))
  return { active: true, query, matches }
}
