/**
 * hubEngines.ts - the Moon hub's transport/settings/voice/wizard controller,
 * ported 1:1 from the deleted vanilla script in frontend/index.html (Logger,
 * State, TauriService, WebSocketEngine, MoonFrames, SettingsEngine,
 * VoiceEngine, SetupWizard).
 *
 * Framework boundary: this file owns every side effect (WebSocket, Tauri
 * invoke/listen, localStorage, shell exec) and NEVER touches the DOM -
 * every state change goes through the `dispatch` callback into hubReducer.ts,
 * which MoonOrb.tsx/SetupWizardPanel.tsx render from via
 * useLocalStore/useMoonSelector. This is what the project brief means by
 * "consume state ONLY via the useSyncExternalStore bindings... never poke
 * DOM from transport callbacks" - every WS/Tauri callback below ends in a
 * dispatch(), never a DOM write.
 *
 * The hub keeps its OWN bespoke transport (LunaWS.createFrameRegistry(),
 * NOT panel.html's ctx.connectWs/LunaWS.createClient) - vendor/moon-ws.js's
 * own module doc calls this out explicitly ("the hub (index.html) adopts
 * [createFrameRegistry] while keeping its bespoke transport"), so this file
 * is not a fork of panel-ctx.ts's connectWs, it is the thing panel-ctx.ts's
 * doc says the hub intentionally keeps separate.
 */
import {
  dirShellExpr,
  localStepCopy,
  pathCardLocalDesc,
  detectNoteText,
  renderRemoteCmd,
  PATH_PRELUDE,
  REPO_URL,
} from "./wizardHelpers"
import type { HubAction, ChosenPath, WizardStep } from "./hubReducer"

// =========================================================================
// WIRE PROTOCOL VERSION - SECOND SOURCE OF TRUTH (KEEP IN SYNC!)
// =========================================================================
// Must match UI_WS_PROTOCOL_VERSION in packages/ui-ws/src/protocol.ts /
// frontend/vendor/moon-protocol.js's LunaProtocol.PROTOCOL_VERSION, read at
// runtime below (not duplicated as a literal - the vendor script is the
// single source; this file just reads it, same as the deleted vanilla one
// did via `LunaProtocol.PROTOCOL_VERSION`).

type ShResult = { exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean }

function getTauri(): any {
  return (window as any).__TAURI__
}
function getCore(): any {
  return getTauri()?.core
}
function getLunaWS(): any {
  return (window as any).LunaWS
}
function getLunaProtocol(): any {
  return (window as any).LunaProtocol
}
function getMoonSession(): any {
  return (window as any).MoonSession
}
function getPoolEngineHelper(): any {
  return (window as any).PoolEngineHelper
}
function getMoonHubManager(): any {
  return (window as any).MoonHubManager
}

export const Logger = {
  prefix: "%c[Luna Companion]",
  style:
    "color: #8ab4f8; font-weight: bold; background: rgba(138, 180, 248, 0.08); padding: 2px 6px; border-radius: 4px;",
  info(message: unknown, ...args: unknown[]): void {
    console.log(this.prefix, this.style, message, ...args)
  },
  warn(message: unknown, ...args: unknown[]): void {
    console.warn("%c[Luna Warning]", "color: #f59e0b; font-weight: bold;", message, ...args)
  },
  error(message: unknown, ...args: unknown[]): void {
    console.error("%c[Luna Error]", "color: #ef4444; font-weight: bold;", message, ...args)
  },
}

/** Mutable connection state - mirrors the vanilla `State` object, kept off
 * the reducer since it is transport bookkeeping, not render input (only
 * connStatus flows into HubState). Exposed read/write on
 * window.__MoonInternals.State for jsdom/agent-browser parity with the
 * deleted vanilla page. */
export interface HubTransportState {
  pressStartTime: number
  pressStartX: number
  pressStartY: number
  ws: WebSocket | null
  wsUrl: string
  wsToken: string
  reconnectAttempts: number
  isManuallyClosing: boolean
  connStatus: string
  reconnectTimer: ReturnType<typeof setTimeout> | null
  connGen: number
  protocolNoticeShown: boolean
}

function initialTransportState(): HubTransportState {
  return {
    pressStartTime: 0,
    pressStartX: 0,
    pressStartY: 0,
    ws: null,
    wsUrl: "ws://127.0.0.1:4753/ui",
    wsToken: "",
    reconnectAttempts: 0,
    isManuallyClosing: false,
    connStatus: "disconnected",
    reconnectTimer: null,
    connGen: 0,
    protocolNoticeShown: false,
  }
}

export class HubController {
  readonly State: HubTransportState = initialTransportState()
  private readonly dispatch: (action: HubAction) => void
  private readonly pendingInputs = new Set<string>()
  private _widgetDirectory: Array<{ kind: string; title: string; description: string }> | undefined
  private lastSize = { w: 140, h: 185 }
  private frameRegistry: any = null

  // ── SetupWizard bookkeeping not owned by the reducer (async-flow guards) ──
  private testGen = 0
  private lastHello: any = null

