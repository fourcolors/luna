/**
 * updates-store.ts - pure state/reducer for the Updates settings panel,
 * ported from frontend/panels/settings-updates.js's module-scope `state`
 * object and its `applyState` (UpdateStateDto snapshot replay) /
 * `applyEvent` (per `update://*` Tauri event) folding functions.
 *
 * WHY a store here (contrast with SettingsGeneralPanel.tsx's plain
 * useState): this panel's state is entirely transport-driven - the Rust
 * UpdateManager is the sole source of truth and drives every transition via
 * `update://*` events plus one replay-on-open `update_state` snapshot. The
 * vanilla module funneled both into one `render()` projection; this store is
 * that same fold, kept as a pure `(state, action) => state` reducer so it is
 * unit-testable with no DOM/React involved (mirrors voice-store.ts) - see
 * apps/ui-moon-tauri/test/settings-updates-panel.test.tsx's `updatesReduce`
 * describe block.
 *
 * The once-per-version "auto-advance a manually-discovered update into the
 * staged download" guard (`kickedVersion` in the vanilla module) is NOT
 * reducer state - it is a call-triggering side effect, not a view
 * projection, so it stays a ref in UpdatesPanel.tsx (see that file's doc
 * comment), exactly the same split VoicePanel.tsx makes for its own
 * transport subscriptions.
 */

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "verifying" | "ready" | "error"

// Mirrors UpdateStateDto.phase in the Rust UpdateManager. "verifying" is an
// optional transient between download-finish and ready; treated as a
// downloading-tail so the bar/labels stay coherent (see phaseShowsProgress).
export const UPDATE_PHASES: readonly UpdatePhase[] = [
  "idle",
  "checking",
  "available",
  "downloading",
  "verifying",
  "ready",
  "error",
]

export function isUpdatePhase(value: string): value is UpdatePhase {
  return (UPDATE_PHASES as readonly string[]).includes(value)
}

// Per-phase status-pill copy. Updates read as positive; "error" is the only
// muted case and still avoids alarm language (never red - see UpdatesPanel).
export const PHASE_PILL: Record<UpdatePhase, string> = {
  idle: "Up to date",
  checking: "Checking…",
  available: "Update found",
  downloading: "Downloading…",
  verifying: "Verifying…",
  ready: "Ready to update",
  error: "Couldn't check",
}

export interface UpdateState {
  readonly phase: UpdatePhase
  /** The running build's version, stamped only by the replay snapshot. */
  readonly currentVersion: string | null
  readonly version: string | null
  readonly notes: string | null
  readonly downloaded: number
  readonly total: number | null
  readonly errorMessage: string
}

export const initialUpdateState: UpdateState = {
  phase: "idle",
  currentVersion: null,
  version: null,
  notes: null,
  downloaded: 0,
  total: null,
  errorMessage: "",
}

export const UPDATE_EVENT_NAMES = [
  "update://checking",
  "update://available",
  "update://progress",
  "update://verifying",
  "update://ready",
  "update://none",
  "update://error",
] as const

export type UpdateEventName = (typeof UPDATE_EVENT_NAMES)[number]

/** Shape of the Rust UpdateManager's replay-on-open snapshot (`update_state`). */
export interface UpdateStateDto {
  readonly current?: string | null
  readonly phase?: string | null
  readonly version?: string | null
  readonly notes?: string | null
  readonly downloaded?: number | null
  readonly total?: number | null
}

export type UpdateAction =
  | { readonly type: "event"; readonly name: UpdateEventName; readonly payload?: Record<string, unknown> }
  | { readonly type: "snapshot"; readonly dto: UpdateStateDto }
  /** Optimistic transition fired by the "Check for updates" click, before the
   *  invoke("check_for_update") promise settles - mirrors the vanilla
   *  handler setting `state.phase = 'checking'` before it awaits. */
  | { readonly type: "check-started" }
  /** check_for_update resolved with an UpdateInfo - only applied by the
   *  caller when the live phase is still "checking" (events may have
   *  already moved it past that; see UpdatesPanel.tsx). */
  | { readonly type: "check-found"; readonly version: string; readonly notes: string | null }
  /** check_for_update resolved with nothing - only applied while checking. */
  | { readonly type: "check-empty" }
  /** check_for_update rejected - only applied while checking. */
  | { readonly type: "check-failed"; readonly message: string }
  /** apply_update rejected (it never returns on success - the app relaunches). */
  | { readonly type: "restart-failed"; readonly message: string }

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

