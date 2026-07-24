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

// Generic over state/action so panel-local reducers (e.g. the Agents panel's
// subagent-tree state, which has no business living in the shared
// @luna/ui-shared UIState) can reuse the exact same getState/dispatch/
// subscribe shape and the useMoonSelector hook below. Defaults keep every
// existing UIState-bound call site (boot.tsx, createMoonStore, useMoonStore)
// compiling unchanged.
export interface MoonStore<S = UIState, A = Action> {
  readonly getState: () => S
  readonly dispatch: (action: A) => void
  readonly subscribe: (listener: StoreListener) => () => void
}

export type MoonSelector<S, T> = (state: S) => T
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

/**
 * Generic external-store factory: wraps any pure `(state, action) => state`
 * reducer in the getState/dispatch/subscribe shape useSyncExternalStore
 * needs. createMoonStore below is this specialized to the shared
 * @luna/ui-shared reducer; panel-local state calls it directly with its own
 * reducer instead (see useLocalStore, and src/panels/agents/agentsReducer.ts
 * for the first consumer).
 */
export function createStore<S, A>(
  reducer: (state: S, action: A) => S,
  seed: S,
): MoonStore<S, A> {
  let state = seed
  const listeners = new Set<StoreListener>()

  const getState = (): S => state
  const dispatch = (action: A): void => {
    const next = reducer(state, action)
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

export function createMoonStore(seed: UIState = initialState): MoonStore<UIState, Action> {
  return createStore(reduce, seed)
}

export function useMoonStore(): MoonStore<UIState, Action> {
  const storeRef = useRef<MoonStore<UIState, Action> | null>(null)
  if (storeRef.current === null) storeRef.current = createMoonStore()
  return storeRef.current
}

/**
 * Panel-local equivalent of useMoonStore: creates one store per component
 * instance (via the same lazy-ref-init pattern) from a caller-supplied
 * reducer, instead of always binding to the shared UIState reducer. The
 * store is stable for the component's mounted lifetime.
 */
export function useLocalStore<S, A>(
  reducer: (state: S, action: A) => S,
  initial: S,
): MoonStore<S, A> {
  const storeRef = useRef<MoonStore<S, A> | null>(null)
  if (storeRef.current === null) storeRef.current = createStore(reducer, initial)
  return storeRef.current
}

/**
 * Select one reducer slice. Composite selectors can supply shallowEqual (or a
 * domain equality) so unrelated transitions preserve the prior snapshot.
 */
export function useMoonSelector<S, T>(
  store: MoonStore<S, any>,
  selector: MoonSelector<S, T>,
  isEqual: MoonEquality<T> = Object.is,
): T {
  const cacheRef = useRef<{
    state: S
    selector: MoonSelector<S, T>
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