  constructor(dispatch: (action: HubAction) => void) {
    this.dispatch = dispatch
  }

  // ── Tauri window services ────────────────────────────────────────────
  async setWindowSize(width: number, height: number): Promise<void> {
    if (!getTauri()) return
    this.lastSize = { w: width, h: height }
    try {
      const { getCurrentWindow, LogicalSize } = getTauri().window
      const appWindow = getCurrentWindow()
      await appWindow.setSize(new LogicalSize(width, height))
      Logger.info(`Resized window logical boundary: ${width}x${height}`)
    } catch (e) {
      Logger.error("Tauri window resizing failure:", e)
    }
  }

  async applyAlwaysOnTop(enabled: boolean): Promise<void> {
    if (!getTauri()) return
    try {
      const { getCurrentWindow } = getTauri().window
      const appWindow = getCurrentWindow()
      await appWindow.setAlwaysOnTop(enabled)
      Logger.info(`Window alwaysOnTop state updated: ${enabled}`)
    } catch (e) {
      Logger.error("Tauri window always-on-top updates failure:", e)
    }
  }

  startDragging(): void {
    if (getTauri()) {
      try {
        getTauri().window.getCurrentWindow().startDragging()
      } catch (e) {
        Logger.error("Tauri window dragging error:", e)
      }
    }
  }

  expandFromMoon(): void {
    if (getCore()) {
      getCore()
        .invoke("expand_from_moon")
        .catch((e: unknown) => Logger.warn("expand from moon failed:", e))
    } else {
      Logger.info("moon click -> expand_from_moon needs the Tauri runtime; no-op")
    }
  }

  // ── WebSocket engine ─────────────────────────────────────────────────
  connect(): void {
    if (this.State.ws) this.disconnect()
    const myGen = ++this.State.connGen
    if (this.State.reconnectTimer) {
      clearTimeout(this.State.reconnectTimer)
      this.State.reconnectTimer = null
    }
    Logger.info(`Connecting to WebSocket: ${this.State.wsUrl}`)
    this.updateStatus("connecting")
    this.State.isManuallyClosing = false

    const LunaProtocol = getLunaProtocol()
    const fullUrl = LunaProtocol.buildWsUrl(this.State.wsUrl, this.State.wsToken)

    let sock: WebSocket
    try {
      sock = new WebSocket(fullUrl)
    } catch (e) {
      Logger.error("WebSocket creation error:", e)
      this.updateStatus("disconnected")
      this.scheduleReconnect()
      return
    }
    this.State.ws = sock

    sock.addEventListener("open", () => {
      if (myGen !== this.State.connGen) return
      Logger.info("WebSocket connected successfully")
      this.State.reconnectAttempts = 0
      this.updateStatus("connected")
    })
    sock.addEventListener("message", (event) => {
      if (myGen !== this.State.connGen) return
      try {
        const frame = JSON.parse((event as MessageEvent).data)
        this.handleFrame(frame)
      } catch (e) {
        Logger.warn("Malformed WebSocket frame dropped:", e)
      }
    })
    sock.addEventListener("close", (event) => {
      if (myGen !== this.State.connGen) return
      Logger.warn(`WebSocket closed. Code: ${(event as CloseEvent).code}, Reason: ${(event as CloseEvent).reason}`)
      this.updateStatus("disconnected")
      if (!this.State.isManuallyClosing) this.scheduleReconnect()
    })
    sock.addEventListener("error", () => {
      if (myGen !== this.State.connGen) return
      Logger.error("WebSocket transport error occurred")
      this.updateStatus("error")
    })
  }

  disconnect(): void {
    if (this.State.reconnectTimer) {
      clearTimeout(this.State.reconnectTimer)
      this.State.reconnectTimer = null
    }
    if (this.State.ws) {
      Logger.info("Disconnecting WebSocket client manually")
      this.State.isManuallyClosing = true
      try {
        this.State.ws.close()
      } catch {
        /* ignore */
      }
      this.State.ws = null
    }
  }

  private updateStatus(status: HubTransportState["connStatus"]): void {
    this.State.connStatus = status
    this.dispatch({ type: "conn-status", status: status as any })
  }

  async sendWidgetDirectory(): Promise<void> {
    if (this._widgetDirectory === undefined) {
      try {
        const res = await fetch("vendor/widget-registry.json")
        const reg = await res.json()
        this._widgetDirectory = (reg && Array.isArray(reg.widgets) ? reg.widgets : [])
          .filter((w: any) => w && typeof w.kind === "string")
          .map((w: any) => ({
            kind: w.kind,
            title: typeof w.title === "string" ? w.title : w.kind,
            description: typeof w.description === "string" ? w.description : "",
          }))
      } catch {
        this._widgetDirectory = []
      }
    }
    const directory = this._widgetDirectory ?? []
    if (directory.length > 0) {
      this.send({ type: "widget-directory", widgets: directory })
    }
  }

  send(frame: Record<string, unknown>): void {
    if (this.State.ws && this.State.ws.readyState === WebSocket.OPEN) {
      try {
        this.State.ws.send(JSON.stringify(frame))
      } catch (e) {
        Logger.error("Failed to send frame over WebSocket:", e)
      }
    } else {
      Logger.warn("Attempted to send frame while WebSocket was not OPEN", frame)
    }
  }

