/**
 * ConnectionSummary (Solid) — colored dot + status label for the topbar.
 *
 * Solid port of apps/ui-web/src/App.tsx ConnectionSummary (~line 422).
 * Renders a status dot (ok/pending/bad/idle) plus a short label
 * derived from the current ConnectionStatus.kind.
 *
 * Reactivity: every label/class read goes through props.x or a
 * createMemo so Solid's tracker re-runs on status changes without
 * re-rendering the whole topbar.
 */
import { type Component, createMemo } from "solid-js"
import type { ConnectionStatus } from "@luna/ui-shared/core"

export interface ConnectionSummaryProps {
  readonly status: ConnectionStatus
  readonly url: string
  readonly model: string
  readonly chatCap: boolean
}

export const ConnectionSummary: Component<ConnectionSummaryProps> = (props) => {
  const host = createMemo(() => {
    try {
      return new URL(props.url).host || props.url
    } catch {
      return props.url
    }
  })

  const dotClass = createMemo(() => {
    const k = props.status.kind
    if (k === "open") return "dot ok"
    if (k === "connecting") return "dot pending"
    if (k === "error" || k === "closed") return "dot bad"
    return "dot idle"
  })

  const label = createMemo(() => {
    const s = props.status
    if (s.kind === "open") {
      return `${props.model} · ${host()}${props.chatCap ? "" : " · chat unavailable"}`
    }
    if (s.kind === "connecting") return `connecting · ${host()}`
    if (s.kind === "error") return `error · ${s.message}`
    if (s.kind === "closed") return "disconnected"
    return "not connected"
  })

  return (
    <span class="conn-summary" title={props.url}>
      <span class={dotClass()} />
      <span class="muted">{label()}</span>
    </span>
  )
}
