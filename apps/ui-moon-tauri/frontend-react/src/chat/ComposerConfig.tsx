/**
 * ComposerConfig.tsx - the composer's model + effort switcher, a React
 * replacement for chat.html's former inline `ComposerConfig` object (stack23
 * S16b). Owns the model/effort picks (localStorage `luna_model`/`luna_effort`,
 * both PRODUCT SURFACE - do not rename), the per-thread model/effort truth
 * (`State.threadModels` / `State.threadEfforts`, server-reported), and the
 * `set-thread-config` optimistic-revert protocol, and paints the button
 * labels, the two popover menus, and the deferred-apply hint via React
 * instead of the vanilla `_rebuildModelMenu`/`_rebuildEffortMenu`/
 * `_refreshLabels`'s manual `document.createElement` building.
 *
 * WIRED INTO chat.html via main-chat.tsx's `type="module"` script, which
 * calls `mountComposerConfig` and patches chat.html's `ComposerConfig` bare
 * identifier the same way it already does for `ChatState`/`ChatLoop`/
 * `Attachments` (see MessageList.tsx's and Attachments.tsx's module docs).
 * React must be mounted from inside that one bundled module graph only - a
 * second inline `type="module"` script loads a second react/react-dom copy
 * and throws "Invalid hook call".
 *
 * SEVEN DOM anchors, FIVE `createRoot` calls (chat.html's static markup
 * already declares all of them, none with meaningful static children, since
 * `createRoot(host).render()` owns and replaces ALL of host's children):
 * `#model-cfg-btn` / `#effort-cfg-btn` (React owns the label TEXT only - the
 * buttons' own `aria-expanded` and open-the-menu click listeners stay
 * outside React, see MENU OPEN/CLOSE below), `#model-cfg-menu` /
 * `#effort-cfg-menu` (React owns the hint line + item list; the menu's own
 * `open` class / `aria-hidden` stay outside React), and `#cfg-deferred-hint`
 * (React owns the text; its own `visible` class is a `useLayoutEffect` on
 * the SAME container, mirroring Attachments.tsx's `container.hidden`
 * pattern - single owner, no clobber risk). `#composer-config` (the
 * cluster) and `#effort-cfg-sep` get no root at all (only a `hidden`
 * toggle) - an empty React root would still legally wipe any existing
 * children for nothing rendered back, so `syncStructuralVisibility` below
 * syncs `cluster.hidden`, `effortBtn.hidden`, and `effortSep.hidden`
 * imperatively from the store on every notify instead - ONE function, ONE
 * write site per field, mirroring vanilla's `_refreshEffortVisibility`
 * setting both `DOM.effortCfgBtn.hidden` and `DOM.effortCfgSep.hidden`
 * unconditionally from a single call site (SlashMenu.tsx reads
 * `effortCfgBtn.hidden` as truth - its own `dispatchEffort`).
 *
 * MENU OPEN/CLOSE STAYS PLAIN DOM, ON PURPOSE: `#model-cfg-menu` /
 * `#effort-cfg-menu`'s own `open` class (and the buttons' `aria-expanded`)
 * is not a store-derived value - it is the pre-conversion PROTOCOL for this
 * popover, and SlashMenu.tsx's `/model`/`/effort` no-arg pickers (a separate
 * React module, converted in stack23 S16c) reach into these SAME DOM nodes
 * directly (`ComposerConfig.closeAllMenus()`, then `DOM.modelCfgMenu.
 * classList.add('open')` itself) to open them, bypassing this module's own
 * click handler entirely. If "open" became React state here, SlashMenu's
 * direct classList write would silently desync from it - the next unrelated
 * store notify would re-render the menu from a STALE `open: false` and yank
 * it shut out from under the user. Keeping open/close as plain DOM writes
 * (both here AND in SlashMenu.tsx) preserves DOM-classList-as-truth exactly
 * as the vanilla object had it (`anyMenuOpen()` always read the classList
 * live, tracking no "which menu is open" field of its own either).
 *
 * REPAINT GATE (`reconcileThreadConfig`): mirrors vanilla's own
 * `if (reverted || changed)` gate around `_rebuildModelMenu`/
 * `_rebuildEffortMenu`/`_refreshLabels`/`_refreshEffortVisibility` exactly -
 * a settled ack with nothing applied/rejected must leave every label, menu,
 * and the effort-visibility gate exactly as they were, even if
 * `State.activeThreadId` has since diverged (a drawer thread switch) -
 * repainting unconditionally would show the WRONG thread's config. A
 * deferred-only ack (no reverted/changed) still needs the hint to show, so
 * it writes ONLY the hint fields onto the CURRENT snapshot instead of
 * calling the full `publish()` - the same narrow write the deferred-hint's
 * own 4s auto-hide `setTimeout` uses below, both mirroring vanilla's
 * callback, which touched nothing but `DOM.cfgDeferredHint.classList`
 * directly.
 *
 * The PER-MENU, MENU-ITEMS-ONLY REPUBLISH constraint (menu open,
 * `applyModels`) and the cached `effortVisible` gate's narrow call-site list
 * are documented at their own implementation sites, not repeated here - see
 * `publishModelMenuItems`/`publishEffortMenuItems`'s own comments and
 * `refreshEffortVisibility`'s own comment, respectively.
 *
 * `_models`/`_currentModelEntry()` on the returned bridge return the LIVE
 * array/entry, matching what the vanilla object itself returned - see
 * `createComposerConfigBridge`'s own comment.
 */
