import { For } from "solid-js"
import type { ServerFrame } from "@luna/ui-ws"
import type { TuiStore } from "./store.js"
import type { FrameRingEntry } from "./panel-types.js"

const formatTime = (ms: number): string => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const summarize = (f: ServerFrame): string => {
  switch (f.type) {
    case "assistant-delta":
    case "assistant-done":
      return `turn=${f.turnId.slice(0, 8)}`
    case "assistant-error":
      return `turn=${f.turnId?.slice(0, 8) ?? "null"}`
    case "thread-created":
      return `thread=${f.thread.id.slice(0, 8)}`
    case "thread-snapshot":
      return `thread=${f.threadId.slice(0, 8)} seq=${f.throughSeq}`
    case "user-accepted":
      return `thread=${f.threadId.slice(0, 8)} seq=${f.seq}`
    case "thread-list":
      return `count=${f.threads.length}`
    case "local-shell-request":
      return `req=${f.requestId.slice(0, 8)}`
    case "local-shell-status":
      return `enabled=${f.enabled} accepted=${f.accepted}`
    case "artifacts-extracted":
      return `thread=${f.threadId.slice(0, 8)} n=${f.artifacts.length}`
    case "drop":
      return `n=${f.n}`
    case "ping":
      return `ts=${f.ts}`
    case "event":
      return f.event.kind ?? "(event)"
    case "bye":
      return f.reason
    case "hello":
      return `v${f.protocolVersion}`
    case "account-list":
      return `n=${f.accounts.length}`
    default:
      return ""
  }
}

const formatEntry = (entry: FrameRingEntry): string => {
  return `${formatTime(entry.receivedAt)} ${entry.frame.type.padEnd(20)} ${summarize(entry.frame)}`
}

export type EventsTabProps = {
  store: TuiStore
}

export const EventsTab = (props: EventsTabProps) => {
  const reversed = () => [...props.store.rawFrames()].reverse()
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <For each={reversed()} fallback={<text>(no events yet)</text>}>
        {(entry) => <text>{formatEntry(entry)}</text>}
      </For>
    </box>
  )
}
