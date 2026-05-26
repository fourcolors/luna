import { createSignal } from "solid-js"
import {
  type ContextTab,
  type FrameRingEntry,
  type MemorySearchState,
  type ArtifactsByThread,
  cycleContextTab,
  FRAME_RING_CAPACITY,
} from "./panel-types.js"
import type { ServerFrame } from "@luna/ui-ws"
import type { Artifact } from "@luna/chat-service"

export type ChatMessage = {
  readonly role: "user" | "assistant"
  readonly text: string
  readonly turnId?: string
  readonly done?: boolean
}

export type ConnectionState = "connecting" | "up" | "down" | "fatal"

export const createTuiStore = () => {
  const [messages, setMessages] = createSignal<ChatMessage[]>([])
  const [threadId, setThreadId] = createSignal<string | null>(null)
  const [connection, setConnection] = createSignal<ConnectionState>("connecting")
  const [profileName, setProfileName] = createSignal<string>("stable")
  const [localShellEnabled, setLocalShellEnabled] = createSignal<boolean>(false)
  const [inputDraft, setInputDraft] = createSignal<string>("")
  const [fatalReason, setFatalReason] = createSignal<string | null>(null)
  const [contextPanelTab, setContextPanelTab] = createSignal<ContextTab>("memories")
  const [lastUserMessage, setLastUserMessage] = createSignal<string>("")
  const [rawFrames, setRawFrames] = createSignal<readonly FrameRingEntry[]>([])
  const [memorySearch, setMemorySearch] = createSignal<MemorySearchState>({ status: "idle" })
  const [artifactsByThread, setArtifactsByThread] = createSignal<ArtifactsByThread>(new Map())

  const appendUser = (text: string) => {
    setMessages((m) => [...m, { role: "user", text }])
  }

  const upsertAssistant = (turnId: string, text: string, done = false) => {
    setMessages((m) => {
      const existing = m.findIndex((msg) => msg.role === "assistant" && msg.turnId === turnId)
      if (existing === -1) return [...m, { role: "assistant", text, turnId, done }]
      const updated = [...m]
      const entry = updated[existing]
      if (entry !== undefined) {
        updated[existing] = { role: "assistant", text, turnId, done }
      }
      return updated
    })
  }

  const cycleContextPanelTab = (): void => {
    setContextPanelTab((curr) => cycleContextTab(curr))
  }

  const pushRawFrame = (frame: ServerFrame): void => {
    setRawFrames((curr) => {
      const next = [...curr, { receivedAt: Date.now(), frame }]
      return next.length > FRAME_RING_CAPACITY
        ? next.slice(next.length - FRAME_RING_CAPACITY)
        : next
    })
  }

  const setArtifactsForThread = (threadId: string, artifacts: readonly Artifact[]): void => {
    setArtifactsByThread((curr) => {
      const next = new Map(curr)
      next.set(threadId, artifacts)
      return next
    })
  }

  return {
    messages, setMessages, appendUser, upsertAssistant,
    threadId, setThreadId,
    connection, setConnection,
    profileName, setProfileName,
    localShellEnabled, setLocalShellEnabled,
    inputDraft, setInputDraft,
    fatalReason, setFatalReason,
    contextPanelTab, setContextPanelTab, cycleContextPanelTab,
    lastUserMessage, setLastUserMessage,
    rawFrames, pushRawFrame,
    memorySearch, setMemorySearch,
    artifactsByThread, setArtifactsForThread,
  }
}

export type TuiStore = ReturnType<typeof createTuiStore>
