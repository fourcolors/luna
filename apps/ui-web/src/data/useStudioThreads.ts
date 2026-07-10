import { useMemo } from "react"
import type { SessionSummary, ThreadView, UIState } from "@luna/ui-shared/core"
import { isSystemThread, projectStudioThreads } from "./studio-thread-projection"
import { useUiSelector, type UiStore } from "./useUiStore"

const sameReferences = <T>(previous: ReadonlyArray<T>, next: ReadonlyArray<T>): boolean =>
  previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]))
const selectThreadList = (state: UIState): ReadonlyArray<SessionSummary> =>
  state.threadList.filter((summary) => !isSystemThread(summary))
const selectThreadViews = (state: UIState): ReadonlyArray<ThreadView | undefined> =>
  state.threadList
    .filter((summary) => !isSystemThread(summary))
    .map((summary) => state.threads.get(summary.id))
const selectActiveThread = (state: UIState): string | null => state.selectedThreadId
const selectActiveThreadName = (state: UIState): string | undefined =>
  state.threadList.find((thread) => thread.id === state.selectedThreadId)?.title ?? undefined

export function useStudioThreads(store: UiStore) {
  const summaries = useUiSelector(store, selectThreadList, sameReferences)
  const views = useUiSelector(store, selectThreadViews, sameReferences)
  const activeThread = useUiSelector(store, selectActiveThread)
  const viewsById = useMemo(
    () => new Map(summaries.map((summary, index) => [summary.id, views[index]]).filter(
      (entry): entry is [string, ThreadView] => entry[1] !== undefined,
    )),
    [summaries, views],
  )
  const threads = useMemo(
    () => projectStudioThreads(summaries, viewsById, activeThread),
    [summaries, viewsById, activeThread],
  )
  return useMemo(() => ({ threads, activeThread }), [threads, activeThread])
}

export function useStudioActiveThreadName(store: UiStore): string | undefined {
  return useUiSelector(store, selectActiveThreadName)
}
