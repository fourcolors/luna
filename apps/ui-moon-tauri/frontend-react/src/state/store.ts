/**
 * store.ts - Moon's React binding for the shared @luna/ui-shared reducer.
 *
 * Ported from apps/ui-web/src/data/useUiStore.ts (the proven pattern already
 * live in ui-web). The reducer stays the single state-transition
 * implementation; this file adds the imperative dispatch/getState surface
 * plus useMoonSelector for React consumers, wired through
 * useSyncExternalStore so React 19 concurrent rendering stays tear-free.
 *
 * SCOPE NOTE (scaffold phase): nothing in the vanilla Moon pages
 * (chat.html/panel.html/widget.html/index.html) dispatches into this store
 * yet - those pages keep running their existing hand-rolled WebSocketEngine /
 * PoolEngine / ThreadDrawerEngine state machines untouched (see
 * apps/ui-moon-tauri/frontend/chat.html). This store exists so the boot
 * layer (boot.tsx) can prove the wiring compiles and runs end-to-end inside
 * the new Vite/React pipeline ahead of the actual panel conversion, which
 * will progressively move panels onto this store instead of their own
 * bespoke `panels/*.js` state.
 */
import { useCallback, useRef, useSyncExternalStore } from "react"
import { reduce, initialState, type UIState, type Action } from "@luna/ui-shared/core"

type StoreListener = () => void

export interface MoonStore {
  readonly getState: () => UIState
  readonly dispatch: (action: Action) => void
  readonly subscribe: (listener: StoreListener) => () => void
}

export type MoonSelector<T> = (state: UIState) => T
export type MoonEquality<T> = (previous: T, next: T) => boolean

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

export function createMoonStore(seed: UIState = initialState): MoonStore {
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

export function useMoonStore(): MoonStore {
  const storeRef = useRef<MoonStore | null>(null)
  if (storeRef.current === null) storeRef.current = createMoonStore()
  return storeRef.current
}

/**
 * Select one reducer slice. Composite selectors can supply shallowEqual (or a
 * domain equality) so unrelated transitions preserve the prior snapshot.
 */
export function useMoonSelector<T>(
  store: MoonStore,
  selector: MoonSelector<T>,
  isEqual: MoonEquality<T> = Object.is,
): T {
  const cacheRef = useRef<{
    state: UIState
    selector: MoonSelector<T>
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
