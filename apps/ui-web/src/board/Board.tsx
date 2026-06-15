/**
 * Board.tsx — render layer for the Luna Studio board (engine:
 * ./createBoard.ts, chrome: ./board.css). Ported from the design handoff's
 * luna-app.jsx JSX (~/Downloads/Brainstorm/project/luna-app.jsx).
 *
 * <Board> renders the canvas: floating panels (head = wash-dot + Caveat
 * title + star/min/close, body = the app-provided component), snap guides,
 * stickies pin badges, and the mode hint. <Shelf> renders the closed-panel
 * chips for the topbar. <FavoritesGrid> is the favorites panel body.
 */
import {
  type Component,
  type JSX,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js"
import { HEAD_H, tiltFor, type Board as BoardEngine } from "./createBoard.js"

export interface BoardPanelDef {
  id: string
  title: string
  /** Index into the palette washes (--wash-0..4) for this panel's tint. */
  tint: number
  render: () => JSX.Element
  /** Hide the ☆ (e.g. on the favorites panel itself). */
  noStar?: boolean
  /**
   * Reactive visibility gate (capability checks). The def OBJECTS must stay
   * referentially stable for the app's lifetime — a def list rebuilt inside
   * a memo would remount every panel body (ChatPanel would lose composer
   * state) whenever any tracked read changed. `when` keeps the gating
   * reactive while the defs stay still.
   */
  when?: () => boolean
}

interface BoardProps {
  board: BoardEngine
  defs: BoardPanelDef[]
}

const activeOf = (defs: BoardPanelDef[]): BoardPanelDef[] =>
  defs.filter((d) => (d.when ? d.when() : true))

export const Board: Component<BoardProps> = (props) => {
  let canvas!: HTMLDivElement
  const [hint, setHint] = createSignal(false)

  const active = createMemo(() => activeOf(props.defs))
  const defById = createMemo(() => {
    const m = new Map<string, BoardPanelDef>()
    for (const d of active()) m.set(d.id, d)
    return m
  })

  onMount(() => {
    props.board.attach(canvas)
    props.board.sync(active().map((d) => d.id))
  })
  // Capability-gated panels appear/disappear after the hello frame.
  createEffect(() => {
    props.board.sync(active().map((d) => d.id))
  })
  // Unmount mid-drag (e.g. setup mode takes over) must not leak the
  // window pointer listeners.
  onCleanup(() => props.board.cancelDrag())

  // Stickies onboarding hint, once per switch (design behavior).
  createEffect(() => {
    if (props.board.mode() !== "stickies") return
    setHint(true)
    const tm = setTimeout(() => setHint(false), 4200)
    onCleanup(() => clearTimeout(tm))
  })

  return (
    <div class="board" data-mode={props.board.mode()} ref={canvas}>
      <For each={props.board.panels.filter((p) => !p.closed)}>
        {(p) => {
          const def = () => defById().get(p.id)
          return (
            <Show when={def()}>
              <div
                class="panel"
                classList={{
                  entering: p.entering,
                  snapped: props.board.snappedId() === p.id,
                  pinned: props.board.pinnedIds().has(p.id),
                  minimized: p.min,
                  dragging: props.board.dragId() === p.id,
                }}
                style={{
                  left: `${p.x}px`,
                  top: `${p.y}px`,
                  width: `${p.w}px`,
                  height: `${p.min ? HEAD_H : p.h}px`,
                  "z-index": p.z,
                  "--panel-tint": `var(--wash-${def()!.tint})`,
                  "--tilt": `${tiltFor(p.id)}deg`,
                }}
                onPointerDown={() => props.board.bringToFront(p.id)}
              >
                <div class="panel-wash" />
                <div
                  class="panel-head"
                  onPointerDown={(e) => {
                    // Drag from the head only — not from its buttons.
                    if ((e.target as HTMLElement).closest("button")) return
                    props.board.startDrag(e, p.id, "move")
                  }}
                >
                  <span class="wash-dot" aria-hidden="true" />
                  <span class="panel-title">{def()!.title}</span>
                  <Show when={!def()!.noStar}>
                    <button
                      class="panel-star"
                      classList={{ on: props.board.favs().includes(p.id) }}
                      title={props.board.favs().includes(p.id) ? "unstar" : "add to favorites"}
                      onClick={() => props.board.toggleFav(p.id)}
                    >
                      {props.board.favs().includes(p.id) ? "★" : "☆"}
                    </button>
                  </Show>
                  <button
                    class="panel-min"
                    title={p.min ? "expand" : "minimize"}
                    onClick={() => props.board.toggleMin(p.id)}
                  >
                    {p.min ? "+" : "–"}
                  </button>
                  <button class="panel-close" title="close" onClick={() => props.board.close(p.id)}>
                    ✕
                  </button>
                </div>
                <div class="panel-body">{def()!.render()}</div>
                <Show when={!p.min}>
                  <div
                    class="resize-handle"
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      props.board.startDrag(e, p.id, "resize")
                    }}
                  />
                </Show>
              </div>
            </Show>
          )
        }}
      </For>

      <For each={props.board.guides()}>
        {(g) =>
          g.type === "v" ? (
            <div class="guide-v" style={{ left: `${g.at}px` }} />
          ) : (
            <div class="guide-h" style={{ top: `${g.at}px` }} />
          )
        }
      </For>

      <For each={props.board.pinBadges()}>
        {(b) => (
          <button
            class="pin-badge"
            style={{ left: `${b.x}px`, top: `${b.y}px`, "z-index": b.z }}
            title="unpin"
            onClick={() => props.board.unpin(b.pin)}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
              <path d="M9 15l6-6" />
              <path d="M11 6l1.5-1.5a4 4 0 0 1 5.7 5.7L16.5 12" />
              <path d="M13 18l-1.5 1.5a4 4 0 0 1-5.7-5.7L7.5 12" />
            </svg>
          </button>
        )}
      </For>

      <Show when={hint()}>
        <div class="mode-hint">snap two panels edge to edge to pin them — pinned panels drag together ✦</div>
      </Show>
    </div>
  )
}

