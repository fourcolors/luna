import { createSignal } from "solid-js"

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

  return {
    messages, setMessages, appendUser, upsertAssistant,
    threadId, setThreadId,
    connection, setConnection,
    profileName, setProfileName,
    localShellEnabled, setLocalShellEnabled,
    inputDraft, setInputDraft,
    fatalReason, setFatalReason,
  }
}

export type TuiStore = ReturnType<typeof createTuiStore>