import { useLayoutEffect, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
// @luna/ui-ws publishes only the "." export, which re-exports server.js plus
// every node-side bridge module alongside protocol.js - `import type` erases
// before bundling, so this is safe ONLY as long as it stays type-only (same
// warning, verbatim, as src/chat/chat-ctx.ts's own note on this import).
import type { ClientFrame } from "@luna/ui-ws"
// Unlike the type-only import above, this one is a RUNTIME import - and it is
// deliberately from @luna/tools/protocol-descriptor, not @luna/ui-ws.
// protocol-descriptor.ts is a zero-import leaf behind its own subpath export,
// so it bundles clean; @luna/ui-ws publishes a single "." export that also
// re-exports server.js plus six node-side bridges and must stay type-only.
// See that file's own comment for why the effort vocabulary lives there.
import { isEffortOption, type EffortOption } from "@luna/tools/protocol-descriptor"

// ============================================================================
// Types
// ============================================================================

export interface ModelEntry {
  readonly id: string
  readonly label: string
  /** Narrowed at the hello/cache boundary by `normalizeModelEntry` - see
   * there for the one behavior delta this buys (#462). Everything downstream
   * gets the closed wire union for free, which is what removed this file's
   * last `as`-assertion at the wire boundary. */
  readonly efforts: readonly EffortOption[]
}

/** The live, mutable slice of chat.html's `State` this module reads AND
 * writes. Callers (main-chat.tsx / chat-harness.ts) must return the SAME
 * object reference every other frame handler in chat.html's classic script
 * shares - not a copy - so optimistic writes here (and elsewhere) stay
 * visible to each other. `threadModels`/`threadEfforts` are exclusively
 * ComposerConfig's fields on `State` (nothing else in chat.html reads or
 * writes them - verified) but must still live on the shared object because
 * the test suite pokes them directly as a "the server already told us"
 * back door (see composer-config.test.ts's "per-thread model/effort truth"
 * describe block). */
export interface ComposerStateSlice {
  activeThreadId: string | null
  threadModels: Record<string, string>
  threadEfforts: Record<string, string>
  serverSupportsEffort: boolean
  selectedEffort: string | null
}

export interface ComposerConfigCtx {
  /** Returns the live State object, or null if it isn't wired up yet (a
   * defensive case that only arises in a harness that mounts before the
   * classic script has run - see mountComposerConfig's own note). */
  getState: () => ComposerStateSlice | null
  /** Sends a client frame over the live WS connection (WebSocketEngine.send),
   * typed against the canonical wire contract - see chat-host.ts's
   * `chatHostComposerCtx`, the sole builder of this ctx in production. */
  send: (frame: ClientFrame) => void
}

// COMPILE-TIME DRIFT GUARD, zero runtime cost (#462). This used to be a
// `type Effort = ...` alias existing only so `selectEffort` could assert onto
// it; the assertion is gone, but the underlying skew it papered over is worth
// keeping pinned. `EffortOption` comes from @luna/tools/protocol-descriptor
// (what the client validates against) and `set-thread-config`'s `effort`
// comes from @luna/ui-ws (what the server parses). They are separate
// declarations in separate packages, so nothing but this line forces them to
// agree - and they must agree in BOTH directions, or the client either
// advertises a token the server rejects or drops one the server accepts.
//
// The runtime half of the same guarantee is packages/tools/test/
// effort-parity.test.ts, which pins the leaf's list against chat-service's.
type FrameEffort = NonNullable<Extract<ClientFrame, { type: "set-thread-config" }>["effort"]>
type MutuallyAssignable<A extends B, B extends C, C = A> = true
/** Fails `tsc` if the two effort vocabularies ever diverge. */
export type EffortVocabularyIsInSync = MutuallyAssignable<EffortOption, FrameEffort, EffortOption>

interface RejectedField {
  readonly field?: unknown
  /** Unread anywhere - documents the ack wire shape only, so the field isn't
   * mistaken for dead surface and deleted. */
  readonly reason?: unknown
}

interface ThreadConfigAckFrame {
  readonly threadId?: unknown
  readonly model?: unknown
  readonly effort?: unknown
  readonly applied?: unknown
  readonly deferred?: unknown
  readonly rejected?: unknown
}

interface ComposerMenuItem {
  readonly id: string
  readonly label: string
  readonly selected: boolean
}

interface ComposerSnapshot {
  readonly composerVisible: boolean
  readonly modelLabel: string
  readonly modelMenuItems: readonly ComposerMenuItem[]
  readonly effortVisible: boolean
  readonly effortLabel: string
  /** Element 0 is always the "Default" item (id ""), unconditionally -
   * mirrors the vanilla `_rebuildEffortMenu`'s always-appended `defItem`. */
  readonly effortMenuItems: readonly ComposerMenuItem[]
  readonly deferredHintVisible: boolean
  readonly deferredHintText: string
}

/** Snapshot taken just before an optimistic localStorage write that
 * triggered a set-thread-config send. The server's thread-config ack
 * consumes it: `rejected` rolls the write back (localStorage + per-thread
 * maps + labels); `applied`/`deferred` discard it. Keys mirror the vanilla
 * object's `_pendingRevert` exactly - see reconcileThreadConfig below. */
interface PendingRevert {
  model?: string
  modelEffort?: string
  threadModel?: string | null
  effort?: string
  threadEffort?: string | null
}

// ============================================================================
// Pure helpers - ported 1:1 from the vanilla ComposerConfig object.
// ============================================================================

/** THE HELLO/CACHE BOUNDARY (#462). Normalizes a raw wire or localStorage
 * entry to `{ id, label, efforts }`, handling both the object shape and
 * legacy plain-id strings (an older moon build's cached model list).
 *
 * This is where an untrusted `string[]` becomes the closed `EffortOption[]`
 * union, validated with a real runtime guard rather than asserted. Doing it
 * HERE, once, is what lets every downstream reader - the menu builders,
 * `isEffortValidForCurrentModel`, and the `set-thread-config` construction
 * in `selectEffort` - be type-correct without a single `as`.
 *
 * THE ONE BEHAVIOR DELTA, deliberate: an effort the server advertises that
 * is not in the wire vocabulary is DROPPED rather than shown. Previously such
 * a row rendered, the user could pick it, and the server silently
 * `clampEffort`-ed it to something else - a menu item that lied about what it
 * would do. No capability is lost, because the server was never going to
 * honor the value. It is logged rather than swallowed so a genuine protocol
 * extension shows up as a console warning instead of a silently missing row. */
function normalizeModelEntry(entry: unknown): ModelEntry | null {
  if (typeof entry === "string") return { id: entry, label: entry, efforts: [] }
  if (entry && typeof entry === "object" && "id" in entry) {
    const raw = entry as { id: unknown; label?: unknown; efforts?: unknown }
    if (typeof raw.id === "string" && raw.id) {
      const advertised: unknown[] = Array.isArray(raw.efforts) ? raw.efforts : []
      const efforts = advertised.filter(isEffortOption)
      if (efforts.length !== advertised.length) {
        const unknown = advertised.filter((e) => !isEffortOption(e))
        console.warn(
          `[ComposerConfig] model "${raw.id}" advertised effort(s) outside the wire vocabulary; ` +
            `dropping ${JSON.stringify(unknown)}. If this is a real protocol extension, add it to ` +
            `EFFORT_OPTIONS in @luna/tools/protocol-descriptor.`,
        )
      }
      return {
        id: raw.id,
        label: typeof raw.label === "string" && raw.label ? raw.label : raw.id,
        efforts,
      }
    }
  }
  return null
}

/** ultracode surfaces at the TOP of the effort menu (the headline mode);
 * every other level stays in server order. */
function orderEfforts(efforts: readonly EffortOption[]): EffortOption[] {
  return [...efforts.filter((e) => e === "ultracode"), ...efforts.filter((e) => e !== "ultracode")]
}

/** Capitalize an effort id for display (low -> Low, xhigh -> Xhigh); ultracode
 * gets a headline label with a lightning glyph. */
function effortItemLabel(ef: string): string {
  return ef === "ultracode" ? "⚡ Ultracode" : ef.charAt(0).toUpperCase() + ef.slice(1)
}

// ============================================================================
// Plain (React-free) external store.
// ============================================================================

interface ComposerConfigStore {
  getSnapshot: () => ComposerSnapshot
  setSnapshot: (next: ComposerSnapshot) => void
  subscribe: (listener: () => void) => () => void
}

function createComposerConfigStore(initial: ComposerSnapshot): ComposerConfigStore {
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
// Engine - the business logic, unchanged in shape from the vanilla object;
// only the DOM-painting tail (_rebuildModelMenu/_rebuildEffortMenu/
// _refreshLabels/_refreshEffortVisibility) is gone, replaced by publish().
// ============================================================================

function createComposerConfigEngine(ctx: ComposerConfigCtx, closeMenus: () => void) {
  let models: ModelEntry[] = []
  const pendingRevert: PendingRevert = {}
  const deferredHint = { visible: false, text: "" }
  let deferredHintTimer: ReturnType<typeof setTimeout> | undefined
  // Cached, NOT recomputed by computeSnapshot - see refreshEffortVisibility's
  // own comment for the call-site constraint.
  let effortVisible = false

  /** The model id the composer should DISPLAY: the active thread's actual
   * model when the server has told us (thread-created / thread-list /
   * thread-config ack / smart-bar), else the operator's global pick. */
  function displayModelId(): string {
    const state = ctx.getState()
    const tid = state?.activeThreadId ?? null
    if (tid) {
      const known = state?.threadModels[tid]
      if (known) return known
    }
    return localStorage.getItem("luna_model") || ""
  }

  function displayModelEntry(): ModelEntry | null {
    const id = displayModelId()
    if (!id) return models[0] ?? null
    return models.find((m) => m.id === id) ?? null
  }

  /** The effort the composer should DISPLAY (active thread first). */
  function displayEffort(): string {
    const state = ctx.getState()
    const tid = state?.activeThreadId ?? null
    if (tid) {
      const known = state?.threadEfforts[tid]
      if (known) return known
    }
    return localStorage.getItem("luna_effort") || ""
  }

  /** The model entry for the GLOBAL new-thread pick - deliberately NOT
   * thread-aware, matching the vanilla `_currentModelEntry`. Used by
   * `isEffortValidForCurrentModel` (sendNewThread's gate) and by the effort
   * button's VISIBILITY gate, which - like vanilla - stays keyed off the
   * global pick even while its label/menu content is thread-aware. */
  function currentModelEntry(): ModelEntry | null {
    const id = localStorage.getItem("luna_model") || ""
    if (!id) return models[0] ?? null
    return models.find((m) => m.id === id) ?? null
  }

  function isEffortValidForCurrentModel(effort: string): boolean {
    const entry = currentModelEntry()
    // The `isEffortOption` prefix is not a second check - a string outside the
    // vocabulary cannot be in the narrowed array either, so this is the same
    // predicate, expressed without widening `efforts` back to string[].
    return !!(entry && isEffortOption(effort) && entry.efforts.includes(effort))
  }

  /** Recomputes the cached `effortVisible` flag - the vanilla object's
   * `_refreshEffortVisibility`. `supportsEffort !== undefined ? supportsEffort
   * : state.serverSupportsEffort` matches vanilla's own fallback exactly.
   * Call sites are deliberately limited to `applyCapability` and
   * `reconcileThreadConfig`'s `reverted || changed` branch - never
   * `applyModels`/`refreshComposer`/`selectModel`/`selectEffort`/
   * `recordThreadConfig`/menu open, which would re-gate the effort control
   * on every model/effort pick, something vanilla never did. */
  function refreshEffortVisibility(supportsEffort?: boolean): void {
    const state = ctx.getState()
    const supEff = supportsEffort !== undefined ? supportsEffort : !!state?.serverSupportsEffort
    const entry = currentModelEntry()
    const hasEfforts = !!(entry && entry.efforts.length > 0)
    effortVisible = supEff && hasEfforts
  }

  function computeSnapshot(): ComposerSnapshot {
    const modelId = displayModelId()
    const modelEntry = displayModelEntry()
    const modelLabel = modelEntry ? modelEntry.label : modelId || "Server default"
    const modelMenuItems: ComposerMenuItem[] = models.map((m) => ({
      id: m.id,
      label: m.label,
      selected: m.id === modelId,
    }))

    const effort = displayEffort()
    const orderedEfforts = orderEfforts(modelEntry?.efforts ?? [])
    const effortMenuItems: ComposerMenuItem[] = [
      { id: "", label: "Default", selected: !effort },
      ...orderedEfforts.map((ef) => ({ id: ef, label: effortItemLabel(ef), selected: ef === effort })),
    ]
    const effortLabel = effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : "Default"

    return {
      composerVisible: models.length > 0,
      modelLabel,
      modelMenuItems,
      effortVisible,
      effortLabel,
      effortMenuItems,
      deferredHintVisible: deferredHint.visible,
      deferredHintText: deferredHint.text,
    }
  }

  const store = createComposerConfigStore(computeSnapshot())
  // flushSync, not a bare setSnapshot: createRoot's automatic batching defers
  // a useSyncExternalStore-triggered re-render to a microtask even when the
  // trigger (a WS frame handler, a click, a setTimeout) runs outside any
  // React event - Attachments.tsx hit this exact issue first (see its
  // `renderSync` / module doc). Every external call site here (frame
  // handlers, SlashMenu, tests) expects the vanilla object's fully
  // synchronous DOM writes, so every publish forces its commit through
  // before returning.
  function publish(): void {
    flushSync(() => {
      store.setSnapshot(computeSnapshot())
    })
  }

  /** Writes ONLY the given fields onto the CURRENT snapshot, never a full
   * recompute - the one shared implementation of the narrow-write idiom
   * every partial repaint below needs (menu items on open, the deferred
   * hint's own text/visibility, the effort-visibility gate). Still goes
   * through `flushSync` for the same reason `publish` does. */
  function patchSnapshot(patch: Partial<ComposerSnapshot>): void {
    flushSync(() => {
      store.setSnapshot({ ...store.getSnapshot(), ...patch })
    })
  }

  /** Rebuilds ONLY `modelMenuItems` from the CURRENT display state, leaving
   * every other field (labels, `effortVisible`, `effortMenuItems`, the
   * deferred hint) exactly as last published. Mirrors vanilla's
   * `_rebuildModelMenu` exactly, which touched nothing but the model menu's
   * own DOM: opening the model popover after a drawer thread switch (which
   * flips `State.activeThreadId` with no ComposerConfig call) rebuilds the
   * menu's item list from the new thread, but the button label - and the
   * OTHER menu's items, even if it happens to be open - stay at whatever was
   * last painted until the next full `publish()`. */
  function publishModelMenuItems(): void {
    const fresh = computeSnapshot()
    patchSnapshot({ modelMenuItems: fresh.modelMenuItems })
  }

  /** Rebuilds ONLY `effortMenuItems` - the effort-menu counterpart of
   * `publishModelMenuItems`, mirroring vanilla's `_rebuildEffortMenu` exactly
   * (see that function's own comment for the shared rationale). */
  function publishEffortMenuItems(): void {
    const fresh = computeSnapshot()
    patchSnapshot({ effortMenuItems: fresh.effortMenuItems })
  }

  /** Rebuilds the model menu items and both button labels, never the effort
   * menu items - the vanilla `applyModels` called ONLY `_rebuildModelMenu()` +
   * `_refreshLabels()`, NEVER `_rebuildEffortMenu()`. This runs on EVERY
   * `hello` frame (chat.html's `applyAvailableModels`, whose own doc notes
   * "Reconnects re-deliver hello"): a full `publish()` here would repaint an
   * OPEN effort popover's item list out from under the user on a mere
   * reconnect, something vanilla never did. */
  function applyModels(raw: unknown): void {
    models = (Array.isArray(raw) ? raw : []).map(normalizeModelEntry).filter((m): m is ModelEntry => m !== null)
    const fresh = computeSnapshot()
    patchSnapshot({
      composerVisible: fresh.composerVisible,
      modelLabel: fresh.modelLabel,
      effortLabel: fresh.effortLabel,
      modelMenuItems: fresh.modelMenuItems,
    })
  }

  /** Capability gate - the vanilla object's `applyCapability`, called once
   * per hello after the model list is already applied. Vanilla's version
   * called ONLY `_refreshEffortVisibility` (writing `effortCfgBtn.hidden`/
   * `effortCfgSep.hidden`), never `_refreshLabels` - a full `publish()` here
   * would repaint both button labels from whatever `State.activeThreadId`
   * is NOW, which can have diverged (a drawer thread switch) from the
   * thread the labels were last correctly painted for. */
  function applyCapability(supportsEffort: boolean): void {
    refreshEffortVisibility(supportsEffort)
    patchSnapshot({ effortVisible })
  }

  /** Write an effort pick to localStorage + State ('' clears it). */
  function writeEffort(value: string | null | undefined): void {
    const state = ctx.getState()
    if (value) {
      localStorage.setItem("luna_effort", value)
      if (state) state.selectedEffort = value
    } else {
      localStorage.removeItem("luna_effort")
      if (state) state.selectedEffort = null
    }
  }

  /** Persist model selection, refresh, send mid-thread config if live. */
  function selectModel(id: string): void {
    const state = ctx.getState()
    const prev = localStorage.getItem("luna_model") || ""
    if (id) {
      localStorage.setItem("luna_model", id)
    } else {
      localStorage.removeItem("luna_model")
    }
    // Validate effort for the new model; clear if no longer in its list.
    const entry = models.find((m) => m.id === id) ?? models[0] ?? null
    const savedEffort = localStorage.getItem("luna_effort") || ""
    // A saved effort outside the vocabulary is by definition not offered by
    // this model, so it clears exactly as an out-of-matrix one always did.
    if (savedEffort && entry && !(isEffortOption(savedEffort) && entry.efforts.includes(savedEffort))) {
      localStorage.removeItem("luna_effort")
      if (state) state.selectedEffort = null
    }
    closeMenus()
    // Mid-thread: change detection compares against the thread's ACTUAL
    // model when known (not the global localStorage pick) - otherwise
    // re-picking your global default on a thread running something else
    // silently no-ops.
    const tid = state?.activeThreadId ?? null
    const liveCurrent = (tid && state?.threadModels[tid]) || prev
    if (tid && state?.serverSupportsEffort && id !== liveCurrent && id) {
      pendingRevert.model = prev
      pendingRevert.modelEffort = savedEffort
      pendingRevert.threadModel = Object.prototype.hasOwnProperty.call(state.threadModels, tid)
        ? (state.threadModels[tid] ?? null)
        : null
      state.threadModels[tid] = id // optimistic - ack reconciles
      ctx.send({ type: "set-thread-config", threadId: tid, model: id })
    }
    publish()
  }

  /** Persist effort selection, refresh, send mid-thread config if live. */
  function selectEffort(effort: string): void {
    const state = ctx.getState()
    const prev = localStorage.getItem("luna_effort") || ""
    writeEffort(effort)
    closeMenus()
    const tid = state?.activeThreadId ?? null
    const liveCurrent = (tid && state?.threadEfforts[tid]) || prev
    // `isEffortOption` replaces what used to be a bare `&& effort` truthiness
    // check AND the `as Effort` assertion that stood here (#462). It is
    // behavior-identical: the only non-vocabulary value that ever reached this
    // line was the Default row's `""`, which `&& effort` already excluded, and
    // every other caller is pre-validated against `entry.efforts` - which
    // `normalizeModelEntry` now narrows at the boundary. The difference is
    // that the frame below is type-correct by CONSTRUCTION instead of by
    // assertion, so a future protocol change breaks the build here.
    if (tid && state?.serverSupportsEffort && effort !== liveCurrent && isEffortOption(effort)) {
      pendingRevert.effort = prev
      pendingRevert.threadEffort = Object.prototype.hasOwnProperty.call(state.threadEfforts, tid)
        ? (state.threadEfforts[tid] ?? null)
        : null
      state.threadEfforts[tid] = effort // optimistic - ack reconciles
      ctx.send({ type: "set-thread-config", threadId: tid, effort })
    }
    publish()
  }

  /** Record a thread's ACTUAL config as reported by the server. Sources:
   * thread-created / thread-list summaries, thread-config acks, smart-bar
   * model pills. Pass null/undefined for a field to leave it untouched. */
  function recordThreadConfig(threadId: unknown, model: unknown, effort: unknown): void {
    // Truthy-only, matching vanilla's `if (!threadId) return` exactly - not
    // narrowed to `typeof === "string"`. A non-string truthy id is written
    // through anyway (String(key) below reproduces the implicit
    // object-key coercion vanilla got for free); only null/undefined/""/0
    // are rejected.
    if (!threadId) return
    const key = String(threadId)
    const state = ctx.getState()
    if (!state) return
    let changed = false
    if (typeof model === "string" && model) {
      if (state.threadModels[key] !== model) {
        state.threadModels[key] = model
        changed = true
      }
    }
    if (typeof effort === "string" && effort) {
      if (state.threadEfforts[key] !== effort) {
        state.threadEfforts[key] = effort
        changed = true
      }
    }
    if (changed && threadId === state.activeThreadId) publish()
  }

  /** Reconcile a `thread-config` server ack. `applied` confirms picks
   * (recording the EFFECTIVE value the server echoes - effort may have been
   * clamped, ultracode normalized); `deferred` shows a fading hint;
   * `rejected` rolls the optimistic write back to the send-time snapshot. */
  function reconcileThreadConfig(rawFrame: unknown): void {
    if (!rawFrame || typeof rawFrame !== "object") return
    const frame = rawFrame as ThreadConfigAckFrame
    const applied = Array.isArray(frame.applied) ? (frame.applied as unknown[]) : []
    const deferred = Array.isArray(frame.deferred) ? (frame.deferred as unknown[]) : []
    const rejected = Array.isArray(frame.rejected) ? (frame.rejected as RejectedField[]) : []

    if (deferred.length > 0) {
      const fields = deferred.join(" & ")
      deferredHint.visible = true
      // "next conversation", not "next message": a cross-lane deferred
      // model only takes effect on a NEW thread (or restart+resubscribe) -
      // the live thread keeps its model regardless of further messages.
      deferredHint.text = `${fields} applies to next conversation`
      clearTimeout(deferredHintTimer)
      deferredHintTimer = setTimeout(() => {
        deferredHint.visible = false
        // Flips ONLY the hint's own visibility on the CURRENT snapshot,
        // never a full `publish()` recompute - mirrors vanilla's callback,
        // which touched nothing but `DOM.cfgDeferredHint.classList`.
        patchSnapshot({ deferredHintVisible: false })
      }, 4000)
    }

    const state = ctx.getState()
    const ackThreadId = typeof frame.threadId === "string" ? frame.threadId : ""
    // `changed`/`reverted` mirror the vanilla object's own locals of the same
    // name - they gate refreshEffortVisibility below exactly the way vanilla
    // gated its `_refreshEffortVisibility()` call (never unconditionally).
    let changed = false
    if (ackThreadId && state) {
      if (applied.includes("model") && typeof frame.model === "string" && frame.model) {
        state.threadModels[ackThreadId] = frame.model
        changed = true
      }
      if (applied.includes("effort") && typeof frame.effort === "string" && frame.effort) {
        state.threadEfforts[ackThreadId] = frame.effort
        changed = true
      }
    }

    let reverted = false
    for (const r of rejected) {
      if (!r) continue
      if (r.field === "model" && pendingRevert.model !== undefined) {
        const prevModel = pendingRevert.model
        if (prevModel) {
          localStorage.setItem("luna_model", prevModel)
        } else {
          localStorage.removeItem("luna_model")
        }
        // The model pick may have cascade-cleared the effort - restore it too.
        if (pendingRevert.modelEffort !== undefined) writeEffort(pendingRevert.modelEffort)
        if (ackThreadId && state && pendingRevert.threadModel !== undefined) {
          if (pendingRevert.threadModel === null) {
            delete state.threadModels[ackThreadId]
          } else {
            state.threadModels[ackThreadId] = pendingRevert.threadModel
          }
        }
        reverted = true
      }
      if (r.field === "effort" && pendingRevert.effort !== undefined) {
        writeEffort(pendingRevert.effort)
        if (ackThreadId && state && pendingRevert.threadEffort !== undefined) {
          if (pendingRevert.threadEffort === null) {
            delete state.threadEfforts[ackThreadId]
          } else {
            state.threadEfforts[ackThreadId] = pendingRevert.threadEffort
          }
        }
        reverted = true
      }
    }

    // Every field in this ack is settled - drop its snapshot (applied and
    // deferred keep the optimistic value; rejected was restored above).
    const settled = [...applied, ...deferred, ...rejected.map((r) => r?.field)]
    for (const f of settled) {
      if (f === "model") {
        delete pendingRevert.model
        delete pendingRevert.modelEffort
        delete pendingRevert.threadModel
      }
      if (f === "effort") {
        delete pendingRevert.effort
        delete pendingRevert.threadEffort
      }
    }

    // Mirrors vanilla's own `if (reverted || changed)` repaint gate exactly
    // - a settled ack with nothing applied/deferred/rejected must not force
    // a recompute from whatever State/localStorage look like NOW, which can
    // have diverged (a drawer thread switch) from what this ack is even
    // about.
    if (reverted || changed) {
      refreshEffortVisibility()
      publish()
    } else if (deferred.length > 0) {
      // A deferred-only ack still needs the hint to show, but must not
      // recompute labels/menus from state that may have diverged since this
      // ack was sent - writes ONLY the hint fields onto the CURRENT
      // snapshot, exactly like the 4s auto-hide callback above.
      patchSnapshot({ deferredHintVisible: deferredHint.visible, deferredHintText: deferredHint.text })
    }
  }

  return {
    store,
    publish,
    publishModelMenuItems,
    publishEffortMenuItems,
    getModels: () => models,
    normalizeEntry: normalizeModelEntry,
    applyModels,
    applyCapability,
    currentModelEntry,
    isEffortValidForCurrentModel,
    selectModel,
    selectEffort,
    recordThreadConfig,
    reconcileThreadConfig,
  }
}

type ComposerConfigEngine = ReturnType<typeof createComposerConfigEngine>

// ============================================================================
// React views
// ============================================================================

function useComposerSnapshot(store: ComposerConfigStore): ComposerSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

function ModelLabelView({ store }: { store: ComposerConfigStore }) {
  const snap = useComposerSnapshot(store)
  return <>{snap.modelLabel}</>
}

/** Mounted INTO `#effort-cfg-btn` itself. Owns the label TEXT only - the
 * button's own `hidden` attribute is written by `syncStructuralVisibility`
 * below, alongside `#effort-cfg-sep`'s, so both re-assert from the SAME
 * `effortVisible` read on every store notify (see this module's doc). */
function EffortLabelView({ store }: { store: ComposerConfigStore }) {
  const snap = useComposerSnapshot(store)
  return <>{snap.effortLabel}</>
}

/** One popover row. EVERY row activates on Enter and Space, including the
 * effort menu's "Default" row.
 *
 * Vanilla wired a keydown listener to every row EXCEPT that one, so it
 * advertised `role="menuitemradio"` with `tabIndex={0}` while responding to
 * the mouse only - a keyboard user could focus it and not activate it (WCAG
 * 2.1.1 Keyboard). S16b preserved the asymmetry deliberately to keep the
 * conversion behavior-free and filed it as #459; this is that issue's
 * fix-or-remove resolution, taking the "fix" branch because a mouse-only row
 * inside a keyboard-navigable menu is a defect, not a feature.
 *
 * The ONE deliberate delta from vanilla in this file. */
function MenuItemRow({
  item,
  kind,
  onSelect,
}: {
  item: ComposerMenuItem
  /** Which popover this row belongs to - only used to reproduce the
   * vanilla items' `dataset.modelId` / `dataset.effortId` marker (unread by
   * any PRODUCT code today - only composer-config.test.ts's own DOM-query
   * assertions read it - kept for DOM parity). */
  kind: "model" | "effort"
  onSelect: (id: string) => void
}) {
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      // preventDefault on Space stops the page scrolling out from under an
      // open popover; on Enter it stops a stray form submit.
      e.preventDefault()
      onSelect(item.id)
    }
  }
  return (
    <div
      className={"cfg-menu-item" + (item.selected ? " selected" : "")}
      tabIndex={0}
      role="menuitemradio"
      aria-checked={item.selected}
      onClick={() => onSelect(item.id)}
      data-model-id={kind === "model" ? item.id : undefined}
      data-effort-id={kind === "effort" ? item.id : undefined}
      onKeyDown={handleKeyDown}
    >
      <span>{item.label}</span>
      <span className="cfg-menu-check" aria-hidden="true">
        {"✓"}
      </span>
    </div>
  )
}