/** Closed-panel chips for the topbar: max 3 named chips, the rest behind +N. */
export const Shelf: Component<BoardProps> = (props) => {
  const [open, setOpen] = createSignal(false)
  const defById = createMemo(() => {
    const m = new Map<string, BoardPanelDef>()
    for (const d of activeOf(props.defs)) m.set(d.id, d)
    return m
  })
  const closed = createMemo(() =>
    props.board.panels.filter((p) => p.closed && defById().has(p.id)),
  )
  const chip = (id: string): JSX.Element => {
    const def = defById().get(id)!
    return (
      <button
        class="shelf-chip"
        onClick={() => {
          props.board.restore(id)
          setOpen(false)
        }}
        title={`reopen ${def.title}`}
      >
        <span class="wash-dot" style={{ "--panel-tint": `var(--wash-${def.tint})` }} />
        <span>{def.title}</span>
      </button>
    )
  }
  return (
    <Show when={closed().length > 0}>
      <div class="shelf">
        <For each={closed().slice(0, 3)}>{(p) => chip(p.id)}</For>
        <Show when={closed().length > 3}>
          <button class="shelf-chip" onClick={() => setOpen((o) => !o)} title="more closed panels">
            +{closed().length - 3}
          </button>
          <Show when={open()}>
            <div class="shelf-pop">
              <For each={closed().slice(3)}>{(p) => chip(p.id)}</For>
            </div>
          </Show>
        </Show>
      </div>
    </Show>
  )
}

/** Body of the favorites panel: starred panels as summon cards. */
export const FavoritesGrid: Component<BoardProps> = (props) => {
  const items = createMemo(() =>
    props.board
      .favs()
      .map((id) => activeOf(props.defs).find((d) => d.id === id))
      .filter((d): d is BoardPanelDef => d !== undefined),
  )
  return (
    <Show
      when={items().length > 0}
      fallback={
        <div class="fav-note">nothing starred yet — tap the ☆ in any panel's corner to keep it here.</div>
      }
    >
      <>
        <div class="fav-grid">
          <For each={items()}>
            {(d) => (
              <div class="fav-card" role="button" tabIndex={0} onClick={() => props.board.summon(d.id)}>
                <span class="wash-dot" style={{ "--panel-tint": `var(--wash-${d.tint})` }} />
                <span class="name">{d.title}</span>
                <span class="hint">tap to summon ✦</span>
              </div>
            )}
          </For>
        </div>
        <div class="fav-note">star ☆ any panel to pin it here — luna keeps them ready.</div>
      </>
    </Show>
  )
}
