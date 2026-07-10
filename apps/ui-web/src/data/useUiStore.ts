/**
 * Selector-capable UI store for the web client.
 *
 * The reducer remains the single state transition implementation. The store
 * adds a deep interface around it: imperative dispatch/getState for transport
 * and lifecycle code, plus useUiSelector for React consumers. A consumer is
 * notified for every transition but React only rerenders it when its selected
 * snapshot changes by Object.is.
 */
import { useCallback, useRef, useSyncExternalStore } from "react"
import { reduce, initialState, type UIState, type Action } from "@luna/ui-shared/core"

type StoreListener = () => void

export interface UiStore {
  readonly getState: () => UIState
  readonly dispatch: (action: Action) => void
  readonly subscribe: (listener: StoreListener) => () => void
}

export type UiSelector<T> = (state: UIState) => T
export type UiEquality<T> = (previous: T, next: T) => boolean

export function shallowEqual<T>(previous: T, next: T): boolean {
  if (Object.is(previous, next)) return true
  if (
    previous === null || next === null ||
    typeof previous !== "object" || typeof next !== "object"
  ) return false
  const previousKeys = Object.keys(previous)
  const nextKeys = Object.keys(next)
  return previousKeys.length === nextKeys.length && previousKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(next, key) &&
      Object.is(previous[key as keyof T], next[key as keyof T]),
  )
}

export function createUiStore(seed: UIState = initialState): UiStore {
  let state = seed
  const listeners = new Set<StoreListener>()

  const getState = (): UIState => state
  const dispatch = (action: Action): void => {
    const next = reduce(state, action)
    if (Object.is(next, state)) return
    state = next
    listeners.forEach((listener) => listener())
  }
  const subscribe = (listener: StoreListener): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { getState, dispatch, subscribe }
}

export function useUiStore(): UiStore {
  const storeRef = useRef<UiStore | null>(null)
  if (storeRef.current === null) storeRef.current = createUiStore()
  return storeRef.current
}

/**
 * Select one reducer slice. Composite selectors can supply shallowEqual (or a
 * domain equality) so unrelated transitions preserve the prior snapshot.
 */
export function useUiSelector<T>(
  store: UiStore,
  selector: UiSelector<T>,
  isEqual: UiEquality<T> = Object.is,
): T {
  const cacheRef = useRef<{
    state: UIState
    selector: UiSelector<T>
    selection: T
  } | null>(null)
  const getSnapshot = useCallback(
    (): T => {
      const state = store.getState()
      const cached = cacheRef.current
      if (cached !== null && cached.state === state && cached.selector === selector) {
        return cached.selection
      }
      const next = selector(state)
      if (cached !== null && isEqual(cached.selection, next)) {
        cacheRef.current = { state, selector, selection: cached.selection }
        return cached.selection
      }
      cacheRef.current = { state, selector, selection: next }
      return next
    },
    [isEqual, selector, store],
  )
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}
