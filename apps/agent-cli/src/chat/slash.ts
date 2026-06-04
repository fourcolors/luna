export type SlashCommand =
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "help" }
  | { readonly type: "threads" }
  | { readonly type: "new-thread" }
  | { readonly type: "switch-thread"; readonly threadId: string }
  | { readonly type: "interrupt" }
  | { readonly type: "quit" }
  | { readonly type: "local-shell"; readonly action: "on" | "off" }
  | { readonly type: "local-shell-status" }
  | { readonly type: "local-shell-attach"; readonly root: string }
  | { readonly type: "local-shell-detach"; readonly root: string }
  | { readonly type: "local-shell-full-access"; readonly enabled: boolean }
  | { readonly type: "error"; readonly message: string }

export const HELP_TEXT = [
  "/help - show slash commands",
  "/threads - list threads",
  "/new - start a new thread",
  "/switch <thread-id> - switch to a thread",
  "/interrupt - interrupt the current response",
  "/quit - quit Luna",
  "/exit - quit Luna",
  "/local-shell on - enable local shell execution",
  "/local-shell off - disable local shell execution",
  "/local-shell status - show local shell status and attached folders",
  "/local-shell add <path> - attach a working-directory root",
  "/local-shell rm <path> - detach a working-directory root",
  "/local-shell full-access <on|off> - allow local shell in any directory",
].join("\n")

export { SLASH_COMMANDS, type SlashSpec } from "./slash-registry.js"

const splitCommand = (line: string): readonly [string, string] => {
  const trimmed = line.trim()
  const space = trimmed.search(/\s/)
  if (space < 0) return [trimmed, ""]
  return [trimmed.slice(0, space), trimmed.slice(space).trim()]
}

const parseLocalShell = (rest: string): SlashCommand => {
  const [sub, arg] = splitCommand(rest)
  switch (sub) {
    case "on":
    case "off":
      return { type: "local-shell", action: sub }
    case "":
    case "status":
      return { type: "local-shell-status" }
    case "add":
    case "attach":
      if (arg.length === 0) {
        return { type: "error", message: "/local-shell add requires a path" }
      }
      return { type: "local-shell-attach", root: arg }
    case "rm":
    case "remove":
    case "detach":
      if (arg.length === 0) {
        return { type: "error", message: "/local-shell rm requires a path" }
      }
      return { type: "local-shell-detach", root: arg }
    case "full-access":
      if (arg === "on" || arg === "off") {
        return { type: "local-shell-full-access", enabled: arg === "on" }
      }
      return {
        type: "error",
        message: "/local-shell full-access requires on or off",
      }
    default:
      return {
        type: "error",
        message:
          "local shell supports on, off, status, add <path>, rm <path>, full-access <on|off>",
      }
  }
}

export const parseSlashCommand = (line: string): SlashCommand => {
  if (!line.startsWith("/")) return { type: "message", text: line }

  const [command, rest] = splitCommand(line)
  switch (command) {
    case "/help":
      return { type: "help" }
    case "/threads":
      return { type: "threads" }
    case "/new":
      return { type: "new-thread" }
    case "/switch":
      if (rest.length === 0) {
        return { type: "error", message: "/switch requires a thread id" }
      }
      return { type: "switch-thread", threadId: rest }
    case "/interrupt":
      return { type: "interrupt" }
    case "/quit":
    case "/exit":
      return { type: "quit" }
    case "/local-shell":
      return parseLocalShell(rest)
    default:
      return { type: "error", message: `unknown slash command: ${command}` }
  }
}