  checkProtocolVersion(frame: any): void {
    const LunaProtocol = getLunaProtocol()
    const expected = LunaProtocol.PROTOCOL_VERSION
    const serverVersion = frame.protocolVersion
    if (serverVersion === undefined || serverVersion === null) {
      if (!this.State.protocolNoticeShown) {
        this.State.protocolNoticeShown = true
        Logger.warn(
          `Server did not advertise a protocol version; expected v${expected}. Assuming compatible (older server).`,
        )
      }
      return
    }
    if (serverVersion === expected) return
    Logger.error(`Protocol version mismatch: this app expects v${expected} but the server speaks v${serverVersion}.`)
    this.updateStatus("version-warning")
    this.State.protocolNoticeShown = true
  }

  applyBuildSha(frame: any): void {
    const sha = frame && typeof frame.buildSha === "string" ? frame.buildSha.trim() : ""
    try {
      if (sha) localStorage.setItem("luna_build_sha", sha)
      else localStorage.removeItem("luna_build_sha")
    } catch {
      /* quota - cosmetic cache only */
    }
  }

  applyAvailableModels(frame: any): void {
    const models = frame && Array.isArray(frame.availableModels) ? frame.availableModels : []
    try {
      localStorage.setItem(
        "luna_available_models",
        JSON.stringify(models.filter((m: any) => m && typeof m.id === "string" && m.id).map((m: any) => m.id)),
      )
    } catch {
      /* quota/serialization - cosmetic cache only */
    }
  }

