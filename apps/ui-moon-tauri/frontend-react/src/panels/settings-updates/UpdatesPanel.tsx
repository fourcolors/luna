/**
 * UpdatesPanel.tsx - React 19 + Astryx port of
 * frontend/panels/settings-updates.js (`LunaPanelTypes['settings.updates']`).
 *
 * This is the FULL staged-update narrative (the richest of the three update
 * surfaces; the composer banner (chat.html's UpdateBanner) and the orb pip
 * are the quieter nudges, and both stay vanilla - they only ever pass the
 * string kind `'settings.updates'` to `open_widget`, so nothing about this
 * conversion touches them). It tells the whole story in one place: we check
 * quietly, auto-download with a live progress bar, verify the signature,
 * then HOLD the staged bytes until the user presses "Restart to update" -
 * nothing restarts on its own.
 *
 * WHY a panel-local phase machine instead of imperative DOM writers: the
 * Rust UpdateManager is the source of truth and drives everything via
 * `update://*` events. This component is a pure projection of one phase
 * string + a few numbers, folded through updates-store.ts's reducer (see
 * that file's doc comment for why this panel earns a store the same way
 * VoicePanel.tsx's voice-store.ts does). We listen to every event, dispatch,
 * and re-render - never touching the DOM from inside a transport callback.
 * We also call `update_state` once on open (replay-on-open) so a freshly
 * opened panel syncs immediately instead of waiting for the next event -
 * the download may already be staged before this window ever exists.
 *
 * Updates are GOOD NEWS: this panel leans on Astryx's default/info/success
 * tokens only, never `error`/`warning` variants - even the error phase pill
 * stays neutral (see updates-store.ts's PHASE_PILL and the vanilla module's
 * CSS doc comment: "never red/warning styling"). Release notes are
 * remote-ish text, so they render as plain React children (never
 * `dangerouslySetInnerHTML`) and are capped to a few lines (notesLines()).
 *
 * Tauri commands used (identical contract to the vanilla module):
 *   update_state()          -> UpdateStateDto   (replay-on-open snapshot)
 *   check_for_update()      -> UpdateInfo | null (manual check)
 *   start_update_download()                      (auto-advance available -> downloading)
 *   apply_update()                                (install the staged bytes + relaunch;
 *                                                   never returns on success)
 *   close_widget({ label })                       ("Later" - best-effort)
 *
 * Tauri events listened via the GLOBAL `window.__TAURI__.event.listen` bus
 * (NOT `ctx.win.listen` - these are app-wide UpdateManager events, not
 * per-window ones, same as the vanilla module's `subscribe()`):
 *   update://checking | update://available | update://progress |
 *   update://verifying | update://ready | update://none | update://error
 */
import { useEffect, useRef } from "react"
import { Badge, Button, Card, HStack, ProgressBar } from "../../astryx-kit"
import "./updates-panel.css"
import { createStore, useMoonSelector, type MoonStore } from "../../state/store"
import type { PanelCtx } from "../panel-ctx"
import {
  initialUpdateState,
  notesLines,
  phaseHasCard,
  phaseShowsProgress,
  PHASE_PILL,
  progressBytesText,
  progressPercent,
  updatesReduce,
  UPDATE_EVENT_NAMES,
  type UpdateAction,
  type UpdateEventName,
  type UpdateState,
} from "./updates-store"

export const PANEL_TITLE = "Updates"

/** Minimal shape of the global Tauri event bus this panel subscribes to. */
interface TauriEventBus {
  listen: (event: string, handler: (ev: { payload?: unknown }) => void) => Promise<() => void>
}

function tauriEventBus(): TauriEventBus | null {
  const w = window as unknown as { __TAURI__?: { event?: TauriEventBus } }
  const ev = w.__TAURI__?.event
  return ev && typeof ev.listen === "function" ? ev : null
}

/** One store per mounted UpdatesPanel, same lazy-ref-init shape as VoicePanel's. */
function useUpdatesStore(): MoonStore<UpdateState, UpdateAction> {
  const storeRef = useRef<MoonStore<UpdateState, UpdateAction> | null>(null)
  if (storeRef.current === null) storeRef.current = createStore(updatesReduce, initialUpdateState)
  return storeRef.current
}

