/**
 * hubReducer.ts - pure state/reducer for the Moon hub's React port
 * (MoonHubApp.tsx et al), superseding the module-level `State` object and
 * every direct DOM write in the deleted frontend/index.html inline script.
 *
 * Framework-agnostic on purpose (no DOM, no React, no Tauri) so it is
 * trivially unit testable and so every consumer reads it via
 * useLocalStore/useMoonSelector (src/state/store.ts) instead of touching the
 * DOM from inside a WS frame handler or a Tauri event callback - a
 * transport/engine callback's entire job is to call `store.dispatch(...)`;
 * only the JSX in MoonOrb.tsx/SetupWizardPanel.tsx reads state and decides
 * what appears on screen. Mirrors the AgentsPanel/agentsReducer.ts
 * convention already established in this codebase.
 *
 * This is the hub's OWN local state - it has no relationship to the shared
 * @luna/ui-shared UIState reducer (that reducer models thread/panel content
 * the hub never renders; the hub is hello-only, see hubEngines.ts's module
 * doc). Behavior ported 1:1 from the deleted vanilla `State` +
 * `WebSocketEngine` + `SetupWizard` objects.
 */

export type WizardStep = "welcome" | "path" | "local" | "remote" | "progress" | "connect" | "done"
export type ChosenPath = "local" | "remote" | "connect" | null
export type ConnStatus = "disconnected" | "connecting" | "connected" | "error" | "version-warning"
export type ConnectStatusKind = "" | "run" | "ok" | "fail"
export type VoiceVisualState = "" | "listening" | "transcribing" | "speaking"
export type TaskState = "" | "running" | "ok" | "fail"

export interface WizardTaskRow {
  readonly label: string
  readonly state: TaskState
  readonly note: string
}

// data-step -> progress-bead index; local/remote/progress share a bead (the
// same "set it up" stage of the journey). Ported verbatim from BEAD_FOR.
export const BEAD_FOR: Record<WizardStep, number> = {
  welcome: 0,
  path: 1,
  local: 2,
  remote: 2,
  progress: 2,
  connect: 3,
  done: 4,
}

export interface WizardState {
  readonly active: boolean
  readonly current: WizardStep
  readonly chosenPath: ChosenPath
  readonly running: boolean
  readonly ranInstall: boolean
  readonly autoTest: boolean
  readonly forceSave: boolean
  readonly openedMinimized: boolean

  readonly remoteHost: string
  readonly remoteCmd: string
  readonly remoteWsGuess: string
  readonly copyLabel: string

  readonly localDir: string
  readonly localDirInvalid: boolean

  readonly env: { readonly serverRunning: boolean; readonly repoExists: boolean }
  readonly detectNote: string | null

  readonly connectUrl: string
  readonly connectToken: string
  readonly connectStatusMsg: string
  readonly connectStatusKind: ConnectStatusKind

  readonly tasks: readonly WizardTaskRow[]
  readonly progressTitle: string
  readonly progressSub: string
  readonly progressLog: string
  readonly progressLogVisible: boolean
  readonly progressBackVisible: boolean
  readonly progressNextVisible: boolean

  readonly doneTitle: string
  readonly doneSummary: string
  readonly doneSetupVisible: boolean
}

export interface HubState {
  readonly connStatus: ConnStatus
  readonly needsInputCount: number
  readonly updatePipVisible: boolean
  /** Unread rows in the notification log (src/notifications/log.ts). */
  readonly notificationCount: number
  readonly voiceState: VoiceVisualState
  readonly voiceLevel: number
  readonly absorbing: boolean
  readonly wizard: WizardState
}

export function initialWizardState(): WizardState {
  return {
    active: false,
    current: "welcome",
    chosenPath: null,
    running: false,
    ranInstall: false,
    autoTest: false,
    forceSave: false,
    openedMinimized: false,
    remoteHost: "",
    remoteCmd: "",
    remoteWsGuess: "",
    copyLabel: "Copy",
    localDir: "~/luna",
    localDirInvalid: false,
    env: { serverRunning: false, repoExists: false },
    detectNote: null,
    connectUrl: "",
    connectToken: "",
    connectStatusMsg: "",
    connectStatusKind: "",
    tasks: [],
    progressTitle: "",
    progressSub: "",
    progressLog: "",
    progressLogVisible: false,
    progressBackVisible: false,
    progressNextVisible: false,
    doneTitle: "Luna is tethered",
    doneSummary: "Your moon has a home.",
    doneSetupVisible: false,
  }
}

