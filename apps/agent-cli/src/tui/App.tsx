import { For, Show } from "solid-js"
import type { KeyEvent } from "@opentui/core"
import type { TuiStore } from "./store.js"

export type AppProps = {
  store: TuiStore
  onSubmit: (text: string) => void
  onKey: (key: KeyEvent) => void
}

export const App = (props: AppProps) => {
  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      {/* Chat stream area */}
      <box style={{ flexDirection: "column", flexGrow: 1, padding: 1 }}>
        <For each={props.store.messages()}>
          {(msg) => (
            <box style={{ flexDirection: "column", marginBottom: 1 }}>
              <text>{(msg.role === "user" ? "you: " : "Luna: ") + msg.text}</text>
            </box>
          )}
        </For>
      </box>

      {/* Input box */}
      <box style={{ borderStyle: "single", padding: 1, height: 3 }}>
        <text>{"> " + props.store.inputDraft()}</text>
      </box>

      {/* Status footer */}
      <box style={{ flexDirection: "row", padding: 1 }}>
        <text>
          {props.store.profileName() +
            " • thread " +
            (props.store.threadId() ?? "—").slice(0, 8) +
            " • shell " +
            (props.store.localShellEnabled() ? "on" : "off") +
            " • " +
            props.store.connection()}
        </text>
      </box>

      <Show when={props.store.fatalReason() !== null}>
        <box style={{ borderStyle: "double", padding: 1 }}>
          <text>{"fatal: " + (props.store.fatalReason() ?? "")}</text>
        </box>
      </Show>
    </box>
  )
}
