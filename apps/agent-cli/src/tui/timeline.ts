export type Block =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly turnId: string; readonly text: string; readonly done: boolean }
  | {
      readonly kind: "tool"; readonly toolCallId: string; readonly name: string; readonly input: unknown
      readonly status: "running" | "ok" | "error"; readonly output?: string; readonly truncated?: boolean
    }

export type Timeline = ReadonlyArray<Block>
export const emptyTimeline = (): Timeline => []

export const applyUser = (t: Timeline, text: string): Timeline => [...t, { kind: "user", text }]

export const applyAssistantDelta = (t: Timeline, turnId: string, text: string): Timeline => {
  const i = t.findIndex((b) => b.kind === "assistant" && b.turnId === turnId)
  if (i === -1) return [...t, { kind: "assistant", turnId, text, done: false }]
  const next = [...t]
  next[i] = { kind: "assistant", turnId, text, done: false }
  return next
}

export const applyAssistantDone = (t: Timeline, turnId: string, text: string): Timeline => {
  const i = t.findIndex((b) => b.kind === "assistant" && b.turnId === turnId)
  if (i === -1) return [...t, { kind: "assistant", turnId, text, done: true }]
  const next = [...t]
  next[i] = { kind: "assistant", turnId, text, done: true }
  return next
}

export const applyToolCall = (
  t: Timeline,
  e: { toolCallId: string; name: string; input: unknown; turnId: string },
): Timeline => [
  ...t,
  { kind: "tool", toolCallId: e.toolCallId, name: e.name, input: e.input, status: "running" },
]

export const applyToolResult = (
  t: Timeline,
  e: { toolCallId: string; status: "ok" | "error"; output: string; truncated: boolean },
): Timeline => {
  const i = t.findIndex((b) => b.kind === "tool" && b.toolCallId === e.toolCallId)
  if (i === -1) return t
  const prev = t[i] as Extract<Block, { kind: "tool" }>
  const next = [...t]
  next[i] = { ...prev, status: e.status, output: e.output, truncated: e.truncated }
  return next
}
