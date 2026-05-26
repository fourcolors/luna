import { For, Match, Switch } from "solid-js"
import type { TuiStore } from "./store.js"
import type { MemorySearchHit } from "./panel-types.js"

export type MemoriesTabProps = {
  store: TuiStore
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 1) + "…"

const formatHit = (hit: MemorySearchHit): string => {
  const score = hit.score.toFixed(2)
  return `${hit.kind} (${score}) ${truncate(hit.content.replace(/\s+/g, " "), 80)}`
}

export const MemoriesTab = (props: MemoriesTabProps) => {
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <Switch>
        <Match when={props.store.memorySearch().status === "idle"}>
          <text>(send a message to search memories)</text>
        </Match>
        <Match when={props.store.memorySearch().status === "loading"}>
          <text>searching memories…</text>
        </Match>
        <Match when={props.store.memorySearch().status === "ready"}>
          {(() => {
            const state = props.store.memorySearch()
            if (state.status !== "ready") return <></>
            if (state.hits.length === 0) return <text>(no memories found)</text>
            return (
              <For each={state.hits}>
                {(hit) => <text>{formatHit(hit)}</text>}
              </For>
            )
          })()}
        </Match>
        <Match when={props.store.memorySearch().status === "error"}>
          {(() => {
            const state = props.store.memorySearch()
            if (state.status !== "error") return <></>
            return <text>error: {state.message}</text>
          })()}
        </Match>
      </Switch>
    </box>
  )
}
