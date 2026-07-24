/**
 * VoicePanel.tsx - React 19 + Astryx port of
 * frontend/panels/settings-voice.js (`LunaPanelTypes['settings.voice']`).
 *
 * Ports the voice tabpanel's settings UI 1:1: mode, speak-replies, voice
 * picker, silence hang, and the model download row. Speech pipeline logic
 * (mic PTT, transcript->send, spoken-reply accumulator) is NOT included here
 * either - see VOICE.md, that stays owned by the hub window.
 *
 * Tauri commands used (identical contract to the vanilla module - see
 * VOICE.md):
 *   voice_status()        -> { modelPresent?, model_present?, state?, mode? }
 *   voice_set_mode({ mode })   -> { mode? } | null
 *   voice_set_voice({ id })    -> void
 *   voice_set_config({ silenceHangMs }) -> void
 *   voice_list_voices()   -> [{ id, name?, quality? }] | null
 *   voice_ensure_model()  -> void (resolves when model is present)
 *
 * Tauri events listened via ctx.win.listen():
 *   voice-state           payload: { state, mode, level? } (not surfaced in
 *                          this panel - reserved, matches the vanilla module)
 *   voice-model-progress  payload: { done?, error?, downloadedBytes?, totalBytes? }
 *
 * localStorage keys (byte-identical to VoiceEngine / the vanilla module):
 *   luna_voice_mode          'off' | 'ptt' | 'auto'  (default 'off')
 *   luna_voice_speak_replies '1' | '0'               (default '1'/true)
 *   luna_voice_id            voice id string          (absent = system default)
 *   luna_voice_silence_hang_ms  numeric string        (default '600')
 *
 * STATE: every transport-driven transition (the initial probe, voices list,
 * model status/progress) flows through voice-store.ts's reducer via
 * useMoonSelector (src/state/store.ts), never straight into the DOM from a
 * ctx.invoke().then()/ctx.win.listen() callback - see voice-store.ts's doc
 * comment for why this panel earns a store where SettingsGeneralPanel.tsx
 * deliberately doesn't.
 *
 * Astryx mapping: ToggleButtonGroup+ToggleButton (mode), Switch (speak
 * replies), Slider (silence hang), Button (download), ProgressBar (download
 * progress), Banner (unavailable notice). The voice picker stays a plain
 * native <select>: Astryx's Selector is a popover component whose click-open
 * interaction needs real layout (getBoundingClientRect) plus
 * @testing-library/user-event to drive in a test, and neither is available
 * in this app's test setup (see apps/ui-moon-tauri/vitest.config.ts) - the
 * same kind of documented, justified native-control carve-out
 * apps/ui-web/src/studio/vault-panel.jsx makes for its password field.
 */
import { useEffect, useRef } from "react"
import "./VoicePanel.css"
import { Banner, Button, ProgressBar, Slider, Switch, ToggleButton, ToggleButtonGroup } from "../../astryx-kit"
import { createStore, useMoonSelector, type MoonStore } from "../../state/store"
import type { PanelCtx } from "../panel-ctx"
import {
  clampSilenceHang,
  initialVoiceState,
  isVoiceMode,
  voiceReduce,
  type VoiceAction,
  type VoiceMode,
  type VoiceState,
} from "./voice-store"

export const PANEL_TITLE = "Voice"

const LS_MODE = "luna_voice_mode"
const LS_SPEAK_REPLIES = "luna_voice_speak_replies"
const LS_VOICE_ID = "luna_voice_id"
const LS_SILENCE_HANG_MS = "luna_voice_silence_hang_ms"

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* best-effort, mirrors the vanilla module */
  }
}
function lsDel(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* best-effort */
  }
}

function readInitialSettings(): { mode: VoiceMode; speakReplies: boolean; voiceId: string; silenceHangMs: number } {
  const rawMode = lsGet(LS_MODE)
  const mode: VoiceMode = rawMode !== null && isVoiceMode(rawMode) ? rawMode : "off"
  const speakReplies = lsGet(LS_SPEAK_REPLIES) !== "0"
  const voiceId = lsGet(LS_VOICE_ID) || ""
  const silenceHangMs = clampSilenceHang(Number.parseInt(lsGet(LS_SILENCE_HANG_MS) ?? "", 10))
  return { mode, speakReplies, voiceId, silenceHangMs }
}