export function initialHubState(): HubState {
  return {
    connStatus: "disconnected",
    needsInputCount: 0,
    updatePipVisible: false,
    notificationCount: 0,
    voiceState: "",
    voiceLevel: 0,
    absorbing: false,
    wizard: initialWizardState(),
  }
}

export type HubAction =
  | { readonly type: "conn-status"; readonly status: ConnStatus }
  | { readonly type: "needs-input-count"; readonly count: number }
  | { readonly type: "show-update-pip" }
  | { readonly type: "notification-count"; readonly count: number }
  | { readonly type: "voice-state"; readonly state: VoiceVisualState; readonly level: number | null }
  | { readonly type: "absorb-pulse" }
  | { readonly type: "absorb-settled" }
  // Wizard lifecycle
  | { readonly type: "wizard-open" }
  | { readonly type: "wizard-close" }
  | { readonly type: "wizard-goto"; readonly step: WizardStep }
  | { readonly type: "wizard-choose-path"; readonly path: ChosenPath }
  | { readonly type: "wizard-detected"; readonly env: { serverRunning: boolean; repoExists: boolean } }
  // connect step fields
  | { readonly type: "wizard-connect-url"; readonly value: string }
  | { readonly type: "wizard-connect-token"; readonly value: string }
  | { readonly type: "wizard-connect-status"; readonly msg: string; readonly kind: ConnectStatusKind }
  | { readonly type: "wizard-connect-prefill"; readonly value: string }
  | { readonly type: "wizard-reset-finish-guard" }
  | { readonly type: "wizard-force-save" }
  | { readonly type: "wizard-set-auto-test"; readonly value: boolean }
  | { readonly type: "wizard-ran-install"; readonly value: boolean }
  | {
      readonly type: "wizard-done"
      readonly title: string
      readonly summary: string
      readonly setupVisible: boolean
    }
  // remote step
  | { readonly type: "wizard-remote-host"; readonly value: string }
  | { readonly type: "wizard-remote-cmd"; readonly cmd: string; readonly wsGuess: string }
  | { readonly type: "wizard-copy-label"; readonly label: string }
  // local step
  | { readonly type: "wizard-local-dir"; readonly value: string }
  | { readonly type: "wizard-local-dir-invalid"; readonly value: boolean }
  // progress/install
  | { readonly type: "wizard-install-start"; readonly title: string; readonly sub: string; readonly labels: readonly string[] }
  | { readonly type: "wizard-task-set"; readonly index: number; readonly state: TaskState; readonly note: string }
  | { readonly type: "wizard-log-append"; readonly text: string }
  | { readonly type: "wizard-install-failed"; readonly title: string; readonly sub: string }
  | { readonly type: "wizard-install-succeeded"; readonly title: string; readonly sub: string }
  | { readonly type: "wizard-running"; readonly value: boolean }

