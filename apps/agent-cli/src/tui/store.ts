import { createSignal } from "solid-js"
import {
  type Timeline,
  emptyTimeline,
  applyUser,
  applyAssistantDelta,
  applyAssistantDone,
  applyToolCall,
  applyToolResult,
} from "./timeline.js"

export type ConnectionState = "connecting" | "up" | "down" | "fatal"

export const createTuiStore = () => {
  const [timeline, setTimeline] = createSignal<Timeline>(emptyTimeline())
  const [threadId, setThreadId] = createSignal<string | null>(null)
  const [connection, setConnection] = createSignal<ConnectionState>("connecting")
  const [profileName, setProfileName] = createSignal<string>("stable")
  const [localShellEnabled, setLocalShellEnabled] = createSignal<boolean>(false)
  const [inputDraft, setInputDraft] = createSignal<string>("")
  const [fatalReason, setFatalReason] = createSignal<string | null>(null)

  // Counter used to mint synthetic turn ids for system/error lines so they each
  // become their own assistant-style block in the transcript.
  let systemSeq = 0

  const appendUser = (text: string): void => {
    setTimeline((t) => applyUser(t, text))
  }

  const onAssistantDelta = (turnId: string, text: string): void => {
    setTimeline((t) => applyAssistantDelta(t, turnId, text))
  }

  const onAssistantDone = (turnId: string, text: string): void => {
    setTimeline((t) => applyAssistantDone(t, turnId, text))
  }

  const onToolCall = (e: {
    toolCallId: string
    name: string
    input: unknown
    turnId: string
  }): void => {
    setTimeline((t) => applyToolCall(t, e))
  }

  const onToolResult = (e: {
    toolCallId: string
    status: "ok" | "error"
    output: string
    truncated: boolean
  }): void => {
    setTimeline((t) => applyToolResult(t, e))
  }

  const appendSystem = (text: string): void => {
    systemSeq += 1
    setTimeline((t) => applyAssistantDone(t, `system-${systemSeq}`, text))
  }

  return {
    timeline, setTimeline,
    appendUser,
    onAssistantDelta, onAssistantDone,
    onToolCall, onToolResult,
    appendSystem,
    threadId, setThreadId,
    connection, setConnection,
    profileName, setProfileName,
    localShellEnabled, setLocalShellEnabled,
    inputDraft, setInputDraft,
    fatalReason, setFatalReason,
  }
}

export type TuiStore = ReturnType<typeof createTuiStore>
