import type { ServerFrame } from "@luna/ui-ws"
import type { Artifact } from "@luna/chat-service"

export type ContextTab = "memories" | "events" | "artifacts"

export const CONTEXT_TAB_ORDER: readonly ContextTab[] = ["memories", "events", "artifacts"] as const

export const CONTEXT_TAB_LABEL: Readonly<Record<ContextTab, string>> = {
  memories: "Memories",
  events: "Events",
  artifacts: "Artifacts",
}

export const cycleContextTab = (current: ContextTab): ContextTab => {
  const idx = CONTEXT_TAB_ORDER.indexOf(current)
  return CONTEXT_TAB_ORDER[(idx + 1) % CONTEXT_TAB_ORDER.length] ?? "memories"
}

export const FRAME_RING_CAPACITY = 200

export type FrameRingEntry = {
  readonly receivedAt: number
  readonly frame: ServerFrame
}

export type MemorySearchHit = {
  readonly id: string
  readonly kind: string
  readonly content: string
  readonly score: number
}

export type MemorySearchState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly query: string }
  | { readonly status: "ready"; readonly query: string; readonly hits: readonly MemorySearchHit[] }
  | { readonly status: "error"; readonly query: string; readonly message: string }

export type ArtifactsByThread = ReadonlyMap<string, readonly Artifact[]>
