import { useTerminalDimensions } from "@opentui/solid"
import type { TuiStore } from "./store.js"
import type { SlashCommand } from "./slash.js"
import { SLASH_COMMANDS } from "../chat/slash-registry.js"
import { Transcript } from "./Transcript.js"
import { SlashMenu } from "./SlashMenu.js"
import { Input } from "./Input.js"
import { StatusBar } from "./StatusBar.js"

export type AppProps = {
  store: TuiStore
  onSubmit: (text: string) => void
}

// Map the canonical slash registry (names carry a leading "/") to the
// SlashMenu's command shape (names without "/", help text).
const SLASH_MENU_COMMANDS: ReadonlyArray<SlashCommand> = SLASH_COMMANDS.map((c) => ({
  name: c.name.replace(/^\//, ""),
  help: c.argHint !== undefined ? `${c.argHint} — ${c.description}` : c.description,
}))

export const App = (props: AppProps) => {
  const dims = useTerminalDimensions()

  return (
    <box style={{ flexDirection: "column", width: dims().width, height: dims().height }}>
      <Transcript store={props.store} />
      <SlashMenu store={props.store} commands={SLASH_MENU_COMMANDS} />
      <Input store={props.store} onSubmit={props.onSubmit} />
      <StatusBar store={props.store} />
    </box>
  )
}