export function updatesReduce(state: UpdateState, action: UpdateAction): UpdateState {
  switch (action.type) {
    case "event":
      return applyEvent(state, action.name, action.payload ?? {})
    case "snapshot":
      return applySnapshot(state, action.dto)
    case "check-started":
      return { ...state, phase: "checking" }
    case "check-found":
      return state.phase === "checking"
        ? { ...state, phase: "available", version: action.version, notes: action.notes }
        : state
    case "check-empty":
      return state.phase === "checking" ? { ...state, phase: "idle" } : state
    case "check-failed":
      return state.phase === "checking" ? { ...state, phase: "error", errorMessage: action.message } : state
    case "restart-failed":
      return { ...state, phase: "error", errorMessage: action.message }
    default:
      return state
  }
}

function applyEvent(state: UpdateState, name: UpdateEventName, payload: Record<string, unknown>): UpdateState {
  switch (name) {
    case "update://checking":
      return { ...state, phase: "checking", errorMessage: "" }
    case "update://available":
      return {
        ...state,
        phase: "available",
        version: payload["version"] != null ? String(payload["version"]) : state.version,
        notes: payload["notes"] != null ? String(payload["notes"]) : null,
      }
    case "update://progress":
      return {
        ...state,
        phase: "downloading",
        downloaded: isFiniteNumber(payload["downloaded"]) ? payload["downloaded"] : state.downloaded,
        total: isFiniteNumber(payload["total"]) ? payload["total"] : null,
      }
    case "update://verifying":
      return { ...state, phase: "verifying" }
    case "update://ready":
      return {
        ...state,
        phase: "ready",
        version: payload["version"] != null ? String(payload["version"]) : state.version,
        notes: payload["notes"] != null ? String(payload["notes"]) : state.notes,
      }
    case "update://none":
      return { ...state, phase: "idle" }
    case "update://error":
      return { ...state, phase: "error", errorMessage: payload["message"] ? String(payload["message"]) : "Update check failed." }
    default:
      return state
  }
}

function applySnapshot(state: UpdateState, dto: UpdateStateDto): UpdateState {
  let next = state
  if (typeof dto.current === "string" && dto.current) {
    next = { ...next, currentVersion: dto.current }
  }
  if (typeof dto.phase === "string" && isUpdatePhase(dto.phase)) {
    next = { ...next, phase: dto.phase }
  }
  if ("version" in dto) {
    next = { ...next, version: dto.version != null ? String(dto.version) : null }
  }
  if ("notes" in dto) {
    next = { ...next, notes: dto.notes != null ? String(dto.notes) : null }
  }
  if (isFiniteNumber(dto.downloaded)) {
    next = { ...next, downloaded: dto.downloaded }
  }
  if (dto.total == null) {
    if ("total" in dto) next = { ...next, total: null }
  } else if (isFiniteNumber(dto.total)) {
    next = { ...next, total: dto.total }
  }
  return next
}

// ── Pure view-projection helpers (shared by UpdatesPanel.tsx + tests) ──────

/** MB formatter, byte-identical to the vanilla module's `mb()` helper. */
export function formatMb(bytes: number): string {
  return (Number(bytes) / (1024 * 1024)).toFixed(1)
}

/** Phases that show the card (any phase that knows a target version). */
export function phaseHasCard(phase: UpdatePhase): boolean {
  return phase === "available" || phase === "downloading" || phase === "verifying" || phase === "ready"
}

/** Phases that show the progress section. */
export function phaseShowsProgress(phase: UpdatePhase): boolean {
  return phase === "downloading" || phase === "verifying" || phase === "ready"
}

/** 0-100 download percent, mirrors the vanilla module's render() math. */
export function progressPercent(state: UpdateState): number {
  if (state.phase === "ready") return 100
  if (state.total && state.total > 0) {
    return Math.max(0, Math.min(100, Math.round((state.downloaded / state.total) * 100)))
  }
  return 0
}

/** Bytes row text ("14.0 / 28.0 MB" or "3.0 MB" with no known total). */
export function progressBytesText(state: UpdateState): string {
  if (state.total && state.total > 0) {
    const shown = state.phase === "ready" ? state.total : state.downloaded
    return `${formatMb(shown)} / ${formatMb(state.total)} MB`
  }
  return `${formatMb(state.downloaded)} MB`
}

/** Release-notes lines: trimmed, blank-filtered, capped to 6 - mirrors renderNotes(). */
export function notesLines(notes: string | null): readonly string[] {
  return String(notes == null ? "" : notes)
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 6)
}
