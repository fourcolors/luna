/**
 * EventRow (Solid) — single ObsEvent row in the event log.
 *
 * Solid port of apps/ui-web/src/App.tsx EventRow (~line 1033). Click
 * toggles a JSON-formatted detail view. Summary line previews up to
 * three non-meta keys via formatVal.
 */
import { type Component, Show, createMemo, createSignal } from "solid-js"
import { formatVal, type ObsEvent } from "@luna/ui-shared/core"

export const EventRow: Component<{ event: ObsEvent }> = (props) => {
  const [open, setOpen] = createSignal(false)

  const summary = createMemo(() => {
    const { ts, kind, level, ...rest } = props.event as ObsEvent &
      Record<string, unknown>
    void ts
    void level
    void kind
    const keys = Object.keys(rest).slice(0, 3)
    const preview = keys
      .map((k) => `${k}=${formatVal(rest[k])}`)
      .join(" ")
    return preview || props.event.kind
  })

  return (
    <div
      class={`row event level-${props.event.level}`}
      onClick={() => setOpen((o) => !o)}
    >
      <span class="ts">{props.event.ts.slice(11, 23)}</span>
      <span class={`kind kind-${props.event.kind}`}>{props.event.kind}</span>
      <span class="summary">{summary()}</span>
      <Show when={open()}>
        <pre class="json">{JSON.stringify(props.event, null, 2)}</pre>
      </Show>
    </div>
  )
}
