export type SlashSpec = {
  readonly name: string
  readonly description: string
  readonly argHint?: string
}

export const SLASH_COMMANDS: readonly SlashSpec[] = [
  { name: "/help",        description: "show slash commands" },
  { name: "/threads",     description: "list threads" },
  { name: "/new",         description: "start a new thread" },
  { name: "/switch",      description: "switch to a thread", argHint: "<thread-id>" },
  { name: "/interrupt",   description: "interrupt the current response" },
  { name: "/quit",        description: "quit Luna" },
  { name: "/exit",        description: "quit Luna" },
  { name: "/local-shell", description: "toggle or check local shell", argHint: "<on|off|status>" },
]