function ModelMenuView({ store, onSelect }: { store: ComposerConfigStore; onSelect: (id: string) => void }) {
  const snap = useComposerSnapshot(store)
  return (
    <>
      <div className="cfg-menu-hint">Model for new conversations</div>
      {snap.modelMenuItems.map((m) => (
        <MenuItemRow key={m.id} item={m} kind="model" onSelect={onSelect} />
      ))}
    </>
  )
}

function EffortMenuView({ store, onSelect }: { store: ComposerConfigStore; onSelect: (effort: string) => void }) {
  const snap = useComposerSnapshot(store)
  const defaultItem = snap.effortMenuItems[0]
  const rest = snap.effortMenuItems.slice(1)
  return (
    <>
      <div className="cfg-menu-hint">Effort level</div>
      {defaultItem ? <MenuItemRow item={defaultItem} kind="effort" onSelect={onSelect} /> : null}
      {rest.map((item) => (
        <MenuItemRow key={item.id} item={item} kind="effort" onSelect={onSelect} />
      ))}
    </>
  )
}

/** Mounted INTO `#cfg-deferred-hint` (container === host): owns the text
 * children AND the container's own `visible` class via `useLayoutEffect`,
 * mirroring Attachments.tsx's container-owns-its-own-attribute pattern. */
