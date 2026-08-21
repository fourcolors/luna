/**
 * SmartBarEngine.tsx - the composer's context-pill Smart Bar, a React
 * replacement for chat.html's former inline `SmartBarEngine` const object
 * (stack23 S16d). Renders server-pushed `smart-bar` frame items as pills
 * above the composer row; unknown `kind`s are silently skipped (v1: `info`
 * only), and the bar hides itself when the item list is empty - unchanged
 * from vanilla. This is the LAST inline-DOM composer subsystem; converting
 * it completes the composer arc started at S16a (Attachments.tsx).
 *
 * WIRED INTO chat.html via main-chat.tsx's `type="module"` script, exactly
 * like Attachments.tsx / ComposerConfig.tsx / SlashMenu.tsx: `var
 * SmartBarEngine;` is forward-declared in chat.html (== `window.SmartBarEngine`
 * for a classic script) and the ONE call site (the `smart-bar` frame
 * handler) keeps calling that same bare identifier. See chat.html's own
 * comment on the `var SmartBarEngine` declaration and Attachments.tsx's
 * module doc for why a second `type="module"` script must never mount a
 * second React copy.
 *
 * ONE DOM anchor, ONE `createRoot` call: `#smart-bar` - React owns the pill
 * list AND the container's own `hidden` attribute via a `useLayoutEffect` on
 * that same container, mirroring Attachments.tsx's `container.hidden`
 * pattern (single owner, no clobber risk). No other module reaches into
 * `#smart-bar`.
 *
 * NO LunaChatHost READ: unlike SlashMenu.tsx/ComposerConfig.tsx, this module
 * is a pure downstream renderer of whatever `frame.items` the `smart-bar`
 * frame handler hands to `applyFrame` - it never reads chat.html state or
 * calls back into an engine, so it needs no `chat-host.ts` ctx/member and
 * touches neither `luna-chat-host.d.ts` nor `CHAT_HOST_MEMBERS`.
 *
 * ESCAPING, AN INVISIBLE-ONLY DELTA: vanilla's `_esc` manually HTML-escaped
 * `label`/`value`/`icon`/`tooltip` before building an `innerHTML` string
 * (`&`/`<`/`>`/`"`). JSX text children and attribute values are written via
 * `textContent`/`setAttribute`, never parsed as markup, so they are safe
 * without a hand-rolled escaper - the RENDERED characters are identical
 * either way (see the differential probe in slash-menu.test.ts asserting a
 * `<b>` label renders as literal text, never as a child element). `_esc`
 * itself has no React counterpart.
 *
 * PARITY IS MECHANICALLY PROVEN, not just argued: smart-bar-parity.test.ts
 * holds a frozen verbatim copy of the deleted vanilla object and runs it
 * against this module over one shared input table, comparing structural DOM
 * snapshots. That table is where the awkward cases live - falsy-but-present
 * values (`0`, `''`, `null`, `false`), object values, non-numeric
 * `priority`, empty-string `tooltip`/`label`/`icon`, malformed frames, and
 * multi-frame sequences. Add a case there before changing anything below.
 */
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"

// ============================================================================
// Types - mirror the `smart-bar` frame's item shape (packages/ui-ws protocol)
// 1:1 with the vanilla object's untyped reads.
// ============================================================================

export interface SmartBarItem {
  readonly id: string
  readonly kind: string
  readonly label?: string
  readonly value?: unknown
  readonly icon?: string
  readonly tooltip?: string
  readonly tone?: string
  readonly group?: string
  readonly priority?: number
}

export interface SmartBarFrame {
  readonly items?: readonly SmartBarItem[]
}

// ============================================================================
// Plain (React-free) external store - mirrors chatModel.ts's shape.
// ============================================================================

interface SmartBarStore {
  getItems: () => readonly SmartBarItem[]
  setItems: (items: readonly SmartBarItem[]) => void
  subscribe: (listener: () => void) => () => void
  notify: () => void
}

