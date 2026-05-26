import { For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { KeyEvent } from "@opentui/core"
import type { TuiStore } from "./store.js"
import { ContextPanel } from "./ContextPanel.js"

export type AppProps = {
  store: TuiStore
  onSubmit: (text: string) => void
  onKey: (key: KeyEvent) => void
}

const PANEL_WIDTH = 40
const PANEL_MIN_TERM_WIDTH = 100

export const App = (props: AppProps) => {
  const dims = useTerminalDimensions()
  const showPanel = () => dims().width >= PANEL_MIN_TERM_WIDTH
  const chatWidth = () => (showPanel() ? dims().width - PANEL_WIDTH : dims().width)

  const formatStatus = () => {
    const id = props.store.threadId()
    const idStr = id === null ? "—" : id.slice(0, 8)
    return (
      props.store.profileName() +
      " • thread " +
      idStr +
      " • shell " +
      (props.store.localShellEnabled() ? "on" : "off") +
      " • " +
      props.store.connection() +
      " • tab " +
      props.store.contextPanelTab()
    )
  }

  return (
    <box style={{ flexDirection: "row", width: dims().width, height: dims().height }}>
      <box style={{ flexDirection: "column", width: chatWidth(), height: dims().height }}>
        <box style={{ flexDirection: "column", flexGrow: 1, width: chatWidth(), padding: 1 }}>
          <For each={props.store.messages()}>
            {(msg) => (
              <text>{(msg.role === "user" ? "you: " : "Luna: ") + msg.text}</text>
            )}
          </For>
        </box>
        <box style={{ borderStyle: "single", width: chatWidth(), height: 3, padding: 1 }}>
          <text>{"> " + props.store.inputDraft()}</text>
        </box>
        <box style={{ width: chatWidth(), padding: 1 }}>
          <text>{formatStatus()}</text>
        </box>
      </box>
      <Show when={showPanel()}>
        <ContextPanel store={props.store} width={PANEL_WIDTH} height={dims().height} />
      </Show>
    </box>
  )
}
