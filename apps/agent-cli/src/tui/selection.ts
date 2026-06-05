/**
 * selection.ts — terminal-native selection mode for the TUI.
 *
 * OpenTUI captures mouse events for click-to-focus + scroll-wheel, which
 * also blocks the terminal emulator's native drag-to-select-text path.
 * "Selection mode" turns mouse capture off so the operator can highlight
 * text and copy it with their terminal's normal binding (Cmd-C on macOS,
 * Ctrl-Shift-C on Linux, etc).
 *
 * This module owns the *pure* state-transition logic. The IO side — flipping
 * `renderer.useMouse` on the OpenTUI renderer — lives in mount.ts where the
 * renderer reference is in scope.
 */

export type SelectionMode = boolean

export type SelectionAction = "on" | "off" | "toggle"

export type SelectionTransition = {
  /** Whether selection mode is active *after* the transition. */
  readonly next: SelectionMode
  /** Whether anything actually changed (used to suppress redundant noise). */
  readonly changed: boolean
}

export const applySelection = (
  current: SelectionMode,
  action: SelectionAction,
): SelectionTransition => {
  const next =
    action === "toggle" ? !current : action === "on" ? true : false
  return { next, changed: next !== current }
}

/** Human-readable status line for the system message + StatusBar. */
export const describeSelection = (next: SelectionMode): string =>
  next
    ? "selection mode: on — drag to highlight, terminal copies normally. /select off (or F2) to resume mouse."
    : "selection mode: off — mouse interaction restored."