  onReattached(): void {
    this.updateStatus("connected")
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * Math.pow(2, this.State.reconnectAttempts), 16000)
    this.State.reconnectAttempts++
    Logger.info(`Scheduling reconnect attempt #${this.State.reconnectAttempts} in ${delay}ms`)
    if (this.State.reconnectTimer) clearTimeout(this.State.reconnectTimer)
    this.State.reconnectTimer = setTimeout(() => {
      this.State.reconnectTimer = null
      if (!this.State.ws || this.State.ws.readyState === WebSocket.CLOSED) this.connect()
    }, delay)
  }

  handleFrame(frame: any): void {
    Logger.info(`Received frame type: "${frame.type}"`, frame)
    this.frameRegistry?.dispatch(frame)
  }

  private renderPip(): void {
    this.dispatch({ type: "needs-input-count", count: this.pendingInputs.size })
  }

  showUpdatePip = (): void => {
    this.dispatch({ type: "show-update-pip" })
  }

  openUpdatesPanel(): void {
    getCore()
      ?.invoke("open_widget", { kind: "settings.updates" })
      .catch((err: unknown) => Logger.warn("open updates panel failed:", err))
  }

  /** Build the shared LunaWS.createFrameRegistry() with the hub's complete
   * (deliberately minimal) frame set. Called once from the mount effect. */
  createFrameRegistry(): void {
    const LunaWS = getLunaWS()
    const registry = LunaWS.createFrameRegistry()
    registry.register("hello", (frame: any) => {
      this.checkProtocolVersion(frame)
      this.onReattached()
      this.sendWidgetDirectory()
      this.applyBuildSha(frame)
      this.applyAvailableModels(frame)
    })
    registry.register("job-input-request", (frame: any) => {
      if (!frame || typeof frame.requestId !== "string") return
      this.pendingInputs.add(frame.requestId)
      this.renderPip()
      getCore()
        ?.invoke("open_widget", { kind: "now" })
        .catch((e: unknown) => Logger.warn("auto-open now rail failed:", e))
    })
    registry.register("job-input-status", (frame: any) => {
      if (!frame || typeof frame.requestId !== "string") return
      this.pendingInputs.delete(frame.requestId)
      this.renderPip()
    })
    registry.register("widget-open", (frame: any) => {
      if (getCore() && typeof frame.kind === "string") {
        const args: Record<string, unknown> = { kind: frame.kind }
        if (frame.params && typeof frame.params === "object") args.params = frame.params
        getCore()
          .invoke("open_widget", args)
          .catch((e: unknown) => Logger.warn("widget-open failed:", e))
      }
    })
    registry.register("open-artifact-widget", (frame: any) => {
      if (getCore() && frame && typeof frame.artifactId === "string" && frame.artifactId) {
        getCore()
          .invoke("open_artifact_widget", {
            artifactId: frame.artifactId,
            title: typeof frame.title === "string" && frame.title ? frame.title : "Artifact",
          })
          .catch((e: unknown) => Logger.warn("open-artifact-widget failed:", e))
      }
    })
    this.frameRegistry = registry
  }

  // ── Settings engine ──────────────────────────────────────────────────
  async persistConnection(url: string, token: string): Promise<boolean> {
    if (!getCore()) return false
    try {
      await getCore().invoke("save_connection", { url, token })
      return true
    } catch (e) {
      Logger.error("Failed to invoke save_connection via Tauri:", e)
      return false
    }
  }

  async loadSettings(): Promise<void> {
    Logger.info("Loading saved settings from localStorage...")
    const savedAlwaysOnTop = localStorage.getItem("luna_always_on_top")
    this.applyAlwaysOnTop(savedAlwaysOnTop === null || savedAlwaysOnTop === "true")

    let loadedUrl: string | null = null
    let loadedToken: string | null = null

    try {
      if (getCore()) await getCore().invoke("migrate_legacy_connection")
    } catch (e) {
      Logger.warn("[boot] legacy migration skipped:", e)
    }

    const MoonSession = getMoonSession()
    if (typeof MoonSession !== "undefined") {
      try {
        const route = await MoonSession.resolveBootRoute()
        if (route) {
          loadedUrl = route.endpoints[0]
          Logger.info(`[boot] route-keyed resolution: key="${route.key}" endpoint="${loadedUrl}"`)
          ;(window as any).__moonBootRoute = { key: route.key, endpoint: loadedUrl, label: route.label }
        }
      } catch (e) {
        Logger.warn("[boot] MoonSession.resolveBootRoute threw unexpectedly:", e)
      }
    }

    if (getCore()) {
      try {
        const conn = await getCore().invoke("load_connection")
        if (conn) {
          if (!loadedUrl && typeof conn.wsUrl === "string" && conn.wsUrl) loadedUrl = conn.wsUrl
          if (typeof conn.wsToken === "string") loadedToken = conn.wsToken
        }
      } catch (e) {
        Logger.error("Failed to invoke load_connection via Tauri:", e)
      }

      const legacyToken = localStorage.getItem("luna_ws_token")
      if (legacyToken !== null) {
        if (loadedToken === null) {
          loadedToken = legacyToken
          const migrateUrl = loadedUrl || localStorage.getItem("luna_ws_url") || "ws://127.0.0.1:4753/ui"
          const migrated = await this.persistConnection(migrateUrl, legacyToken)
          if (loadedUrl === null) loadedUrl = migrateUrl
          if (migrated) {
            localStorage.removeItem("luna_ws_token")
            Logger.info("Migrated legacy localStorage WS token into ~/.luna/moon-connection.json")
          } else {
            Logger.warn("Legacy WS token migration write failed; leaving localStorage copy for retry next launch")
          }
        } else {
          localStorage.removeItem("luna_ws_token")
        }
      }
    } else {
      const savedWsToken = localStorage.getItem("luna_ws_token")
      if (savedWsToken !== null) loadedToken = savedWsToken
    }

    const legacyUrlCache = localStorage.getItem("luna_ws_url")
    this.State.wsUrl = loadedUrl || legacyUrlCache || "ws://127.0.0.1:4753/ui"
    this.State.wsToken = loadedToken !== null ? loadedToken : ""

    Logger.info("Settings synchronized successfully")
    this.connect()
  }

  // ── Voice engine ─────────────────────────────────────────────────────
  voiceAvailable = false
  private voiceSubscribed = false

  private voiceInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    const core = getCore()
    if (!core) return Promise.resolve(null)
    return core.invoke(cmd, args).catch((e: unknown) => {
      Logger.warn(`Voice command ${cmd} failed:`, e)
      return null
    })
  }

  async initVoice(): Promise<void> {
    const core = getCore()
    if (!core) {
      this.voiceAvailable = false
      return
    }
    try {
      await core.invoke("voice_status")
    } catch {
      this.voiceAvailable = false
      Logger.info("Voice pipeline not available in this build (voice_status missing)")
      return
    }
    this.voiceAvailable = true
    this.subscribeVoiceEvents()
    await this.applyPersistedVoice()
  }

  private subscribeVoiceEvents(): void {
    const ev = getTauri()?.event
    if (!ev || this.voiceSubscribed) return
    this.voiceSubscribed = true
    ev.listen("voice-state", ({ payload }: any) => this.onVoiceStateEvent(payload || {}))
  }

  async applyPersistedVoice(): Promise<void> {
    const m = localStorage.getItem("luna_voice_mode")
    const mode = m === "ptt" || m === "auto" ? m : "off"
    const voiceId = localStorage.getItem("luna_voice_id") || ""
    const hang = parseInt(localStorage.getItem("luna_voice_silence_hang_ms") || "", 10)
    const silenceHangMs = Number.isFinite(hang) ? Math.max(300, Math.min(1200, hang)) : 600
    await this.voiceInvoke("voice_set_mode", { mode })
    if (voiceId) await this.voiceInvoke("voice_set_voice", { id: voiceId })
    await this.voiceInvoke("voice_set_config", { silenceHangMs })
  }

  private onVoiceStateEvent(p: any): void {
    const state = p && typeof p.state === "string" ? p.state : ""
    const visual = state && state !== "off" ? state : ""
    const level = state === "listening" && typeof p.level === "number" && Number.isFinite(p.level) ? p.level : null
    this.dispatch({ type: "voice-state", state: visual as any, level })
  }

  // ── SetupWizard ───────────────────────────────────────────────────────
  readonly STORAGE_DONE = "luna.moon.setupComplete"
  readonly WIZARD_W = 660
  readonly WIZARD_H = 600
  private wizardEnv = { serverRunning: false, repoExists: false }
  private wizardChosenPath: ChosenPath = null
  private wizardRanInstall = false

  isSetupComplete(): boolean {
    return localStorage.getItem(this.STORAGE_DONE) === "1"
  }
  markSetupComplete(): void {
    try {
      localStorage.setItem(this.STORAGE_DONE, "1")
    } catch {
      /* quota: harmless */
    }
  }

  async maybeAutoOpenWizard(): Promise<void> {
    if (this.isSetupComplete()) return
    if (!getCore()) return
    if (this.State.wsToken) {
      this.markSetupComplete()
      return
    }
    try {
      const conn = await getCore().invoke("load_connection")
      if (conn && typeof conn.wsUrl === "string" && conn.wsUrl) {
        this.markSetupComplete()
        return
      }
    } catch {
      /* no connection file yet - that IS first run */
    }
    this.openWizard()
  }

  openWizard(): void {
    this.dispatch({ type: "wizard-open" })
    this.setWindowSize(this.WIZARD_W, this.WIZARD_H)
    this.wizardRanInstall = false
    void this.detectEnvironment()
    Logger.info("Setup wizard opened")
  }

  closeWizard(complete = true): void {
    if (complete) this.markSetupComplete()
    this.dispatch({ type: "wizard-close" })
    setTimeout(() => {
      this.setWindowSize(140, 185)
    }, 220)
  }

  async detectEnvironment(): Promise<void> {
    this.wizardEnv = { serverRunning: false, repoExists: false }
    if (getCore()) {
      try {
        const [health, repo] = await Promise.all([
          this.sh("curl -fsS -m 2 http://127.0.0.1:4753/healthz"),
          this.sh('[ -d "$HOME/luna/.git" ]'),
        ])
        this.wizardEnv.serverRunning = !!(health && health.exitCode === 0)
        this.wizardEnv.repoExists = !!(repo && repo.exitCode === 0)
      } catch {
        /* treat as fresh */
      }
    }
    this.dispatch({ type: "wizard-detected", env: this.wizardEnv })
  }

  applyLocalMode(update: boolean): { title: string; sub: string; startLabel: string } {
    return localStepCopy(update)
  }

  pathLocalDesc(): string {
    return pathCardLocalDesc(this.wizardEnv)
  }
  detectNote(): string | null {
    return detectNoteText(this.wizardEnv)
  }
  envSnapshot(): { serverRunning: boolean; repoExists: boolean } {
    return this.wizardEnv
  }

  goTo(step: WizardStep): void {
    this.dispatch({ type: "wizard-goto", step })
  }

  choosePath(path: "local" | "remote" | "connect"): void {
    this.wizardChosenPath = path
    this.dispatch({ type: "wizard-choose-path", path })
    if (path === "connect") this.goTo("connect")
    else if (path === "local") this.goTo("local")
    else this.goTo("remote")
  }

  chosenPath(): ChosenPath {
    return this.wizardChosenPath
  }
  ranInstall(): boolean {
    return this.wizardRanInstall
  }

  prefillConnect(chosenPath: ChosenPath): void {
    const value =
      chosenPath === "local"
        ? "ws://127.0.0.1:4753/ui"
        : this.State.wsUrl || "ws://127.0.0.1:4753/ui"
    this.dispatch({ type: "wizard-connect-prefill", value })
    this.setConnectStatus("", "")
    this.resetFinishGuard()
  }

  async loadLocalToken(chosenPath: ChosenPath, currentToken: string): Promise<void> {
    if (chosenPath !== "local") return
    if (currentToken.trim()) return
    const r = await this.sh('grep "^UI_WS_TOKEN=" "$HOME/.luna/.env"')
    if (!r || r.exitCode !== 0) return
    const m = /^UI_WS_TOKEN=(.+)$/m.exec(r.stdout || "")
    const token = m?.[1]?.trim()
    if (token) {
      this.dispatch({ type: "wizard-connect-token", value: token })
      this.resetFinishGuard()
    }
  }

  resetFinishGuard(): void {
    this.dispatch({ type: "wizard-reset-finish-guard" })
  }

  // ── Thin dispatch wrappers for controlled-input components. Kept on the
  // controller (not called directly from JSX) so every store mutation has
  // exactly one call site shape, matching every other method in this class. ──
  dispatchLocalDir(value: string): void {
    this.dispatch({ type: "wizard-local-dir", value })
  }
  dispatchRemoteHost(value: string): void {
    this.dispatch({ type: "wizard-remote-host", value })
  }
  dispatchConnectUrl(value: string): void {
    this.dispatch({ type: "wizard-connect-url", value })
  }
  dispatchConnectToken(value: string): void {
    this.dispatch({ type: "wizard-connect-token", value })
  }
  dispatchSetAutoTestTrue(): void {
    this.dispatch({ type: "wizard-set-auto-test", value: true })
  }
  dispatchSetAutoTestFalse(): void {
    this.dispatch({ type: "wizard-set-auto-test", value: false })
  }

  /** "Start chatting" on the done step: close the wizard, then summon the
   * chat widget - off-Tauri there is no window manager, so the click just
   * closes the wizard (matches the vanilla wizardDoneBtn handler). */
  finishDoneStep(): void {
    this.closeWizard(true)
    getCore()
      ?.invoke("open_widget", { kind: "chat" })
      .catch((e: unknown) => Logger.warn("open chat widget failed:", e))
  }

  setConnectStatus(msg: string, kind: "" | "run" | "ok" | "fail"): void {
    this.dispatch({ type: "wizard-connect-status", msg, kind })
  }

  testConnection(url: string, token: string, timeoutMs = 7000): Promise<{ ok: boolean; hello?: any; reason?: string }> {
    return new Promise((resolve) => {
      if (typeof WebSocket === "undefined") {
        resolve({ ok: false, reason: "WebSocket unavailable in this environment." })
        return
      }
      let sock: WebSocket
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (result: { ok: boolean; hello?: any; reason?: string }) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        try {
          if (sock) sock.close()
        } catch {
          /* already closed */
        }
        resolve(result)
      }
      try {
        const sep = url.includes("?") ? "&" : "?"
        sock = new WebSocket(token ? `${url}${sep}token=${encodeURIComponent(token)}` : url)
      } catch {
        resolve({ ok: false, reason: "That does not look like a valid ws:// address." })
        return
      }
      timer = setTimeout(
        () =>
          finish({
            ok: false,
            reason: `No reply after ${Math.round(timeoutMs / 1000)}s — is the server running and the address reachable?`,
          }),
        timeoutMs,
      )
      sock.onmessage = (ev) => {
        try {
          const frame = JSON.parse((ev as MessageEvent).data)
          if (frame && frame.type === "hello") finish({ ok: true, hello: frame })
          else finish({ ok: false, reason: "That answers, but it doesn’t sound like Luna — double-check the address." })
        } catch {
          finish({ ok: false, reason: "Reached something, but it does not speak Luna." })
        }
      }
      sock.onclose = () =>
        finish({
          ok: false,
          reason: "Connection refused — check the address, and the token if the server requires one.",
        })
    })
  }

  async runConnectTest(url: string, token: string): Promise<boolean> {
    if (!url) {
      this.setConnectStatus("Enter a server address first.", "fail")
      return false
    }
    const gen = ++this.testGen
    this.lastHello = null
    this.setConnectStatus("Listening for Luna’s hello…", "run")
    const res = await this.testConnection(url, token)
    if (gen !== this.testGen) return false
    if (res.ok) {
      this.lastHello = res.hello || null
      const h = res.hello || {}
      const bits: string[] = []
      if (h.buildSha) bits.push("build " + h.buildSha)
      if (h.capabilities && h.capabilities.setup) bits.push("server is in setup mode and will guide login")
      this.setConnectStatus("Found Luna ✓" + (bits.length ? " — " + bits.join(", ") : ""), "ok")
      return true
    }
    this.setConnectStatus(res.reason || "Could not connect.", "fail")
    return false
  }

  async finishWizard(url: string, token: string, forceSave: boolean): Promise<"retry" | "done"> {
    const finalUrl = url || "ws://127.0.0.1:4753/ui"
    if (!forceSave) {
      const ok = await this.runConnectTest(finalUrl, token)
      if (!ok) {
        this.dispatch({ type: "wizard-force-save" })
        return "retry"
      }
    }
    this.resetFinishGuard()
    this.State.wsUrl = finalUrl
    this.State.wsToken = token
    await this.persistConnection(finalUrl, token)
    this.connect()
    this.markSetupComplete()
    const inSetup = !!(this.lastHello && this.lastHello.capabilities && this.lastHello.capabilities.setup)
    this.dispatch({
      type: "wizard-done",
      title: inSetup ? "Tethered — one last step" : "Luna is tethered",
      summary: "Your moon is pointed at " + finalUrl + ". Click it any time to talk to Luna.",
      setupVisible: inSetup,
    })
    this.goTo("done")
    return "done"
  }

  renderRemoteCmd(rawHost: string): void {
    const { cmd, wsGuess } = renderRemoteCmd(rawHost)
    this.dispatch({ type: "wizard-remote-cmd", cmd, wsGuess })
  }

  async copyRemoteCmd(text: string): Promise<boolean> {
    let copied = false
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text)
        copied = true
      }
    } catch {
      /* fall through to execCommand */
    }
    if (!copied) {
      try {
        const ta = document.createElement("textarea")
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        copied = document.execCommand("copy")
        ta.remove()
      } catch {
        copied = false
      }
    }
    this.dispatch({ type: "wizard-copy-label", label: copied ? "Copied ✓" : "Copy failed" })
    setTimeout(() => this.dispatch({ type: "wizard-copy-label", label: "Copy" }), 1600)
    return copied
  }

  sh(command: string, timeoutMs?: number): Promise<ShResult> {
    if (!getCore()) {
      return Promise.resolve({
        exitCode: null,
        stdout: "",
        stderr: "local shell unavailable (no Tauri runtime)",
        durationMs: 0,
        timedOut: false,
      })
    }
    return getCore().invoke("local_shell_exec", {
      command: PATH_PRELUDE + command,
      cwd: null,
      timeoutMs: timeoutMs ?? null,
    })
  }

  dirShellExpr(dir: string): string | null {
    return dirShellExpr(dir)
  }

  async runLocalInstall(dirRaw: string): Promise<void> {
    const dirSh = this.dirShellExpr(dirRaw.trim() || "~/luna")
    if (!dirSh) {
      this.dispatch({ type: "wizard-local-dir-invalid", value: true })
      setTimeout(() => this.dispatch({ type: "wizard-local-dir-invalid", value: false }), 1800)
      return
    }
    const update = this.wizardEnv.serverRunning || this.wizardEnv.repoExists
    this.wizardRanInstall = true
    this.dispatch({ type: "wizard-ran-install", value: true })
    this.goTo("progress")

    const D = `LUNA_DIR=${dirSh}; `
    const tasks: Array<{ label: string; hint?: string; run: () => Promise<ShResult> }> = [
      {
        label: "Checking this Mac has the basics",
        hint: "This Mac is missing its developer basics. Open Terminal, run `xcode-select --install`, then try again.",
        run: () => this.sh("command -v git"),
      },
      {
        label: "Fetching Luna’s toolbox",
        hint: "Couldn’t fetch bun (Luna’s engine) from bun.sh — check your internet connection and retry.",
        run: () => this.sh("command -v bun || (curl -fsSL https://bun.sh/install | bash)", 240000),
      },
      {
        label: update ? "Picking up Luna’s newest code" : "Downloading Luna",
        run: () =>
          this.sh(
            D +
              'if [ -d "$LUNA_DIR/.git" ]; then git -C "$LUNA_DIR" pull --ff-only; else git clone ' +
              REPO_URL +
              ' "$LUNA_DIR"; fi',
            420000,
          ),
      },
      {
        label: "Putting the pieces together",
        run: () => this.sh(D + 'cd "$LUNA_DIR" && bun install', 600000),
      },
      {
        label: "Making Luna a home (~/.luna)",
        run: () =>
          this.sh(
            D +
              'mkdir -p "$HOME/.luna/logs" && { [ -f "$HOME/.luna/.env" ] || touch "$HOME/.luna/.env"; } && ' +
              'chmod 600 "$HOME/.luna/.env" && ' +
              '{ grep -q "^LUNA_REPO_ROOT=" "$HOME/.luna/.env" || printf "LUNA_REPO_ROOT=%s\\n" "$LUNA_DIR" >> "$HOME/.luna/.env"; } && ' +
              '{ grep -q "^UI_WS_TOKEN=" "$HOME/.luna/.env" || printf "UI_WS_TOKEN=%s\\n" "$(openssl rand -hex 24)" >> "$HOME/.luna/.env"; }',
          ),
      },
      ...(update && this.wizardEnv.serverRunning
        ? [
            {
              label: "Tucking the old Luna in",
              run: () =>
                this.sh(
                  'launchctl bootout "gui/$(id -u)/com.user.luna-chat-server" 2>/dev/null; ' +
                    'pkill -f "ui-web.*server:chat" 2>/dev/null; sleep 6; true',
                  30000,
                ),
            },
          ]
        : []),
      {
        label: update ? "Waking Luna back up" : "Waking Luna up",
        run: async () => {
          if (!update) {
            const probe = await this.sh("curl -fsS -m 2 http://127.0.0.1:4753/healthz")
            if (probe && probe.exitCode === 0) {
              return {
                exitCode: 0,
                stdout: "Luna was already awake here",
                stderr: "",
                durationMs: probe.durationMs,
                timedOut: false,
              }
            }
          }
          return this.sh(
            D +
              'LABEL="com.user.luna-chat-server"; DOMAIN="gui/$(id -u)"; ' +
              'BUN_BIN="$(command -v bun)"; ' +
              '. "$LUNA_DIR/scripts/lib/launchd-plist.sh"; ' +
              'mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.luna/logs"; ' +
              'PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"; ' +
              'render_launchd_plist "$BUN_BIN" "$LUNA_DIR" "$HOME/.luna" > "$PLIST"; ' +
              'chmod 644 "$PLIST"; ' +
              'launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; ' +
              'launchctl enable "$DOMAIN/$LABEL" 2>/dev/null; ' +
              'launchctl bootstrap "$DOMAIN" "$PLIST" ' +
              '&& launchctl kickstart "$DOMAIN/$LABEL" ' +
              '&& echo "Luna is supervised now — she survives restarts (log: ~/.luna/logs/server.log)"',
            60000,
          )
        },
      },
      {
        label: "Listening for a heartbeat",
        run: async () => {
          for (let attempt = 0; attempt < 30; attempt++) {
            const r = await this.sh("curl -fsS -m 2 http://127.0.0.1:4753/healthz")
            if (r && r.exitCode === 0) return r
            await new Promise((res) => setTimeout(res, 2000))
          }
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Luna never answered on http://127.0.0.1:4753/healthz after 60s — peek at ~/.luna/logs/server.log",
            durationMs: 0,
            timedOut: true,
          }
        },
      },
    ]

    this.dispatch({
      type: "wizard-install-start",
      title: update ? "Freshening Luna up…" : "Painting Luna onto this Mac…",
      sub: update
        ? "A quick refresh — your chats and memories aren’t touched."
        : "This can take a few minutes the first time. Feel free to watch the beads.",
      labels: tasks.map((t) => t.label),
    })

    for (let i = 0; i < tasks.length; i++) {
      this.dispatch({ type: "wizard-task-set", index: i, state: "running", note: "" })
      let r: ShResult
      try {
        r = await tasks[i]!.run()
      } catch (e) {
        r = { exitCode: null, stdout: "", stderr: String(e), durationMs: 0, timedOut: false }
      }
      const okExit = r && r.exitCode === 0
      if (okExit) {
        const secs = r.durationMs >= 1000 ? Math.round(r.durationMs / 1000) + "s" : ""
        this.dispatch({
          type: "wizard-task-set",
          index: i,
          state: "ok",
          note: (r.stdout || "").trim().split("\n").pop() || secs,
        })
      } else {
        this.dispatch({
          type: "wizard-task-set",
          index: i,
          state: "fail",
          note: r.timedOut ? "timed out" : "exit " + r.exitCode,
        })
        this.dispatch({ type: "wizard-log-append", text: (r.stderr || "").trim() || (r.stdout || "").trim() || "No output." })
        if (tasks[i]!.hint) this.dispatch({ type: "wizard-log-append", text: tasks[i]!.hint! })
        this.dispatch({
          type: "wizard-install-failed",
          title: "The wash didn’t take",
          sub: 'Something went wrong at "' + tasks[i]!.label + '". Fix it up and try again.',
        })
        return
      }
    }

    this.dispatch({
      type: "wizard-install-succeeded",
      title: update ? "Luna is fresh and awake ☾" : "Luna is awake ☾",
      sub: update
        ? "All updated and answering. One last brushstroke: re-tether your moon."
        : "She answered. One last brushstroke: tether your moon to her.",
    })
  }

  // ── Panel fan-out (hub-event listener) ───────────────────────────────
  private async reloadAndReconnect(): Promise<void> {
    try {
      const core = getCore()
      if (!core) return
      const creds = await core.invoke("load_connection")
      this.State.wsUrl = creds && creds.wsUrl ? creds.wsUrl : ""
      this.State.wsToken = creds && typeof creds.wsToken === "string" ? creds.wsToken : ""
      if (this.State.wsUrl) this.connect()
      else {
        this.disconnect()
        this.updateStatus("disconnected")
      }
    } catch (e) {
      Logger.warn("panel-driven reconnect failed:", e)
    }
  }

  async handleHubAction(name: string): Promise<void> {
    if (name === "fresh-thread") {
      if (getCore()) await getCore().invoke("open_widget", { kind: "chat" })
      return
    }
    if (name === "profile-changed" || name === "connection-changed") {
      await this.reloadAndReconnectPooled()
      return
    }
    if (name === "open-wizard") {
      this.openWizard()
      return
    }
  }

  /** C8 DARK path: when luna_pool_engine is set, addressed-delivery
   * dispatch instead of a hub-wide broadcast. Flag-off behavior (the
   * default) is identical to reloadAndReconnect. */
  private async reloadAndReconnectPooled(): Promise<void> {
    const useHubPool = getPoolEngineHelper()?.isDarkFlagSet()
    const hubManager = getMoonHubManager()
    if (!useHubPool || !hubManager) {
      await this.reloadAndReconnect()
      return
    }
    try {
      const core = getCore()
      if (!core) return
      const creds = await core.invoke("load_connection")
      this.State.wsUrl = creds && creds.wsUrl ? creds.wsUrl : ""
      this.State.wsToken = creds && typeof creds.wsToken === "string" ? creds.wsToken : ""
      let routeKey: string | null = null
      const MoonSession = getMoonSession()
      if (MoonSession && typeof MoonSession.listRoutes === "function") {
        try {
          const rl = await MoonSession.listRoutes()
          if (rl && rl.default) routeKey = rl.default
        } catch {
          /* ignore */
        }
      }
      if (!routeKey && this.State.wsUrl) routeKey = this.State.wsUrl
      const bus = ((window as any).__HubState ||= {
        bus: hubManager.createDeliveryBus(),
        pool: hubManager.createConnectionPool((rk: string) => ({ routeKey: rk, disconnect: () => {} })),
      }).bus
      if (routeKey) {
        bus.dispatchConnectionChanged(routeKey, { status: "reconnecting", descriptor: { wsUrl: this.State.wsUrl } })
      }
      if (this.State.wsUrl) this.connect()
      else {
        this.disconnect()
        this.updateStatus("disconnected")
      }
    } catch (e) {
      Logger.warn("panel-driven reconnect (pool) failed:", e)
    }
  }
}
