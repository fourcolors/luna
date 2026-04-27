/**
 * ObsPanel (Solid) — observability pane: kind chips, drop banner,
 * meta line, and the streaming event log.
 *
 * Solid port of apps/ui-web/src/App.tsx ObsPanel (~line 965).
 *
 * Stays a "presentation" component — all filter state (selectedKinds,
 * etc.) lives in the owning App so the chip-set + transcript share
 * the same store. Same prop shape as React for behavior parity.
 */
import { type Component, For, Show } from "solid-js"
import type { ObsEvent } from "@luna/ui-shared/core"
import { EventRow } from "./EventRow.jsx"

export interface ObsPanelProps {
  readonly allKinds: ReadonlyArray<string>
  readonly selectedKinds: ReadonlySet<string>
  readonly toggleKind: (k: string) => void
  readonly clearKinds: () => void
  readonly filtered: ReadonlyArray<ObsEvent>
  readonly totalEvents: number
  readonly lastDrop: { readonly n: number; readonly since: string } | null
  readonly droppedTotal: number
  readonly lastPingAt: string | null
}

export const ObsPanel: Component<ObsPanelProps> = (props) => {
  return (
    <>
      <div class="topbar" style={{ "border-top": "1px solid #222" }}>
        <div class="row chips">
          <Show when={props.allKinds.length === 0}>
            <span class="muted">no kinds yet — connect to see events</span>
          </Show>
          <For each={props.allKinds}>
            {(k) => (
              <button
                class={`chip ${props.selectedKinds.has(k) ? "active" : ""}`}
                onClick={() => props.toggleKind(k)}
              >
                {k}
              </button>
            )}
          </For>
          <Show when={props.selectedKinds.size > 0}>
            <button class="chip clear" onClick={() => props.clearKinds()}>
              clear
            </button>
          </Show>
        </div>
        <Show when={props.lastDrop}>
          {(drop) => (
            <div class="banner drop">
              ⚠ dropped {props.droppedTotal} event(s) total · most recent
              burst: {drop().n} since {drop().since}
            </div>
          )}
        </Show>
      </div>
      <main class="log">
        <div class="meta">
          {props.filtered.length} / {props.totalEvents} event(s) shown
          <Show when={props.lastPingAt}>
            <span class="muted"> · last ping {props.lastPingAt}</span>
          </Show>
        </div>
        <For each={props.filtered}>
          {(ev) => <EventRow event={ev} />}
        </For>
      </main>
    </>
  )
}