export function reduceHub(state: HubState, action: HubAction): HubState {
  switch (action.type) {
    case "conn-status":
      return state.connStatus === action.status ? state : { ...state, connStatus: action.status }
    case "needs-input-count":
      return state.needsInputCount === action.count ? state : { ...state, needsInputCount: action.count }
    case "show-update-pip":
      return state.updatePipVisible ? state : { ...state, updatePipVisible: true }
    case "notification-count": {
      const count = Math.max(0, action.count)
      return state.notificationCount === count ? state : { ...state, notificationCount: count }
    }
    case "voice-state":
      return {
        ...state,
        voiceState: action.state,
        voiceLevel: action.state === "listening" && action.level !== null
          ? Math.max(0, Math.min(1, action.level))
          : 0,
      }
    case "absorb-pulse":
      return { ...state, absorbing: true }
    case "absorb-settled":
      return state.absorbing ? { ...state, absorbing: false } : state
    case "wizard-open":
      return {
        ...state,
        wizard: {
          ...state.wizard,
          active: true,
          openedMinimized: true,
          current: "welcome",
          ranInstall: false,
        },
      }
    case "wizard-close":
      return { ...state, wizard: { ...state.wizard, active: false, openedMinimized: false } }
    case "wizard-goto":
      return state.wizard.current === action.step && state.wizard.active
        ? state
        : { ...state, wizard: { ...state.wizard, current: action.step } }
    case "wizard-choose-path":
      return { ...state, wizard: { ...state.wizard, chosenPath: action.path } }
    case "wizard-detected":
      return { ...state, wizard: { ...state.wizard, env: action.env } }
    case "wizard-connect-url":
      return { ...state, wizard: { ...state.wizard, connectUrl: action.value } }
    case "wizard-connect-token":
      return { ...state, wizard: { ...state.wizard, connectToken: action.value } }
    case "wizard-connect-status":
      return {
        ...state,
        wizard: { ...state.wizard, connectStatusMsg: action.msg, connectStatusKind: action.kind },
      }
    case "wizard-connect-prefill":
      return state.wizard.connectUrl.trim()
        ? state
        : { ...state, wizard: { ...state.wizard, connectUrl: action.value } }
    case "wizard-reset-finish-guard":
      return state.wizard.forceSave ? { ...state, wizard: { ...state.wizard, forceSave: false } } : state
    case "wizard-force-save":
      return { ...state, wizard: { ...state.wizard, forceSave: true } }
    case "wizard-set-auto-test":
      return { ...state, wizard: { ...state.wizard, autoTest: action.value } }
    case "wizard-ran-install":
      return { ...state, wizard: { ...state.wizard, ranInstall: action.value } }
    case "wizard-done":
      return {
        ...state,
        wizard: {
          ...state.wizard,
          doneTitle: action.title,
          doneSummary: action.summary,
          doneSetupVisible: action.setupVisible,
        },
      }
    case "wizard-remote-host":
      return { ...state, wizard: { ...state.wizard, remoteHost: action.value } }
    case "wizard-remote-cmd":
      return { ...state, wizard: { ...state.wizard, remoteCmd: action.cmd, remoteWsGuess: action.wsGuess } }
    case "wizard-copy-label":
      return { ...state, wizard: { ...state.wizard, copyLabel: action.label } }
    case "wizard-local-dir":
      return { ...state, wizard: { ...state.wizard, localDir: action.value } }
    case "wizard-local-dir-invalid":
      return { ...state, wizard: { ...state.wizard, localDirInvalid: action.value } }
    case "wizard-install-start":
      return {
        ...state,
        wizard: {
          ...state.wizard,
          running: true,
          ranInstall: true,
          progressTitle: action.title,
          progressSub: action.sub,
          progressLog: "",
          progressLogVisible: false,
          progressBackVisible: false,
          progressNextVisible: false,
          tasks: action.labels.map((label) => ({ label, state: "", note: "" })),
        },
      }
    case "wizard-task-set":
      return {
        ...state,
        wizard: {
          ...state.wizard,
          tasks: state.wizard.tasks.map((row, i) =>
            i === action.index ? { ...row, state: action.state, note: action.note } : row,
          ),
        },
      }
    case "wizard-log-append": {
      const t = action.text.trim()
      if (!t) return state
      return {
        ...state,
        wizard: {
          ...state.wizard,
          progressLogVisible: true,
          progressLog: state.wizard.progressLog + t + "\n",
        },
      }
    }
    case "wizard-install-failed":
      return {
        ...state,
        wizard: {
          ...state.wizard,
          running: false,
          progressTitle: action.title,
          progressSub: action.sub,
          progressBackVisible: true,
        },
      }
    case "wizard-install-succeeded":
      return {
        ...state,
        wizard: {
          ...state.wizard,
          running: false,
          progressTitle: action.title,
          progressSub: action.sub,
          progressNextVisible: true,
        },
      }
    case "wizard-running":
      return { ...state, wizard: { ...state.wizard, running: action.value } }
    default:
      return state
  }
}
