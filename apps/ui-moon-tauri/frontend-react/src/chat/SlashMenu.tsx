/**
 * SlashMenu.tsx - the composer's "/command" popover, a React replacement for
 * chat.html's former inline `SlashMenu` IIFE (stack23 S16c). Owns the
 * open/filter/arrow-nav/Tab-complete/Enter-accept/mousedown-accept state and
 * paints the row list + the hint line via React instead of the vanilla
 * `_render`'s manual `document.createElement` building. Command parsing/
 * filtering/completion still come from `window.LunaCapabilities` (the
 * bundled @luna/capabilities UMD build) - untouched, see `getLunaCapabilities`
 * below.
 *
 * WIRED INTO chat.html via main-chat.tsx's `type="module"` script, exactly
 * like Attachments.tsx / ComposerConfig.tsx: `var SlashMenu;` is forward-
 * declared in chat.html (== `window.SlashMenu` for a classic script) and
 * every call site (the composer's keydown/input/blur listeners, the global
 * Esc handler, ChatEngine.handleSubmit's typed "/cmd args" intercept) keeps
 * calling that same bare identifier. See chat.html's own comment on the
 * `var SlashMenu` declaration and ComposerConfig.tsx's module doc for why a
 * second `type="module"` script must never mount a second React copy.
 *
 * TWO DOM anchors: `#slash-menu` (React owns the hint line + item rows via
 * `createRoot(host).render()`, same "empty static markup, React fills it"
 * contract as ComposerConfig's `#model-cfg-menu`/`#effort-cfg-menu` - see
 * that module's doc) and `#message-input` (SlashMenu does NOT own a React
 * root there - the textarea's value and its `aria-expanded`/
 * `aria-activedescendant` attributes are plain DOM writes via
 * `useLayoutEffect`, mirroring vanilla's own `ti.setAttribute(...)` calls -
 * ChatEngine still owns the textarea's OTHER behavior (autoGrow, submit)
 * untouched in chat.html).
 *
 * MODEL/EFFORT PICKER DOM ANCHORS STAY PLAIN, ON PURPOSE: `_openModelPicker`/
 * `_openEffortPicker` reach directly into `#model-cfg-menu`/`#model-cfg-btn`/
 * `#effort-cfg-menu`/`#effort-cfg-btn` - the SAME nodes ComposerConfig.tsx
 * itself owns roots on - exactly like the vanilla object did (see
 * ComposerConfig.tsx's own "MENU OPEN/CLOSE STAYS PLAIN DOM" doc section,
 * which names this exact call site). Two modules writing plain DOM
 * class/attribute state to the same nodes is the pre-conversion protocol,
 * unchanged by this port.
 *
 * BACKEND-ADVERTISED COMMANDS: `buildCommands`'s merge and `dispatch`'s
 * executor:'server' routing read `ctx.getBackendCommands()`/
 * `ctx.executeCapability()`, both backed by `window.LunaChatHost` (stack23
 * S16c-host) - see chat-host.ts's module doc and luna-chat-host.d.ts for the
 * full seam this slice replaced the prior `window.__MoonInternals` bridge
 * with.
 *
 * SMARTBARENGINE DEFERRAL: S16d (SmartBarEngine alone, ~193 vanilla lines)
 * is booked as its own slice between S16c and S17.
 *
 * `helpText()`'s "/id [args] - description (source)" line matches vanilla's
 * PRODUCT-VISIBLE /help output text BYTE-EXACTLY, including its em-dash
 * separator. That rendered line is ORACLE-PINNED product copy - do not
 * "fix" the em dash - the SECOND such exception in this codebase after
 * MessageList.tsx:219's `Agent - {agentDesc}` (no other em dash gets a
 * third pin); this doc comment itself stays em-dash-free per the standing
 * no-em-dash rule, same as that one.
 */
