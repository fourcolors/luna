/**
 * createUiStore — Solid port of the React useReducer pattern in
 * apps/ui-web/src/App.tsx.
 *
 * The reducer (`reduce`) and `initialState` come from
 * `@luna/ui-shared/core` — they are framework-agnostic and shared with
 * the React app. This module wraps them in Solid's `createStore` so
 * components can read fine-grained reactive slices without re-rendering
 * the whole tree on every frame.
 *
 * Returns:
 *  - `state`: Solid store proxy (read-only by convention)
 *  - `dispatch`: applies an Action via `reduce` and patches the store
 *  - `reset`: re-applies `initialState` (useful on disconnect/reconnect)
 *
 * Why `reconcile`: `reduce` returns a fresh immutable state object each
 * call. `reconcile` walks the new tree against the live store and
 * patches only changed nodes, preserving Solid's reactivity granularity.
 */
import { createStore, reconcile } from "solid-js/store"
import {
  initialState,
  reduce,
  type Action,
  type UIState,
} from "@luna/ui-shared/core"

export interface UiStoreHandle {
  readonly state: UIState
  readonly dispatch: (action: Action) => void
  readonly reset: () => void
}

export const createUiStore = (): UiStoreHandle => {
  const [state, setState] = createStore<UIState>(initialState)
  const dispatch = (action: Action): void => {
    setState(reconcile(reduce(state, action)))
  }
  const reset = (): void => {
    setState(reconcile(initialState))
  }
  return { state, dispatch, reset }
}
