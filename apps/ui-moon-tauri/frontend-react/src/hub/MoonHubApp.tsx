/**
 * MoonHubApp.tsx - root component for index.html, the Moon "orb <-> widgets"
 * hub shell. Ports the deleted vanilla script's boot sequence 1:1 (settings
 * load -> connect -> first-run wizard auto-open, voice init, panel fan-out
 * event listeners, luna-config token seeding, pending-update chat restore)
 * into a single mount effect, with every side effect routed through
 * HubController (hubEngines.ts) into hubReducer.ts's store - see that
 * file's module doc for the "never poke DOM from a transport callback"
 * discipline this mount effect and its children all follow.
 *
 * State is consumed exclusively via useLocalStore/useMoonSelector
 * (src/state/store.ts's useSyncExternalStore bindings), the same pattern
 * AgentsPanel.tsx established for panel-local (non-shared-UIState) state.
 */
import { useEffect, useMemo, useRef } from "react"
import { useLocalStore, useMoonSelector } from "../state/store"
import { reduceHub, initialHubState, type HubAction, type HubState } from "./hubReducer"
import { HubController, Logger } from "./hubEngines"
import { MoonOrb } from "./MoonOrb"
import { SetupWizardPanel } from "./SetupWizardPanel"

function getTauri(): any {
  return (window as any).__TAURI__
}
function getCore(): any {
  return getTauri()?.core
}

declare global {
  interface Window {
    /**
     * Test-only / agent-browser hooks. jsdom suites and the repo's
     * documented screenshot recipe (CLAUDE.md: "agent-browser eval
     * window.__MoonInternals.handleFrame(...)") drive the hub through
     * these instead of a real socket / Tauri runtime. Production code
     * never reads them. Shape mirrors the deleted vanilla page's
     * window.__MoonInternals exactly.
     */
    __MoonInternals?: {
      handleFrame: (frame: unknown) => void
      WebSocketEngine: {
        connect: () => void
        disconnect: () => void
        send: (frame: Record<string, unknown>) => void
      }
      TauriService: {
        setWindowSize: (w: number, h: number) => Promise<void>
        applyAlwaysOnTop: (enabled: boolean) => Promise<void>
        startDragging: () => void
      }
      State: HubController["State"]
      showUpdatePip: () => void
      SetupWizard: {
        open: () => void
        close: (opts?: { complete?: boolean }) => void
        goTo: (step: HubState["wizard"]["current"]) => void
        choosePath: (path: "local" | "remote" | "connect") => void
        isComplete: () => boolean
      }
      dispatch: (action: HubAction) => void
      getState: () => HubState
    }
  }
}

