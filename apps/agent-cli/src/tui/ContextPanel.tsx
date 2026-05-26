import { Show } from "solid-js"
import type { TuiStore } from "./store.js"
import { CONTEXT_TAB_LABEL, CONTEXT_TAB_ORDER, type ContextTab } from "./panel-types.js"

export type ContextPanelProps = {
  store: TuiStore
  width: number
  height: number
}

export const ContextPanel = (props: ContextPanelProps) => {
  const tabCount = (tab: ContextTab): number => {
    if (tab === "memories") {
      const state = props.store.memorySearch()
      return state.status === "ready" ? state.hits.length : 0
    }
    if (tab === "events") return props.store.rawFrames().length
    const threadId = props.store.threadId()
    if (threadId === null) return 0
    return props.store.artifactsByThread().get(threadId)?.length ?? 0
  }

  const renderHeader = () => {
    const active = props.store.contextPanelTab()
    return CONTEXT_TAB_ORDER.map((tab: ContextTab) => {
      const label = `${CONTEXT_TAB_LABEL[tab]} (${tabCount(tab)})`
      return tab === active ? `[${label}]` : ` ${label} `
    }).join("  ")
  }

  return (
    <box
      style={{
        flexDirection: "column",
        width: props.width,
        height: props.height,
        borderStyle: "single",
      }}
    >
      <box style={{ width: props.width - 2, padding: 1 }}>
        <text>{renderHeader()}</text>
      </box>
      <box style={{ flexDirection: "column", flexGrow: 1, width: props.width - 2, padding: 1 }}>
        <Show when={props.store.contextPanelTab() === "memories"}>
          <text>(memories tab — populated in Task 4)</text>
        </Show>
        <Show when={props.store.contextPanelTab() === "events"}>
          <text>(events tab — populated in Task 5)</text>
        </Show>
        <Show when={props.store.contextPanelTab() === "artifacts"}>
          <text>(artifacts tab — populated in Task 6)</text>
        </Show>
      </box>
    </box>
  )
}
