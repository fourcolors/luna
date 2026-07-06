/**
 * useUiStore — Luna's authoritative UI state machine.
 *
 * The reducer (`reduce` + `initialState`) from @luna/ui-shared/core was
 * ORIGINALLY written for React's useReducer (the Solid client wraps it in a
 * reconcile-patched store). So here it drops straight in: one useReducer, no
 * translation. Every server frame is dispatched as an Action; local UI
 * actions (select-thread, select-account) share the same dispatch.
 */
import { useReducer } from "react"
import { reduce, initialState, type UIState, type Action } from "@luna/ui-shared/core"

export interface UiStore {
  readonly state: UIState
  readonly dispatch: (action: Action) => void
}

export function useUiStore(): UiStore {
  const [state, dispatch] = useReducer(reduce, initialState)
  return { state, dispatch }
}