/** One store per mounted VoicePanel, same lazy-ref-init shape as useMoonStore. */
function useVoiceStore(): MoonStore<VoiceState, VoiceAction> {
  const storeRef = useRef<MoonStore<VoiceState, VoiceAction> | null>(null)
  if (storeRef.current === null) storeRef.current = createStore(voiceReduce, initialVoiceState)
  return storeRef.current
}

function progressPercent(progress: VoiceState["modelProgress"]): number | null {
  if (!progress || progress.totalBytes <= 0) return null
  return Math.max(0, Math.min(100, (progress.downloadedBytes / progress.totalBytes) * 100))
}

export function VoicePanel({ ctx }: { ctx: PanelCtx }) {
  const store = useVoiceStore()
  const state = useMoonSelector(store, (s) => s)
  const dispatch = store.dispatch

  useEffect(() => {
    const { mode, speakReplies, voiceId, silenceHangMs } = readInitialSettings()
    dispatch({ type: "settings-loaded", mode, speakReplies, voiceId, silenceHangMs })

    if (!ctx.hasTauri) {
      dispatch({ type: "availability-resolved", available: false })
      return
    }

    let cancelled = false
    let unlistenProgress: (() => void) | undefined

    function subscribeEvents(): void {
      const win = ctx.win as { listen?: (event: string, handler: (ev: any) => void) => Promise<() => void> } | null
      if (!win || typeof win.listen !== "function") return
      // voice-state: the moon-visual concern lives in the hub window, not
      // this panel - listened to only so a future state indicator has
      // somewhere to plug in (mirrors the vanilla module's no-op handler).
      win.listen("voice-state", () => {}).catch(() => {})
      win
        .listen("voice-model-progress", (ev: { payload?: Record<string, unknown> }) => {
          const p = ev?.payload ?? {}
          if (p["error"]) {
            dispatch({ type: "model-download-error", message: `Download failed: ${String(p["error"])}` })
            return
          }
          if (p["done"]) {
            dispatch({ type: "model-download-done" })
            return
          }
          const downloadedBytes = Number.isFinite(p["downloadedBytes"]) ? Number(p["downloadedBytes"]) : 0
          const totalBytes = Number.isFinite(p["totalBytes"]) ? Number(p["totalBytes"]) : 0
          dispatch({ type: "model-download-progress", downloadedBytes, totalBytes })
        })
        .then((unlisten) => {
          if (cancelled) unlisten()
          else unlistenProgress = unlisten
        })
        .catch(() => {})
    }

    function populateVoices(): Promise<void> {
      return (ctx.invoke("voice_list_voices") as Promise<unknown>)
        .then((voices) => {
          if (cancelled || !Array.isArray(voices)) return
          const options = voices
            .filter((v): v is { id: string; name?: string; quality?: string } => {
              return !!v && typeof (v as { id?: unknown }).id === "string" && (v as { id: string }).id.length > 0
            })
            .map((v) => ({
              id: v.id,
              ...(v.name !== undefined ? { name: v.name } : {}),
              ...(v.quality !== undefined ? { quality: v.quality } : {}),
            }))
          dispatch({ type: "voices-loaded", voices: options })
        })
        .catch(() => {})
    }

    ;(ctx.invoke("voice_status") as Promise<{ modelPresent?: boolean; model_present?: boolean } | null>)
      .then((status) => {
        if (cancelled) return
        dispatch({ type: "availability-resolved", available: true })
        const present = !!(status && (status.modelPresent === true || status.model_present === true))
        dispatch({ type: "model-status-applied", present })
        subscribeEvents()
        // Re-apply persisted settings to the Rust core (mirrors applyPersisted).
        ctx.invoke("voice_set_mode", { mode }).catch(() => {})
        if (voiceId) ctx.invoke("voice_set_voice", { id: voiceId }).catch(() => {})
        ctx.invoke("voice_set_config", { silenceHangMs }).catch(() => {})
        return populateVoices()
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: "availability-resolved", available: false })
      })

    return () => {
      cancelled = true
      unlistenProgress?.()
    }
    // Runs once on mount, exactly like the vanilla module's boot sequence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const disabled = !state.available

  function handleModeChange(mode: VoiceMode): void {
    dispatch({ type: "mode-changed", mode })
    lsSet(LS_MODE, mode)
    if (state.available) ctx.invoke("voice_set_mode", { mode }).catch(() => {})
  }

  function handleSpeakRepliesChange(value: boolean): void {
    dispatch({ type: "speak-replies-changed", value })
    lsSet(LS_SPEAK_REPLIES, value ? "1" : "0")
  }

  function handleVoiceChange(id: string): void {
    dispatch({ type: "voice-selected", id })
    if (id) lsSet(LS_VOICE_ID, id)
    else lsDel(LS_VOICE_ID)
    if (state.available) ctx.invoke("voice_set_voice", { id }).catch(() => {})
  }

  function handleSilenceDrag(value: number): void {
    dispatch({ type: "silence-hang-dragged", value })
  }

  function handleSilenceCommit(value: number): void {
    const committed = clampSilenceHang(value)
    dispatch({ type: "silence-hang-committed", value: committed })
    lsSet(LS_SILENCE_HANG_MS, String(committed))
    if (state.available) ctx.invoke("voice_set_config", { silenceHangMs: committed }).catch(() => {})
  }

  function handleDownload(): void {
    if (!state.available) return
    dispatch({ type: "model-download-started" })
    ;(ctx.invoke("voice_ensure_model") as Promise<unknown>)
      .then(() => {
        dispatch({ type: "model-download-done" })
        if (state.mode !== "off") ctx.invoke("voice_set_mode", { mode: state.mode }).catch(() => {})
      })
      .catch(() => {
        dispatch({ type: "model-download-error", message: "Download failed - try again" })
      })
  }

  const showDownload = state.modelStatus === "missing" || state.modelStatus === "error"
  const pct = progressPercent(state.modelProgress)

  return (
    <div className="voice-panel">
      <div id="voice-unavailable-note" hidden={!(state.probeDone && !state.available)}>
        {state.probeDone && !state.available && (
          <Banner status="warning" title="Voice unavailable" description="Voice is not available in this build." />
        )}
      </div>

      <div className="panel-row">
        <ToggleButtonGroup
          label="Voice mode"
          type="single"
          value={state.mode}
          onChange={(value) => value && isVoiceMode(value) && handleModeChange(value)}
          isDisabled={disabled}
        >
          <ToggleButton value="off" label="Off" isDisabled={disabled} />
          <ToggleButton value="ptt" label="Push-to-talk" isDisabled={disabled} />
          <ToggleButton value="auto" label="Hands-free" isDisabled={disabled} />
        </ToggleButtonGroup>
      </div>

      <div className="panel-row">
        <Switch label="Speak replies" value={state.speakReplies} isDisabled={disabled} onChange={handleSpeakRepliesChange} />
      </div>

      <div className="panel-row">
        <label className="voice-select-label" htmlFor="voice-voice-select">
          Voice
        </label>
        <select
          id="voice-voice-select"
          value={state.voiceId}
          disabled={disabled}
          onChange={(e) => handleVoiceChange(e.target.value)}
        >
          <option value="">System default</option>
          {state.voices.map((v) => (
            <option key={v.id} value={v.id}>
              {(v.name && v.name.length > 0 ? v.name : v.id) +
                (v.quality && v.quality !== "default" ? ` · ${v.quality}` : "")}
            </option>
          ))}
          {state.voiceId && !state.voices.some((v) => v.id === state.voiceId) && (
            <option value={state.voiceId}>{state.voiceId} (saved)</option>
          )}
        </select>
      </div>

      <div className="panel-row">
        <Slider
          label="Silence hang"
          min={300}
          max={1200}
          step={50}
          value={state.silenceHangDisplay}
          isDisabled={disabled}
          formatValue={(v) => `${v} ms`}
          valueDisplay="text"
          onChange={handleSilenceDrag}
          onChangeEnd={handleSilenceCommit}
        />
      </div>

      <div className="panel-row voice-model-row">
        <div className="voice-model-info">
          <span className="voice-model-label">Speech model</span>
          <span id="voice-model-status" className="panel-status">
            {state.modelStatusText}
          </span>
          {state.modelStatus === "downloading" && (
            <div id="voice-model-progress">
              {pct === null ? (
                <ProgressBar label="Downloading speech model" isLabelHidden isIndeterminate />
              ) : (
                <ProgressBar label="Downloading speech model" isLabelHidden value={pct} />
              )}
            </div>
          )}
        </div>
        {showDownload && (
          <Button id="voice-model-download" label="Download" variant="secondary" isDisabled={disabled} clickAction={handleDownload} />
        )}
      </div>
    </div>
  )
}

export default VoicePanel