function DeferredHintView({ store, container }: { store: ComposerConfigStore; container: HTMLElement }) {
  const snap = useComposerSnapshot(store)
  useLayoutEffect(() => {
    container.classList.toggle("visible", snap.deferredHintVisible)
  }, [snap.deferredHintVisible, container])
  return <>{snap.deferredHintText}</>
}

// ============================================================================
// Legacy bridge - the exact external method surface chat.html's inline
// script (WebSocketEngine.sendNewThread, the hello/thread-config/thread-list/
// thread-created/smart-bar frame handlers) and SlashMenu.tsx (converted in
// stack23 S16c) already call, plus the test suite (composer-config.test.ts,
// slash-menu.test.ts).
// ============================================================================

export interface ComposerConfigBridge {
  readonly _models: readonly ModelEntry[]
  _normalizeEntry: (entry: unknown) => ModelEntry | null
  _currentModelEntry: () => ModelEntry | null
  _rebuildModelMenu: () => void
  _rebuildEffortMenu: () => void
  _selectModel: (id: string) => void
  _selectEffort: (effort: string) => void
  closeAllMenus: () => void
  anyMenuOpen: () => boolean
  applyModels: (models: unknown) => void
  applyCapability: (supportsEffort: boolean) => void
  isEffortValidForCurrentModel: (effort: string) => boolean
  recordThreadConfig: (threadId: unknown, model: unknown, effort: unknown) => void
  refreshComposer: () => void
  reconcileThreadConfig: (frame: unknown) => void
}

