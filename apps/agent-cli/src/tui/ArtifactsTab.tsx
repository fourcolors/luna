import { For, Show } from "solid-js"
import type { Artifact } from "@luna/chat-service"
import type { TuiStore } from "./store.js"

const summarize = (artifact: Artifact): string => {
  if (artifact.source === "tool-write" && artifact.path !== null) {
    return `${artifact.title} — ${artifact.path}`
  }
  if (artifact.lang !== null) return `${artifact.title} [${artifact.lang}]`
  return artifact.title
}

export type ArtifactsTabProps = {
  store: TuiStore
}

export const ArtifactsTab = (props: ArtifactsTabProps) => {
  const items = (): readonly Artifact[] => {
    const tid = props.store.threadId()
    if (tid === null) return []
    return props.store.artifactsByThread().get(tid) ?? []
  }
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <Show when={items().length === 0}>
        <text>(no artifacts yet)</text>
      </Show>
      <For each={items()}>
        {(a) => <text>{summarize(a)}</text>}
      </For>
    </box>
  )
}
