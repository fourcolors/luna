import { For, Show } from "solid-js"
import type { TuiStore } from "./store.js"
import { slashState, type SlashCommand } from "./slash.js"

export type SlashMenuProps = {
  store: TuiStore
  commands: ReadonlyArray<SlashCommand>
}

export const SlashMenu = (props: SlashMenuProps) => {
  const state = () => slashState(props.store.inputDraft(), props.commands)

  return (
    <Show when={state().active && state().matches.length > 0}>
      <box style={{ flexDirection: "column", borderStyle: "single", flexShrink: 0 }}>
        <For each={state().matches}>
          {(cmd, i) => (
            <text>
              <span style={{ bold: i() === 0 }}>{`/${cmd.name}`}</span>
              <span style={{ dim: true }}>{`  ${cmd.help}`}</span>
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}
