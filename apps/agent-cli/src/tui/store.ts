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
import type { PendingSurvey } from "@luna/core"

export type ConnectionState = "connecting" | "up" | "down" | "fatal"

export const createTuiStore = () => {
  const [timeline, setTimeline] = createSignal<Timeline>(emptyTimeline())
  const [threadId, setThreadId] = createSignal<string | null>(null)
  const [connection, setConnection] = createSignal<ConnectionState>("connecting")
  const [profileName, setProfileName] = createSignal<string>("stable")
  const [localShellEnabled, setLocalShellEnabled] = createSignal<boolean>(false)
  const [inputDraft, setInputDraft] = createSignal<string>("")
  const [fatalReason, setFatalReason] = createSignal<string | null>(null)
  /** Phase 3 D3: active survey check-in, or null when none is pending. */
  const [survey, setSurvey] = createSignal<PendingSurvey | null>(null)
  /**
   * #17 follow-up: terminal-native selection mode. When true, OpenTUI mouse
   * capture is disabled so the operator can drag-select text and copy it
   * with the terminal's own clipboard binding. Mouse-driven scroll stops
   * working while this is on; keyboard scroll still works.
   */
  const [selectionMode, setSelectionMode] = createSignal<boolean>(false)

  /**
   * Phase 3 D3 — exclusive-focus gate.
   * True when the chat input should be active (no survey modal open).
   * Drives the <Show> guard in App.tsx so Input is not mounted while a survey
   * owns keypress handling.
   */
  const chatInputActive = (): boolean => survey() === null

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
    survey, setSurvey,
    selectionMode, setSelectionMode,
    chatInputActive,
  }
}

export type TuiStore = ReturnType<typeof createTuiStore>
