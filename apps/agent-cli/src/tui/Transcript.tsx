import { For, Switch, Match } from "solid-js"
import type { TuiStore } from "./store.js"
import type { Block } from "./timeline.js"
import { AssistantBlock } from "./AssistantBlock.js"
import { ToolCard, type ToolBlock } from "./ToolCard.js"

export type TranscriptProps = { store: TuiStore }

export const Transcript = (props: TranscriptProps) => {
  return (
    <scrollbox stickyScroll stickyStart="bottom" style={{ flexGrow: 1 }}>
      <For each={props.store.timeline()}>
        {(block: Block) => (
          <Switch>
            <Match when={block.kind === "user"}>
              <text>{"you: " + (block as Extract<Block, { kind: "user" }>).text}</text>
            </Match>
            <Match when={block.kind === "assistant"}>
              <AssistantBlock text={(block as Extract<Block, { kind: "assistant" }>).text} />
            </Match>
            <Match when={block.kind === "tool"}>
              <ToolCard block={block as ToolBlock} />
            </Match>
          </Switch>
        )}
      </For>
    </scrollbox>
  )
}