function createComposerConfigBridge(
  engine: ComposerConfigEngine,
  dom: { closeAllMenus: () => void; anyMenuOpen: () => boolean },
): ComposerConfigBridge {
  return {
    // `_models`/`_currentModelEntry()` hand back the engine's LIVE
    // array/entry, not a defensive copy - callers must not mutate them.
    get _models() {
      return engine.getModels()
    },
    _normalizeEntry: engine.normalizeEntry,
    _currentModelEntry: engine.currentModelEntry,
    _rebuildModelMenu: () => engine.publishModelMenuItems(),
    _rebuildEffortMenu: () => engine.publishEffortMenuItems(),
    _selectModel: engine.selectModel,
    _selectEffort: engine.selectEffort,
    closeAllMenus: dom.closeAllMenus,
    anyMenuOpen: dom.anyMenuOpen,
    applyModels: engine.applyModels,
    applyCapability: engine.applyCapability,
    isEffortValidForCurrentModel: engine.isEffortValidForCurrentModel,
    recordThreadConfig: engine.recordThreadConfig,
    refreshComposer: () => engine.publish(),
    reconcileThreadConfig: engine.reconcileThreadConfig,
  }
}

// ============================================================================
// Mount
// ============================================================================

export interface ComposerConfigContainers {
  cluster: HTMLElement | null // #composer-config
  modelBtn: HTMLElement | null // #model-cfg-btn
  modelMenu: HTMLElement | null // #model-cfg-menu
  effortBtn: HTMLElement | null // #effort-cfg-btn
  effortMenu: HTMLElement | null // #effort-cfg-menu
  effortSep: HTMLElement | null // #effort-cfg-sep
  deferredHint: HTMLElement | null // #cfg-deferred-hint
}