export function UpdatesPanel({ ctx }: { ctx: PanelCtx }) {
  const store = useUpdatesStore()
  const state = useMoonSelector(store, (s) => s)
  const dispatch = store.dispatch

  // Once-per-version guard for the auto-advance effect below: a manual check
  // leaves us at "available" with no further motion (check_for_update is
  // auto_download=false by contract), so the panel advances it into the
  // staged download itself. Tracked per version so it kicks exactly once;
  // reset on a fresh manual check so a retry after an error can re-trigger
  // (mirrors the vanilla module's `kickedVersion`).
  const kickedVersionRef = useRef<string | null>(null)

  // ── Replay-on-open + event subscription (runs once on mount) ────────────
  useEffect(() => {
    let cancelled = false

    if (ctx.hasTauri) {
      ;(ctx.invoke("update_state") as Promise<unknown>)
        .then((dto) => {
          if (!cancelled && dto && typeof dto === "object") {
            dispatch({ type: "snapshot", dto })
          }
        })
        .catch(() => {
          /* off-Tauri / not ready */
        })
    }

    // Subscribe to every update://* event over the GLOBAL Tauri event bus
    // (not ctx.win - see this file's module doc). Guarded: the panel window
    // may lack the global event bus (older shells / tests).
    const unlisteners: Array<() => void> = []
    const bus = tauriEventBus()
    if (bus) {
      for (const name of UPDATE_EVENT_NAMES as readonly UpdateEventName[]) {
        try {
          bus
            .listen(name, (ev) => {
              dispatch({ type: "event", name, payload: (ev?.payload as Record<string, unknown>) ?? {} })
            })
            .then((unlisten) => {
              if (cancelled) unlisten()
              else unlisteners.push(unlisten)
            })
            .catch(() => {
              /* ignore */
            })
        } catch {
          /* ignore */
        }
      }
    }

    return () => {
      cancelled = true
      for (const un of unlisteners.splice(0)) {
        try {
          un()
        } catch {
          /* best-effort */
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Auto-advance "available" -> "downloading" exactly once per version ──
  // A manual check parks at "available" with no further events; without
  // this the panel would dead-end. The background discovery path is already
  // "downloading" by the time its "available" event reaches us, so the Rust
  // in-flight guard makes this a harmless no-op there.
  useEffect(() => {
    if (!ctx.hasTauri) return
    if (state.phase !== "available" || !state.version) return
    if (kickedVersionRef.current === state.version) return
    kickedVersionRef.current = state.version
    ;(ctx.invoke("start_update_download") as Promise<unknown>).catch(() => {
      /* the update://error event (or a later check) will reflect failures */
    })
  }, [ctx, state.phase, state.version])

  // Plain onClick, not Astryx Button's `clickAction` (which wraps the call
  // in its own useTransition): this handler dispatches into this panel's
  // external store SYNCHRONOUSLY before the invoke() call below, and doing
  // that from inside Button's startTransition callback re-enters React's
  // render while Button itself is still mid-render, producing a "Rendered
  // more hooks than during the previous render" crash. Our own `busy`/
  // `isDisabled` already cover the "disabled while pending" affordance
  // Button's clickAction would otherwise provide.
  function handleCheck(): void {
    if (!ctx.hasTauri) {
      dispatch({ type: "event", name: "update://none", payload: {} })
      return
    }
    // A fresh manual check may re-trigger the staged download for the same
    // version (e.g. retry after a download error), so clear the once-guard.
    kickedVersionRef.current = null
    dispatch({ type: "check-started" })
    // check_for_update drives the event stream AND returns Option<UpdateInfo>;
    // we lean on the events, but fold the return value as a fallback so the
    // panel still updates even if events are somehow missed. Only adopt the
    // fallback if the live phase is still "checking" (events may have
    // already moved it past that) - read fresh from the store, not the
    // render-time `state` closure.
    ;(ctx.invoke("check_for_update") as Promise<{ version?: string; notes?: string } | null>)
      .then((info) => {
        if (store.getState().phase !== "checking") return
        if (info && info.version) {
          dispatch({ type: "check-found", version: String(info.version), notes: info.notes != null ? String(info.notes) : null })
        } else {
          dispatch({ type: "check-empty" })
        }
      })
      .catch((e) => {
        if (store.getState().phase !== "checking") return
        dispatch({ type: "check-failed", message: String(e) })
      })
  }

  function handleRestart(): void {
    // apply_update saves the panel layout + marks reopen, installs the
    // STAGED bytes, and relaunches - it never returns on success. We only
    // fold state on the failure path. Plain onClick (not Astryx Button's
    // clickAction/useTransition wrapper) - see handleCheck's comment on why
    // a handler that synchronously dispatches into this panel's external
    // store must not run inside Button's own startTransition.
    ;(ctx.invoke("apply_update") as Promise<unknown>).catch((e) => {
      dispatch({ type: "restart-failed", message: String(e) })
    })
  }

  function handleLater(): void {
    // "Later" just closes the panel - the staged bytes stay held, the orb
    // pip + composer banner keep nudging. Best-effort window close.
    try {
      if (ctx.hasTauri && ctx.label) {
        ;(ctx.invoke("close_widget", { label: ctx.label }) as Promise<unknown>).catch(() => {})
      }
    } catch {
      /* best-effort */
    }
  }

  const phase = state.phase
  const ready = phase === "ready"
  const busy = phase === "checking" || phase === "downloading" || phase === "verifying"
  const showCard = phaseHasCard(phase) && !!state.version
  const showProgress = phaseShowsProgress(phase)
  const pct = progressPercent(state)
  const lines = notesLines(state.notes)

  return (
    <div className="updates-panel">
      <HStack className="panel-row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="upd-app">Luna Moon</div>
          <div id="update-current" className="panel-status">
            {state.currentVersion ? `Current version ${state.currentVersion}` : "Current version (unknown)"}
          </div>
        </div>
        <Badge id="update-pill" role="status" variant={ready ? "success" : "info"} label={PHASE_PILL[phase]} />
      </HStack>

      <Card id="update-card" className="panel-row" variant="muted" hidden={!showCard}>
        {showCard && (
          <>
            <div id="update-card-version">Version {state.version}</div>
            <div id="update-card-sub" className="panel-status">
              A new version is available.
            </div>
            {lines.length > 0 && (
              <>
                <div className="upd-notes-label">What's new</div>
                <ul id="update-notes" className="upd-notes">
                  {lines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Card>

      <div id="update-progress" className="panel-row" hidden={!showProgress}>
        {showProgress && (
          <>
            {/* value/max stay percent-based (0-100) so role="progressbar"'s
                aria-valuenow reads as a percent (matches the vanilla
                module); formatValueLabel is pointed at the bytes string
                instead of ProgressBar's default "N%" text so aria-valuetext
                reads the same bytes text the visible row below shows. */}
            <ProgressBar label="Update download progress" isLabelHidden value={pct} max={100} formatValueLabel={() => progressBytesText(state)} />
            <div className="upd-prog-row">
              <span id="update-bytes">{progressBytesText(state)}</span>
              <span id="update-percent">{pct}%</span>
            </div>
            <div id="update-verified" className="upd-verified" hidden={!ready}>
              <span aria-hidden="true">✓</span>
              <span>Signature verified</span>
            </div>
          </>
        )}
      </div>

      <HStack className="panel-row">
        <Button
          id="check-update-btn"
          label="Check for updates"
          hidden={ready || busy || phase === "available"}
          isDisabled={busy}
          onClick={handleCheck}
        />
        <Button id="restart-update-btn" label="Restart to update" variant="primary" hidden={!ready} onClick={handleRestart} />
        <Button id="later-update-btn" label="Later" variant="ghost" hidden={!ready} onClick={handleLater} />
      </HStack>

      <div id="update-error" className="panel-status" role="status" hidden={phase !== "error"}>
        {state.errorMessage}
      </div>

      <div className="upd-foot">Checks automatically in the background.</div>
    </div>
  )
}

export default UpdatesPanel
