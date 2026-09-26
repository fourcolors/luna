/**
 * voice-store.ts - pure state/reducer for the Voice settings panel, ported
 * from frontend/panels/settings-voice.js's module-scope `mode` / `voiceId` /
 * `silenceHangMs` / `available` vars and its imperative
 * markModelReady/markModelMissing/applyStatus DOM writers.
 *
 * STATE SOURCE (contrast with SettingsGeneralPanel.tsx, which legitimately
 * stays on plain useState): this panel's state is NOT purely local prefs -
 * `voice_status`/`voice_list_voices` invoke responses and the `voice-state`/
 * `voice-model-progress` Tauri EVENT callbacks (ctx.win.listen) are real
 * transport callbacks arriving on their own async schedule. The vanilla
 * module wrote straight into `modelStatus.textContent` etc. from inside
 * those callbacks; this store exists so every one of those callbacks
 * dispatches an action instead of touching the DOM, and VoicePanel.tsx reads
 * the result via useMoonSelector (src/state/store.ts) - the "future Moon
 * settings panel [that] needs transport-derived state...binds through the
 * store" case SettingsGeneralPanel.tsx's doc comment anticipates.
 *
 * Kept a plain `(state, action) => state` reducer (not React state) so every
 * transition is unit-testable with no DOM/React involved at all - see
 * apps/ui-moon-tauri/test/panel-voice.test.ts.
 */

import { formatMb } from "@luna/ui-shared/core"

export type VoiceMode = "off" | "ptt" | "auto"

const VOICE_MODES: readonly VoiceMode[] = ["off", "ptt", "auto"]

export function isVoiceMode(value: string): value is VoiceMode {
  return (VOICE_MODES as readonly string[]).includes(value)
}

export type TtsEngine = "system" | "fish"

const TTS_ENGINES: readonly TtsEngine[] = ["system", "fish"]

export function isTtsEngine(value: string): value is TtsEngine {
  return (TTS_ENGINES as readonly string[]).includes(value)
}

export interface VoiceOption {
  readonly id: string
  readonly name?: string
  readonly quality?: string
}

type VoiceModelStatus = "checking" | "ready" | "missing" | "downloading" | "error"

interface VoiceProgress {
  readonly downloadedBytes: number
  readonly totalBytes: number
}

export interface VoiceState {
  /** Resolved once voice_status settles (true) or rejects (false). */
  readonly available: boolean
  /** True once the initial voice_status probe has settled either way -
   *  gates the "Voice unavailable" notice so it never flashes before the
   *  probe resolves (mirrors the vanilla notice's `hidden = true` default). */
  readonly probeDone: boolean
  readonly mode: VoiceMode
  readonly speakReplies: boolean
  /** Active speech engine: "system" (platform) or "fish" (Fish Audio). */
  readonly ttsEngine: TtsEngine
  /** Backend reports a Fish API key is on file (never the key itself). */
  readonly fishKeyConfigured: boolean
  readonly voiceId: string
  /** Selected voice id on the fish engine (luna_voice_fish_id); kept
   *  separate from voiceId so per-engine picks survive engine switches. */
  readonly fishVoiceId: string
  /** Committed value - what has been persisted + sent to voice_set_config. */
  readonly silenceHangMs: number
  /** Live value while the slider is being dragged, pre-commit. Equal to
   *  silenceHangMs whenever nothing is in-flight. */
  readonly silenceHangDisplay: number
  readonly voices: readonly VoiceOption[]
  readonly modelStatus: VoiceModelStatus
  readonly modelStatusText: string
  readonly modelProgress: VoiceProgress | null
}

const DEFAULT_SILENCE_HANG_MS = 600
const MIN_SILENCE_HANG_MS = 300
const MAX_SILENCE_HANG_MS = 1200

export const initialVoiceState: VoiceState = {
  available: false,
  probeDone: false,
  mode: "off",
  speakReplies: true,
  ttsEngine: "system",
  fishKeyConfigured: false,
  voiceId: "",
  fishVoiceId: "",
  silenceHangMs: DEFAULT_SILENCE_HANG_MS,
  silenceHangDisplay: DEFAULT_SILENCE_HANG_MS,
  voices: [],
  modelStatus: "checking",
  modelStatusText: "Checking…",
  modelProgress: null,
}