function createSmartBarStore(): SmartBarStore {
  let items: readonly SmartBarItem[] = []
  const listeners = new Set<() => void>()
  return {
    getItems: () => items,
    setItems: (next) => {
      items = next
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    notify: () => {
      for (const listener of listeners) listener()
    },
  }
}

/** Only `kind==="info"` items render (v1); sorted by group then priority
 * (lower priority number = leftmost) - a stable client-side re-sort applied
 * on top of the server's own ordering, verbatim from vanilla's `_render`. */
function sortInfoItems(items: readonly SmartBarItem[]): SmartBarItem[] {
  return items
    .filter((item) => item.kind === "info")
    .slice()
    .sort((a, b) => {
      const ga = a.group || ""
      const gb = b.group || ""
      if (ga < gb) return -1
      if (ga > gb) return 1
      const pa = typeof a.priority === "number" ? a.priority : 999
      const pb = typeof b.priority === "number" ? b.priority : 999
      return pa - pb
    })
}

// ============================================================================
// React views
// ============================================================================

function useSmartBarItems(store: SmartBarStore): readonly SmartBarItem[] {
  return useSyncExternalStore(store.subscribe, store.getItems, store.getItems)
}

/** One pill. Class/attr logic ported 1:1 from vanilla's `_renderItem`:
 * `git.worktree` gets the flagship accent, `tone` maps to `sb-good`/
 * `sb-warn`, and the icon/label/value spans are omitted entirely (not just
 * emptied) when the item doesn't carry them. */
function SmartBarPill({ item }: { item: SmartBarItem }) {
  const toneClass = item.tone === "good" ? " sb-good" : item.tone === "warn" ? " sb-warn" : ""
  const flagshipClass = item.id === "git.worktree" ? " sb-flagship" : ""
  return (
    <span className={`sb-item${flagshipClass}${toneClass}`} title={item.tooltip || undefined}>
      {item.icon ? (
        <span className="sb-ic" aria-hidden="true">
          {item.icon}
        </span>
      ) : null}
      {item.label ? <span className="sb-lbl">{item.label}</span> : null}
      {item.value !== undefined ? <span className="sb-val">{String(item.value)}</span> : null}
    </span>
  )
}

/** Mounted INTO `#smart-bar` (container === host, same self-owning
 * hidden-attribute idiom as Attachments.tsx's strip/error views): React owns
 * the pill list AND the container's own `hidden` attribute. */
function SmartBarView({ store, container }: { store: SmartBarStore; container: HTMLElement }) {
  const items = useSmartBarItems(store)
  const infoItems = useMemo(() => sortInfoItems(items), [items])
  useLayoutEffect(() => {
    container.hidden = infoItems.length === 0
  }, [infoItems.length, container])
  return (
    <>
      {infoItems.map((item, index) => (
        // Key carries the index, not `item.id` alone: nothing upstream
        // guarantees ids are unique (vanilla built an innerHTML string and
        // never cared), and duplicate React keys are documented as
        // unsupported with behavior that "could change in a future version".
        // The rendered DOM is identical either way - see the duplicate-ids
        // case in smart-bar-parity.test.ts - because a pill holds no state,
        // ref, or transition, so there is no reconciliation identity to
        // preserve across a re-sort.
        <SmartBarPill key={`${item.id}:${index}`} item={item} />
      ))}
    </>
  )
}

// ============================================================================
// Legacy bridge - the exact external method surface chat.html's `smart-bar`
// frame handler already calls against the vanilla object.
// ============================================================================

export interface SmartBarBridge {
  /** Replaces the current bar contents wholesale from a `smart-bar` frame's
   * item list and toggles visibility - matches vanilla's `applyFrame`. */
  applyFrame: (frame: SmartBarFrame) => void
}

function createSmartBarBridge(store: SmartBarStore): SmartBarBridge {
  return {
    applyFrame(frame) {
      store.setItems(Array.isArray(frame.items) ? frame.items : [])
      // flushSync, not a bare notify: the frame handler (and every existing
      // test driving it) expects the vanilla object's fully synchronous DOM
      // write, same reasoning as Attachments.tsx's `renderSync`.
      flushSync(() => store.notify())
    },
  }
}

// ============================================================================
// Mount
// ============================================================================

export interface SmartBarMount {
  SmartBarEngine: SmartBarBridge
}

/** Mounts the React-owned pill list into `container` (chat.html's
 * `#smart-bar`) and returns the legacy `{ SmartBarEngine }` bridge - matches
 * every other mount*'s `if (host) ... else null` degrade-to-no-op guard (see
 * Attachments.tsx). */
export function mountSmartBar(container: HTMLElement | null): SmartBarMount | null {
  if (!container) return null
  const store = createSmartBarStore()
  const bridge = createSmartBarBridge(store)
  flushSync(() => {
    createRoot(container).render(<SmartBarView store={store} container={container} />)
  })
  return { SmartBarEngine: bridge }
}