import { useLayoutEffect, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import type { CapabilityDescriptor, ExecuteRequest, ExecuteResult } from "@luna/capabilities"
// Runtime import, and deliberately from the zero-import leaf behind its own
// subpath export rather than @luna/ui-ws - see ComposerConfig.tsx's own note.
import { isEffortOption } from "@luna/tools/protocol-descriptor"
import type { ComposerConfigBridge } from "./ComposerConfig"

// ============================================================================
// Types
// ============================================================================

/** The row-ready shape `buildCommands`' own `toItem` maps every descriptor
 * into - what the menu renders, what `filterCommands`/`completeCommand`
 * consume, and what `dispatch` keys off. Mirrors vanilla's `toItem` output
 * exactly (kind/id/arghint/desc/executor/source, no leading '/' on id). */
export interface SlashCommandItem {
  readonly kind: string
  readonly id: string
  readonly arghint: string
  readonly desc: string
  readonly executor: string
  readonly source: string
}

interface MergedCapability {
  readonly source: string
  readonly capability: CapabilityDescriptor
}

/** The slice of `window.LunaCapabilities` (vendor/capabilities.js, the
 * bundled @luna/capabilities UMD build) this module calls - see this
 * module's doc. `mergeCapabilities` is checked for presence at each call
 * site exactly like vanilla (`!LC || !LC.mergeCapabilities`); the other
 * three are assumed present once `LC` itself is truthy, matching vanilla's
 * own unguarded calls. */
interface LunaCapabilitiesGlobal {
  mergeCapabilities?: (
    sources: readonly { source: string; precedence: number; capabilities: readonly CapabilityDescriptor[] }[],
  ) => { merged: readonly MergedCapability[] }
  filterCommands: (input: string, commands: readonly SlashCommandItem[]) => readonly SlashCommandItem[]
  completeCommand: (input: string, commands: readonly SlashCommandItem[]) => string | null
  parseCommandLine: (input: string) => { name: string; args: string } | null
}

function getLunaCapabilities(): LunaCapabilitiesGlobal | null {
  return (window as unknown as { LunaCapabilities?: LunaCapabilitiesGlobal }).LunaCapabilities ?? null
}

/** The live, read-only slice of chat.html's `State` this module reads. */
export interface SlashMenuStateSlice {
  activeThreadId: string | null
  serverSupportsWorkflows: boolean
}

export interface SlashMenuCtx {
  getState: () => SlashMenuStateSlice | null
  getComposerConfig: () => ComposerConfigBridge | null
  /** Synchronous snapshot of `_backendCatalog.capabilities` - see this
   * module's doc for why this can't be the provider's own async `list()`. */
  getBackendCommands: () => readonly CapabilityDescriptor[]
  /** Total: always resolves, never null - see chat-host.ts's `HOST_ABSENT`
   * fallback and luna-chat-host.d.ts's `executeCapability` doc for why an
   * absent host/provider is a resolved `{ok:false}`, not a missing call. */
  executeCapability: (req: ExecuteRequest) => Promise<ExecuteResult>
  appendMessage: (role: string, text: string) => void
  newConversation: () => void
  clearAttachments: () => void
  closeLocalShellMenu: () => void
  autoGrowMessageInput: () => void
}

// ============================================================================
// Plain (React-free) external store.
// ============================================================================

interface SlashMenuSnapshot {
  readonly open: boolean
  readonly items: readonly SlashCommandItem[]
  readonly active: number
}

interface SlashMenuStore {
  getSnapshot: () => SlashMenuSnapshot
  setSnapshot: (next: SlashMenuSnapshot) => void
  subscribe: (listener: () => void) => () => void
}

function createSlashMenuStore(initial: SlashMenuSnapshot): SlashMenuStore {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    setSnapshot: (next) => {
      snapshot = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

// ============================================================================
// Engine - unchanged in shape from the vanilla IIFE; only the DOM-painting
// tail (`_render`'s manual row building) is gone, replaced by `render()`
// pushing a snapshot through the store.
// ============================================================================

function createSlashMenuEngine(
  ctx: SlashMenuCtx,
  dom: { modelMenu: HTMLElement; modelBtn: HTMLElement; effortMenu: HTMLElement; effortBtn: HTMLElement },
) {
  let open = false
  let items: SlashCommandItem[] = []
  let active = 0

  function buildCommands(): SlashCommandItem[] {
    const cc = ctx.getComposerConfig()
    const models = cc ? cc._models : []
    const entry = cc ? cc._currentModelEntry() : null
    const efforts = entry ? entry.efforts : []
    // UI-owned commands as capability descriptors (executor:'client').
    const ui: CapabilityDescriptor[] = [
      { kind: "command", id: "clear", title: "Clear", description: "Start a new conversation", executor: "client", schemaVersion: 1 },
      { kind: "command", id: "new", title: "New", description: "Start a new conversation", executor: "client", schemaVersion: 1 },
    ]
    // Suppress /model & /effort until the hello frame populates _models, so
    // they can never dead-end on the no-match path.
    if (models.length > 0) {
      ui.push({
        kind: "command",
        id: "model",
        title: "Model",
        argHint: "[name]",
        description: "Switch the model (no arg opens picker)",
        executor: "client",
        schemaVersion: 1,
      })
      if (efforts.length > 0) {
        ui.push({
          kind: "command",
          id: "effort",
          title: "Effort",
          argHint: "[level]",
          description: "Set effort level (no arg opens picker)",
          executor: "client",
          schemaVersion: 1,
        })
      }
    }
    // Gated on the hello `workflows` capability - servers without the
    // gallery never advertise a command that would open an empty panel.
    if (ctx.getState()?.serverSupportsWorkflows) {
      ui.push({ kind: "command", id: "workflows", title: "Workflows", description: "Open the workflows panel", executor: "client", schemaVersion: 1 })
    }
    ui.push({ kind: "command", id: "help", title: "Help", description: "Show available commands", executor: "client", schemaVersion: 1 })

    const toItem = (cap: CapabilityDescriptor, source: string): SlashCommandItem => ({
      kind: "command",
      id: cap.id,
      arghint: cap.argHint || "",
      desc: cap.description || "",
      executor: cap.executor || "client",
      source,
    })
    const LC = getLunaCapabilities()
    const backend = ctx.getBackendCommands()
    // Fast path / fallback: no backend catalog -> the UI list in curated order.
    if (!LC || !LC.mergeCapabilities || backend.length === 0) {
      return ui.map((c) => toItem(c, "ui"))
    }
    // Merge UI-owned + backend-advertised (UI wins (kind,id) collisions; each item
    // carries its source for the chip). mergeCapabilities sorts by (kind,id), so we
    // re-impose the curated UI order then append backend commands.
    const merged = LC.mergeCapabilities([
      { source: "ui", precedence: 100, capabilities: ui },
      { source: "luna", precedence: 10, capabilities: backend },
    ]).merged.filter((m) => m.capability.kind === "command")
    const byId = new Map(merged.map((m) => [m.capability.id, m]))
    const order = ui.map((c) => c.id)
    const uiOrdered = order
      .map((id) => byId.get(id))
      .filter((m): m is MergedCapability => !!m)
      .map((m) => toItem(m.capability, m.source))
    const backendOrdered = merged
      .filter((m) => m.source !== "ui" && !order.includes(m.capability.id))
      .map((m) => toItem(m.capability, m.source))
    return [...uiOrdered, ...backendOrdered]
  }

  function helpText(): string {
    // Derive from the live merged command list so backend-advertised commands
    // (and their source) appear in /help too, not just a hardcoded UI list.
    const cc = ctx.getComposerConfig()
    const models = cc ? cc._models : []
    const entry = cc ? cc._currentModelEntry() : null
    const efforts = entry ? entry.efforts : []
    const argFor = (c: SlashCommandItem): string => {
      if (c.id === "model" && models.length > 0) return "[" + models.map((m) => m.id).join("|") + "]"
      if (c.id === "effort" && efforts.length > 0) return "[" + ["default", ...efforts].join("|") + "]"
      return c.arghint || ""
    }
    const lines = ["Available commands:"]
    for (const c of buildCommands()) {
      const arghint = argFor(c)
      const arg = arghint ? " " + arghint : ""
      const src = c.source && c.source !== "ui" ? ` (${c.source})` : ""
      // ORACLE-PINNED product copy: vanilla's separator is an em dash, not a
      // plain dash - restored byte-exactly per orchestrator RULING R3
      // (2026-08-06). See this module's doc block for the full rationale.
      lines.push("  /" + c.id + arg + " — " + (c.desc || "") + src)
    }
    return lines.join("\n")
  }

  const store = createSlashMenuStore({ open, items, active })
  // flushSync, not a bare setSnapshot - every call site here (keydown/input/
  // blur listeners, ChatEngine's handleSubmit intercept, tests) expects the
  // vanilla object's fully synchronous DOM writes, same reasoning as
  // ComposerConfig.tsx's own `publish()`.
  function render(): void {
    flushSync(() => store.setSnapshot({ open, items, active }))
  }

  function openMenu(explicitItems?: readonly SlashCommandItem[]): void {
    // Mutually exclude the other composer popovers. The machine-access
    // scope-menu shares this exact left/bottom anchor, so it must be closed or
    // it paints underneath the slash menu; the model/effort pickers are closed
    // for tidiness.
    ctx.closeLocalShellMenu()
    ctx.getComposerConfig()?.closeAllMenus()
    items = Array.from(explicitItems || buildCommands()) // copy (filterCommands returns a frozen array)
    active = 0
    open = true
    render()
  }
  function closeMenu(): void {
    open = false
    items = []
    active = 0
    render()
  }
  function isOpenFn(): boolean {
    return open
  }
  function move(delta: number): void {
    if (!open || items.length === 0) return
    active = (active + delta + items.length) % items.length
    render()
  }

  // Re-filter on each keystroke - only while the command word has no space yet.
  function onInput(messageInput: HTMLTextAreaElement): void {
    const val = messageInput.value
    if (!val.startsWith("/") || val.includes(" ")) {
      closeMenu()
      return
    }
    const LC = getLunaCapabilities()
    if (!LC) {
      closeMenu()
      return
    }
    const matches = LC.filterCommands(val, buildCommands())
    if (!matches.length) {
      closeMenu()
      return
    }
    openMenu(matches)
  }

  // Tab: shell-style complete (single -> "/id ", multi -> longest-common-prefix, else null).
  function complete(messageInput: HTMLTextAreaElement): boolean {
    const LC = getLunaCapabilities()
    if (!LC) return false
    const res = LC.completeCommand(messageInput.value, buildCommands())
    if (typeof res === "string") {
      messageInput.value = res
      ctx.autoGrowMessageInput()
      onInput(messageInput) // single-match trailing space closes; otherwise re-filter
      return true
    }
    return false // nothing to complete -> let Tab do its native thing
  }

  // Accept the highlighted row; args come from whatever is typed after the verb.
  function accept(messageInput: HTMLTextAreaElement): void {
    if (!open || items.length === 0) return
    const cmd = items[active] ?? items[0]
    if (!cmd) return
    const LC = getLunaCapabilities()
    const parsed = LC ? LC.parseCommandLine(messageInput.value) : null
    const args = parsed && parsed.name === cmd.id ? parsed.args : ""
    closeMenu()
    dispatch(cmd.id, args, messageInput)
  }

  function mousedownAccept(i: number, messageInput: HTMLTextAreaElement): void {
    active = i
    accept(messageInput)
  }

  // Single source of truth for execution (called by accept + the handleSubmit intercept).
  function dispatch(id: string, args: string, messageInput: HTMLTextAreaElement): void {
    messageInput.value = ""
    ctx.autoGrowMessageInput()
    // Backend-advertised (executor:'server') commands route to the backend via the
    // capability provider; the switch below handles only UI-owned client commands.
    const item = buildCommands().find((c) => c.id === id)
    if (item && item.executor === "server") {
      if (!ctx.getState()?.activeThreadId) {
        ctx.appendMessage("assistant", "No active conversation to act on.")
        return
      }
      // Total: always resolves (see SlashMenuCtx.executeCapability's doc) -
      // no `if (result)` guard needed.
      ctx.executeCapability({ kind: item.kind, id, args: args || "" }).then((r) => {
        // 'unknown' = not in the current catalog (silently ignore); surface real failures.
        if (!r.ok && r.reason !== "unknown") ctx.appendMessage("assistant", "⚠️ " + (r.error || "command failed"))
      })
      return
    }
    switch (id) {
      case "clear":
      case "new":
        ctx.clearAttachments()
        ctx.newConversation()
        break
      case "model":
        dispatchModel((args || "").trim())
        break
      case "effort":
        dispatchEffort((args || "").trim())
        break
      case "workflows": {
        // The gallery is its own system panel window (singleton - Rust
        // focuses it if already open). Off-Tauri (browser dev / jsdom)
        // the invoke is absent or rejects; stay silent like other openers.
        // Enumerated delta from vanilla: chat.html's Logger.warn (the styled
        // "[Luna Warning]" console channel) is a block-scoped private, not
        // reachable from this ES module - a bare console.warn matches
        // main-chat.tsx's own openAgentsPanelForCurrentThread catch, the
        // same category of Tauri-invoke failure.
        const w = window as unknown as {
          __TAURI__?: { core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }
        }
        const core = w.__TAURI__?.core
        if (core) {
          core.invoke("open_widget", { kind: "workflows" }).catch((e: unknown) => {
            console.warn("open workflows panel failed:", e)
          })
        }
        break
      }
      case "help":
        ctx.appendMessage("assistant", helpText())
        break
    }
  }

  // /model and /effort with no arg hand off to the existing native pickers
  // (one validated pick path). setTimeout(0), NOT queueMicrotask: on the mouse
  // path the open must run AFTER the trailing document 'click' closer, otherwise
  // the picker opens then immediately closes. (Keyboard path has no trailing click.)
  function openModelPicker(): void {
    setTimeout(() => {
      const cc = ctx.getComposerConfig()
      cc?.closeAllMenus()
      cc?._rebuildModelMenu()
      dom.modelMenu.classList.add("open")
      dom.modelMenu.setAttribute("aria-hidden", "false")
      dom.modelBtn.setAttribute("aria-expanded", "true")
    }, 0)
  }
  function openEffortPicker(): void {
    setTimeout(() => {
      const cc = ctx.getComposerConfig()
      cc?.closeAllMenus()
      cc?._rebuildEffortMenu()
      dom.effortMenu.classList.add("open")
      dom.effortMenu.setAttribute("aria-hidden", "false")
      dom.effortBtn.setAttribute("aria-expanded", "true")
    }, 0)
  }

  function dispatchModel(arg: string): void {
    if (!arg) {
      openModelPicker()
      return
    }
    const cc = ctx.getComposerConfig()
    const models = cc ? cc._models : []
    const a = arg.toLowerCase()
    const exact = models.find((m) => m.id.toLowerCase() === a || (m.label || "").toLowerCase() === a)
    const subs = models.filter((m) => m.id.toLowerCase().includes(a) || (m.label || "").toLowerCase().includes(a))
    const match = exact ?? (subs.length === 1 ? (subs[0] ?? null) : null)
    if (!match) {
      // Ambiguous (>1) or no match: surface it rather than silently picking one.
      const msg =
        subs.length > 1
          ? `⚠️ "${arg}" matches multiple models: ${subs.map((m) => m.id).join(", ")}. Be more specific.`
          : `⚠️ Unknown model "${arg}". Available: ${models.map((m) => m.id).join(", ") || "(none yet)"}`
      ctx.appendMessage("assistant", msg)
      return
    }
    cc?._selectModel(match.id)
  }
  function dispatchEffort(arg: string): void {
    if (!arg) {
      if (dom.effortBtn.hidden) {
        ctx.appendMessage("assistant", "⚠️ Effort selection is not available for the current model.")
        return
      }
      openEffortPicker()
      return
    }
    const cc = ctx.getComposerConfig()
    const normalized = arg.toLowerCase() === "default" ? "" : arg.toLowerCase()
    if (normalized !== "") {
      const entry = cc ? cc._currentModelEntry() : null
      // `isEffortOption` is not an extra gate - a string outside the wire
      // vocabulary cannot be in `efforts`, which ComposerConfig narrows at the
      // hello boundary (#462). It just lets the check stay type-correct
      // instead of widening the array back to string[].
      const valid = entry ? isEffortOption(normalized) && entry.efforts.includes(normalized) : false
      if (!valid) {
        const avail = entry && entry.efforts.length ? entry.efforts.join(", ") : "none for this model"
        ctx.appendMessage("assistant", `⚠️ Unknown effort "${arg}". Available: ${avail}`)
        return
      }
    }
    cc?._selectEffort(normalized)
  }

  return { store, isOpenFn, openMenu, closeMenu, move, onInput, complete, accept, mousedownAccept, dispatch, buildCommands }
}

type SlashMenuEngine = ReturnType<typeof createSlashMenuEngine>

// ============================================================================
// React views
// ============================================================================

function useSlashMenuSnapshot(store: SlashMenuStore): SlashMenuSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

function SlashMenuRow({
  cmd,
  active,
  onMouseDown,
}: {
  cmd: SlashCommandItem
  active: boolean
  onMouseDown: () => void
}) {
  return (
    <div
      className={"slash-menu-item" + (active ? " active" : "")}
      role="option"
      aria-selected={active}
      id={"slash-opt-" + cmd.id}
      data-command={cmd.id}
      onMouseDown={(e) => {
        e.preventDefault()
        onMouseDown()
      }}
    >
      <span className="cmd">{"/" + cmd.id}</span>
      <span className="arghint">{cmd.arghint || ""}</span>
      <span className="desc">{cmd.desc || ""}</span>
      {cmd.source && cmd.source !== "ui" ? <span className="source-chip">{cmd.source}</span> : null}
    </div>
  )
}

/** Mounted INTO `#slash-menu` (container === host, same
 * hidden/aria-owning-itself idiom as ComposerConfig.tsx's `DeferredHintView`):
 * React owns the hint line + item rows AND the container's own `open` class
 * / `aria-hidden`. `messageInput`'s `aria-expanded`/`aria-activedescendant`
 * are a SEPARATE effect writing to an external node - mirrors vanilla's own
 * `_render()`, which wrote both the menu's classList and the textarea's
 * aria-* attributes from the same visibility computation. */
function SlashMenuView({
  store,
  container,
  messageInput,
  onRowSelect,
}: {
  store: SlashMenuStore
  container: HTMLElement
  messageInput: HTMLTextAreaElement
  onRowSelect: (index: number) => void
}) {
  const snap = useSlashMenuSnapshot(store)
  const visible = snap.open && snap.items.length > 0
  useLayoutEffect(() => {
    container.classList.toggle("open", visible)
    container.setAttribute("aria-hidden", String(!visible))
  }, [visible, container])
  useLayoutEffect(() => {
    // aria-activedescendant + aria-expanded belong on the FOCUSED control
    // (the textarea), not the listbox, so a screen reader resolves the
    // active option.
    messageInput.setAttribute("aria-expanded", String(visible))
    const activeItem = snap.items[snap.active]
    if (visible && activeItem) {
      messageInput.setAttribute("aria-activedescendant", "slash-opt-" + activeItem.id)
    } else {
      messageInput.removeAttribute("aria-activedescendant")
    }
  }, [visible, snap.items, snap.active, messageInput])
  return (
    <>
      <div className="slash-menu-hint" id="slash-menu-hint">
        Commands
      </div>
      {snap.items.map((cmd, i) => (
        <SlashMenuRow key={cmd.id} cmd={cmd} active={i === snap.active} onMouseDown={() => onRowSelect(i)} />
      ))}
    </>
  )
}

// ============================================================================
// Legacy bridge - the exact external method surface chat.html's inline
// script (keydown/input/blur listeners, the global Esc handler,
// ChatEngine.handleSubmit's typed "/cmd args" intercept) and the test suite
// (slash-menu.test.ts) already call.
// ============================================================================

export interface SlashMenuBridge {
  isOpen: () => boolean
  open: (items?: readonly SlashCommandItem[]) => void
  close: () => void
  move: (delta: number) => void
  accept: () => void
  complete: () => boolean
  onInput: () => void
  dispatch: (id: string, args: string) => void
  buildCommands: () => readonly SlashCommandItem[]
}

function createSlashMenuBridge(engine: SlashMenuEngine, messageInput: HTMLTextAreaElement): SlashMenuBridge {
  return {
    isOpen: engine.isOpenFn,
    open: engine.openMenu,
    close: engine.closeMenu,
    move: engine.move,
    accept: () => engine.accept(messageInput),
    complete: () => engine.complete(messageInput),
    onInput: () => engine.onInput(messageInput),
    dispatch: (id, args) => engine.dispatch(id, args, messageInput),
    buildCommands: engine.buildCommands,
  }
}

// ============================================================================
// Mount
// ============================================================================

export interface SlashMenuContainers {
  menu: HTMLElement | null // #slash-menu
  messageInput: HTMLTextAreaElement | null // #message-input
  modelMenu: HTMLElement | null // #model-cfg-menu
  modelBtn: HTMLElement | null // #model-cfg-btn
  effortMenu: HTMLElement | null // #effort-cfg-menu
  effortBtn: HTMLElement | null // #effort-cfg-btn
}

export interface SlashMenuMount {
  SlashMenu: SlashMenuBridge
}

/** Mounts the React-owned menu into `containers.menu` and returns the legacy
 * `{ SlashMenu }` bridge - matches every other mount*'s `if (host) ... else
 * null` degrade-to-no-op guard (see Attachments.tsx). All six containers are
 * required: the model/effort picker anchors are read synchronously by
 * `openModelPicker`/`openEffortPicker`, and `messageInput` is the only DOM
 * source of the composer's typed text this module reads/writes. */
export function mountSlashMenu(containers: SlashMenuContainers, ctx: SlashMenuCtx): SlashMenuMount | null {
  const { menu, messageInput, modelMenu, modelBtn, effortMenu, effortBtn } = containers
  if (!menu || !messageInput || !modelMenu || !modelBtn || !effortMenu || !effortBtn) return null

  const engine = createSlashMenuEngine(ctx, { modelMenu, modelBtn, effortMenu, effortBtn })

  flushSync(() => {
    createRoot(menu).render(
      <SlashMenuView
        store={engine.store}
        container={menu}
        messageInput={messageInput}
        onRowSelect={(i) => engine.mousedownAccept(i, messageInput)}
      />,
    )
  })

  return { SlashMenu: createSlashMenuBridge(engine, messageInput) }
}