export type VoiceAction =
  | {
      readonly type: "settings-loaded"
      readonly mode: VoiceMode
      readonly speakReplies: boolean
      readonly ttsEngine: TtsEngine
      readonly voiceId: string
      readonly fishVoiceId: string
      readonly silenceHangMs: number
    }
  | { readonly type: "mode-changed"; readonly mode: VoiceMode }
  | { readonly type: "speak-replies-changed"; readonly value: boolean }
  | { readonly type: "engine-changed"; readonly engine: TtsEngine }
  | { readonly type: "tts-info-resolved"; readonly engine: string; readonly fishKeyConfigured: boolean }
  | {
      readonly type: "fish-key-resolved"
      readonly configured: boolean
      /** Saving a key refreshes the fish voice catalog in the same
       *  transition so the configured flag and the fresh list render as
       *  one update (a second async dispatch can land mid-render and trip
       *  a react-dom interrupted-render crash). */
      readonly voices?: readonly VoiceOption[]
    }
  | { readonly type: "voice-selected"; readonly id: string }
  | { readonly type: "voices-loaded"; readonly voices: readonly VoiceOption[] }
  | { readonly type: "silence-hang-dragged"; readonly value: number }
  | { readonly type: "silence-hang-committed"; readonly value: number }
  | { readonly type: "availability-resolved"; readonly available: boolean }
  | { readonly type: "model-status-applied"; readonly present: boolean }
  | { readonly type: "model-download-started" }
  | { readonly type: "model-download-progress"; readonly downloadedBytes: number; readonly totalBytes: number }
  | { readonly type: "model-download-done" }
  | { readonly type: "model-download-error"; readonly message: string }

/** Clamp + NaN-guard, mirrors the vanilla module's silence-hang parsing. */
export function clampSilenceHang(value: number): number {
  return Number.isFinite(value)
    ? Math.max(MIN_SILENCE_HANG_MS, Math.min(MAX_SILENCE_HANG_MS, value))
    : DEFAULT_SILENCE_HANG_MS
}

/** Progress status text, mirrors voice-model-progress's non-error/non-done branch. */
function progressStatusText(downloadedBytes: number, totalBytes: number): string {
  return totalBytes > 0
    ? `Downloading… ${formatMb(downloadedBytes)} / ${formatMb(totalBytes)} MB`
    : `Downloading… ${formatMb(downloadedBytes)} MB`
}

export function voiceReduce(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case "settings-loaded": {
      const silenceHangMs = clampSilenceHang(action.silenceHangMs)
      return {
        ...state,
        mode: action.mode,
        speakReplies: action.speakReplies,
        ttsEngine: action.ttsEngine,
        voiceId: action.voiceId,
        fishVoiceId: action.fishVoiceId,
        silenceHangMs,
        silenceHangDisplay: silenceHangMs,
      }
    }
    case "mode-changed":
      return { ...state, mode: action.mode }
    case "speak-replies-changed":
      return { ...state, speakReplies: action.value }
    case "engine-changed":
      return { ...state, ttsEngine: action.engine }
    case "tts-info-resolved":
      // The backend engine is authoritative: a stale persisted value
      // (or a rejected set) shows what is actually speaking.
      return {
        ...state,
        ttsEngine: isTtsEngine(action.engine) ? action.engine : state.ttsEngine,
        fishKeyConfigured: action.fishKeyConfigured,
      }
    case "fish-key-resolved":
      return action.voices
        ? { ...state, fishKeyConfigured: action.configured, voices: action.voices }
        : { ...state, fishKeyConfigured: action.configured }
    case "voice-selected":
      return state.ttsEngine === "fish"
        ? { ...state, fishVoiceId: action.id }
        : { ...state, voiceId: action.id }
    case "voices-loaded":
      return { ...state, voices: action.voices }
    case "silence-hang-dragged":
      return { ...state, silenceHangDisplay: action.value }
    case "silence-hang-committed": {
      const value = clampSilenceHang(action.value)
      return { ...state, silenceHangMs: value, silenceHangDisplay: value }
    }
    case "availability-resolved":
      return action.available
        ? { ...state, available: true, probeDone: true }
        : { ...state, available: false, probeDone: true, modelStatusText: "Unavailable in this build" }
    case "model-status-applied":
      return action.present
        ? { ...state, modelStatus: "ready", modelStatusText: "Model ready ✓", modelProgress: null }
        : { ...state, modelStatus: "missing", modelStatusText: "Speech model not downloaded yet" }
    case "model-download-started":
      return { ...state, modelStatus: "downloading", modelStatusText: "Downloading…", modelProgress: null }
    case "model-download-progress": {
      const { downloadedBytes, totalBytes } = action
      return {
        ...state,
        modelStatus: "downloading",
        modelStatusText: progressStatusText(downloadedBytes, totalBytes),
        modelProgress: { downloadedBytes, totalBytes },
      }
    }
    case "model-download-done":
      return { ...state, modelStatus: "ready", modelStatusText: "Model ready ✓", modelProgress: null }
    case "model-download-error":
      return { ...state, modelStatus: "error", modelStatusText: action.message, modelProgress: null }
    default:
      return state
  }
}