export function MoonHubApp(): React.JSX.Element {
  const store = useLocalStore<HubState, HubAction>(reduceHub, initialHubState())
  const state = useMoonSelector(store, (s) => s)
  const controllerRef = useRef<HubController | null>(null)
  if (controllerRef.current === null) controllerRef.current = new HubController(store.dispatch)
  const controller = controllerRef.current

  useEffect(() => {
    controller.createFrameRegistry()

    // ── Debug/observability hooks (see the Window augmentation above). ──
    window.__MoonInternals = {
      handleFrame: (frame) => controller.handleFrame(frame),
      WebSocketEngine: {
        connect: () => controller.connect(),
        disconnect: () => controller.disconnect(),
        send: (frame) => controller.send(frame),
      },
      TauriService: {
        setWindowSize: (w, h) => controller.setWindowSize(w, h),
        applyAlwaysOnTop: (enabled) => controller.applyAlwaysOnTop(enabled),
        startDragging: () => controller.startDragging(),
      },
      State: controller.State,
      showUpdatePip: controller.showUpdatePip,
      SetupWizard: {
        open: () => controller.openWizard(),
        close: (opts) => controller.closeWizard(opts?.complete ?? true),
        goTo: (step) => controller.goTo(step),
        choosePath: (path) => controller.choosePath(path),
        isComplete: () => controller.isSetupComplete(),
      },
      dispatch: store.dispatch,
      getState: store.getState,
    }

    // ── Update pip (ambient ladder, update rung). ────────────────────────
    const tauri = getTauri()
    if (tauri) {
      try {
        if (tauri.event && typeof tauri.event.listen === "function") {
          tauri.event.listen("update://ready", () => controller.showUpdatePip()).catch(() => {})
          tauri.event.listen("update://available", () => controller.showUpdatePip()).catch(() => {})
        }
      } catch {
        /* best-effort */
      }
      try {
        if (tauri.core && typeof tauri.core.invoke === "function") {
          tauri.core
            .invoke("update_state")
            .then((dto: any) => {
              if (dto && (dto.phase === "ready" || dto.phase === "available")) controller.showUpdatePip()
            })
            .catch(() => {
              /* command absent on older cores -> ignore */
            })
        }
      } catch {
        /* best-effort */
      }
    }

    // ── Panel fan-out (hub-event + moon-absorb + storage). ──────────────
    try {
      const TW = tauri?.window
      const me = TW && typeof TW.getCurrentWindow === "function" ? TW.getCurrentWindow() : null
      if (me && typeof me.listen === "function") {
        me.listen("hub-event", (e: any) => {
          const p = e && e.payload
          if (!p || p["for"] !== "main") return
          Promise.resolve()
            .then(() => controller.handleHubAction(p.name))
            .catch((err) => Logger.warn(`hub-event ${p.name} failed:`, err))
        }).catch(() => {})
        me.listen("moon-absorb", () => {
          store.dispatch({ type: "absorb-pulse" })
        }).catch(() => {})
      }
    } catch {
      /* off-Tauri */
    }
    const onStorage = (e: StorageEvent) => {
      if (!e || !e.key) return
      if (e.key === "luna_always_on_top") {
        void controller.applyAlwaysOnTop(e.newValue === "true")
      }
    }
    window.addEventListener("storage", onStorage)

    // ── Voice boot (independent of settings load). ──────────────────────
    Promise.resolve(controller.initVoice()).catch((e) => Logger.warn("Voice init failed (non-fatal):", e))

    // ── Settings load -> connect -> first-run wizard auto-open. ─────────
    const settingsLoaded = controller.loadSettings()
    settingsLoaded
      .catch(() => {})
      .then(() => {
        if (!getTauri() && typeof location !== "undefined" && new URLSearchParams(location.search).has("wizard")) {
          document.body.style.background = "#10142a"
          controller.openWizard()
          return
        }
        return controller.maybeAutoOpenWizard()
      })
      .catch((e) => Logger.error("Setup wizard auto-open failed:", e))

    // ── Restore polish: reopen the chat window after an update restart. ─
    if (getCore()) {
      getCore()
        .invoke("take_pending_update")
        .then((marker: any) => {
          if (marker && marker.reopenChat) return getCore().invoke("open_widget", { kind: "chat" })
        })
        .catch(() => {
          /* command absent / no marker -> nothing to restore */
        })
    }

    // ── Auto-wire the server token from ~/.luna/.env via luna-config. ───
    let unlistenConfig: (() => void) | null = null
    if (tauri?.event) {
      tauri.event
        .listen("luna-config", async ({ payload }: any) => {
          await settingsLoaded
          if (payload.wsToken && !controller.State.wsToken) {
            controller.State.wsToken = payload.wsToken
            controller.State.wsUrl = payload.wsUrl || controller.State.wsUrl
            await controller.persistConnection(controller.State.wsUrl, controller.State.wsToken)
            Logger.info("luna-config: token seeded from ~/.luna/.env, connecting...")
            controller.connect()
          }
        })
        .then((un: () => void) => {
          unlistenConfig = un
        })
        .catch(() => {})
    }

    return () => {
      window.removeEventListener("storage", onStorage)
      if (unlistenConfig) unlistenConfig()
      delete window.__MoonInternals
    }
    // Mount-once boot sequence, matching the vanilla page's single top-level
    // <script> run - controller/store are stable for this component's
    // lifetime (see the lazy ref-init above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <MoonOrb controller={controller} state={state} />
      <SetupWizardPanel controller={controller} state={state} />
    </>
  )
}

// Re-exported for wizardHelpers-adjacent modules/tests that need the pure
// initial-state constructor without importing the reducer module directly.
export { initialHubState } from "./hubReducer"