export interface ComposerConfigMount {
  ComposerConfig: ComposerConfigBridge
}

/** Mounts the React-owned labels/menus/hint into `containers` (chat.html's
 * composer-config cluster) and returns the legacy `{ ComposerConfig }`
 * bridge - matches every other mount*'s `if (host) ... else null` degrade-
 * to-no-op guard (see Attachments.tsx). All seven containers are required:
 * a partial mount would leave some views permanently unsynced with the rest
 * of the shared store. */
export function mountComposerConfig(
  containers: ComposerConfigContainers,
  ctx: ComposerConfigCtx,
): ComposerConfigMount | null {
  const { cluster, modelBtn, modelMenu, effortBtn, effortMenu, effortSep, deferredHint } = containers
  if (!cluster || !modelBtn || !modelMenu || !effortBtn || !effortMenu || !effortSep || !deferredHint) return null

  // ── Menu open/close: plain DOM, shared with SlashMenu.tsx - see this
  // module's doc for why this never becomes React state. Arrows, not
  // function declarations - the guard's narrowing does not reach a hoisted
  // function body. ──────────────────────────────────────────────────────
  const closeAllMenus = (): void => {
    modelMenu.classList.remove("open")
    modelMenu.setAttribute("aria-hidden", "true")
    effortMenu.classList.remove("open")
    effortMenu.setAttribute("aria-hidden", "true")
    modelBtn.setAttribute("aria-expanded", "false")
    effortBtn.setAttribute("aria-expanded", "false")
  }
  const anyMenuOpen = (): boolean => {
    return modelMenu.classList.contains("open") || effortMenu.classList.contains("open")
  }

  const engine = createComposerConfigEngine(ctx, closeAllMenus)

  // Bootstrap: read persisted effort from localStorage into State - see
  // ComposerStateSlice's doc for why this write, though otherwise unread
  // anywhere in chat.html today, must still go through the SAME live State
  // object every other frame handler shares. Guarded (not asserted): a
  // harness that mounts before the classic script has assigned `State` yet
  // degrades this one dead write to a no-op rather than throwing.
  const state = ctx.getState()
  if (state) state.selectedEffort = localStorage.getItem("luna_effort") || null

  modelBtn.addEventListener("click", (e) => {
    e.stopPropagation()
    const open = modelMenu.classList.contains("open")
    closeAllMenus()
    if (!open) {
      // Rebuild the MODEL menu items only before showing - see
      // publishModelMenuItems's own comment for why this isn't the full
      // publish() and isn't publishEffortMenuItems too.
      engine.publishModelMenuItems()
      modelMenu.classList.add("open")
      modelMenu.setAttribute("aria-hidden", "false")
      modelBtn.setAttribute("aria-expanded", "true")
    }
  })
  effortBtn.addEventListener("click", (e) => {
    e.stopPropagation()
    const open = effortMenu.classList.contains("open")
    closeAllMenus()
    if (!open) {
      // Same rebuild-on-open as modelBtn above - vanilla's `_rebuildEffortMenu()`.
      engine.publishEffortMenuItems()
      effortMenu.classList.add("open")
      effortMenu.setAttribute("aria-hidden", "false")
      effortBtn.setAttribute("aria-expanded", "true")
    }
  })
  document.addEventListener("click", () => closeAllMenus())

  // ── React-owned content. ─────────────────────────────────────────────────
  flushSync(() => {
    createRoot(modelBtn).render(<ModelLabelView store={engine.store} />)
    createRoot(effortBtn).render(<EffortLabelView store={engine.store} />)
    createRoot(modelMenu).render(<ModelMenuView store={engine.store} onSelect={engine.selectModel} />)
    createRoot(effortMenu).render(<EffortMenuView store={engine.store} onSelect={engine.selectEffort} />)
    createRoot(deferredHint).render(<DeferredHintView store={engine.store} container={deferredHint} />)
  })

  // `#composer-config` / `#effort-cfg-sep` need no rendered children at all
  // (only a hidden toggle) - see this module's doc for why that stays a
  // plain subscription instead of an empty React root. `effortBtn.hidden` is
  // asserted here too, alongside `effortSep.hidden`, from the same read -
  // ONE write site for both, mirroring vanilla's `_refreshEffortVisibility`
  // (see this module's doc; SlashMenu reads `effortCfgBtn.hidden` as truth).
  const syncStructuralVisibility = () => {
    const snap = engine.store.getSnapshot()
    cluster.hidden = !snap.composerVisible
    effortBtn.hidden = !snap.effortVisible
    effortSep.hidden = !snap.effortVisible
  }
  syncStructuralVisibility()
  engine.store.subscribe(syncStructuralVisibility)

  return { ComposerConfig: createComposerConfigBridge(engine, { closeAllMenus, anyMenuOpen }) }
}
