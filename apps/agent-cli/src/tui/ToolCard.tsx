import { Show } from "solid-js"
import type { Block } from "./timeline.js"

export type ToolBlock = Extract<Block, { kind: "tool" }>
export type ToolCardProps = { block: ToolBlock }

const ARG_LIMIT = 50

const summarizeArgs = (input: unknown): string => {
  let s: string
  try {
    s = JSON.stringify(input)
  } catch {
    s = String(input)
  }
  if (s === undefined) s = ""
  return s.length > ARG_LIMIT ? s.slice(0, ARG_LIMIT - 1) + "…" : s
}

const glyphFor = (status: ToolBlock["status"]): string => {
  switch (status) {
    case "running":
      return "⏳"
    case "ok":
      return "✓"
    case "error":
      return "✗"
  }
}

export const ToolCard = (props: ToolCardProps) => {
  const header = () =>
    `⚙ ${props.block.name}(${summarizeArgs(props.block.input)}) ${glyphFor(props.block.status)}`

  return (
    <box style={{ flexDirection: "column" }}>
      <text>{header()}</text>
      <Show when={props.block.output !== undefined && props.block.output.length > 0}>
        <box style={{ paddingLeft: 2 }}>
          <text>
            <span style={{ dim: true }}>{props.block.output ?? ""}</span>
          </text>
        </box>
      </Show>
    </box>
  )
}
