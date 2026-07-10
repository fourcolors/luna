import type { SessionSummary, ThreadView } from "@luna/ui-shared/core"
import type { StudioStatus, StudioThread, StudioMsg } from "./useLunaData"

const WASHES = [
  "var(--wash-0)",
  "var(--wash-1)",
  "var(--wash-2)",
  "var(--wash-3)",
  "var(--wash-4)",
] as const

/** Stable tint per thread id (deterministic hash to palette wash). */
function tintFor(id: string): string {
  let hash = 0
  for (let index = 0; index < id.length; index++) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0
  }
  return WASHES[Math.abs(hash) % WASHES.length] ?? "var(--wash-2)"
}

export const SYSTEM_THREAD_TAG = "system"

export function isSystemThread(summary: SessionSummary): boolean {
  return summary.tags.includes(SYSTEM_THREAD_TAG)
}

function projectThread(
  summary: SessionSummary,
  view: ThreadView | undefined,
  selectedId: string | null,
): StudioThread {
  const awaiting = view?.inFlight != null
  const messages: StudioMsg[] = (view?.messages ?? []).map((message) => ({
    who: message.role === "assistant" ? "luna" : "user",
    text: message.text,
  }))
  if (view?.inFlight?.text) messages.push({ who: "luna", text: view.inFlight.text })

  const status: StudioStatus = awaiting
    ? "running"
    : summary.id === selectedId
      ? "active"
      : "quiet"

  return {
    id: summary.id,
    name: summary.title ?? "new thread",
    tint: tintFor(summary.id),
    brain: "luna",
    status,
    note: summary.lastMessagePreview ?? "",
    msgs: messages,
    awaiting,
  }
}

export function projectStudioThreads(
  summaries: ReadonlyArray<SessionSummary>,
  views: ReadonlyMap<string, ThreadView>,
  selectedId: string | null,
): StudioThread[] {
  return summaries
    .filter((summary) => !isSystemThread(summary))
    .map((summary) => projectThread(summary, views.get(summary.id), selectedId))
}
