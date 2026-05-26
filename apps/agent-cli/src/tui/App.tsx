import { For } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { KeyEvent } from "@opentui/core"
import type { TuiStore } from "./store.js"

export type AppProps = {
  store: TuiStore
  onSubmit: (text: string) => void
  onKey: (key: KeyEvent) => void
}

export const App = (props: AppProps) => {
  const dims = useTerminalDimensions()

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
      props.store.connection()
    )
  }

  return (
    <box style={{ flexDirection: "column", width: dims().width, height: dims().height }}>
      <box style={{ flexDirection: "column", flexGrow: 1, width: dims().width, padding: 1 }}>
        <For each={props.store.messages()}>
          {(msg) => (
            <text>{(msg.role === "user" ? "you: " : "Luna: ") + msg.text}</text>
          )}
        </For>
      </box>
      <box style={{ borderStyle: "single", width: dims().width, height: 3, padding: 1 }}>
        <text>{"> " + props.store.inputDraft()}</text>
      </box>
      <box style={{ width: dims().width, padding: 1 }}>
        <text>{formatStatus()}</text>
      </box>
    </box>
  )
}
