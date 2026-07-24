/**
 * BriefingPanel.tsx - React 19 + Astryx port of panels/briefing.js ("While
 * you were away" workflow digest, PRD Part C W3).
 *
 * Behavioral contract ported 1:1 from the vanilla module (see the deleted
 * frontend/panels/briefing.js and its covering test, now
 * test/panel-briefing.test.tsx):
 *   - Connects via ctx.connectWs (the exact same invoke/connect plumbing
 *     every still-vanilla panels/*.js module uses - see
 *     src/panels/panel-ctx.ts).
 *   - hello without capabilities.workflows → replaces the panel with a
 *     "doesn't expose workflows" notice; hello with the capability clears it.
 *   - workflow-list frames group into three sections: Needs attention
 *     (waiting/failed), Ran recently (success/cancelled, most-recent first),
 *     Scheduled next (has a schedule, soonest nextRunAt first) - see
 *     ./model.ts for the pure grouping/formatting logic.
 *   - Each attention row has an Open button → ctx.invoke('open_widget',
 *     { kind: 'flow', params: { jobId } }).
 *   - Refresh button sends { type: 'workflow-refresh' } over the WS.
 *
 * State model: mirrors FlowPanel.tsx (see its doc for the full rationale) -
 * every inbound frame dispatches into the shared reducer
 * (@luna/ui-shared/core - UIState.workflows/capabilities are already modeled
 * for this PRD slice) and is read back out via useMoonSelector
 * (useSyncExternalStore underneath). The WS registry callbacks below only
 * ever call `store.dispatch(frame)` or a local setState for the ephemeral
 * "have we heard from the server yet" gate - never touch the DOM directly;
 * React re-renders from the store subscription.
 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import { createMoonStore, useMoonSelector } from "../../state/store"
import { Button } from "../../astryx-kit"
import type { LunaFrameRegistry, PanelCtx } from "../panel-ctx"
import type { WorkflowGalleryItem } from "@luna/ui-shared/core"
import { attentionMeta, groupWorkflows, relativeTime, scheduleLabel, statusDotClass } from "./model"
import "./BriefingPanel.css"

declare global {
  interface Window {
    LunaWS?: {
      createFrameRegistry: () => LunaFrameRegistry
    }
  }
}

export interface BriefingPanelProps {
  ctx: PanelCtx
}

export const BRIEFING_PANEL_TITLE = "Briefing"

function openFlow(ctx: PanelCtx, jobId: string): void {
  ctx.invoke("open_widget", { kind: "flow", params: { jobId } }).catch(() => {})
}

function StatusDot({ status }: { status: string | null }) {
  const cls = statusDotClass(status)
  if (!cls) return null
  return <span className={`bf-status-dot ${cls}`} aria-hidden="true" />
}

function Row({
  wf,
  attention,
  meta,
  ctx,
}: {
  wf: WorkflowGalleryItem
  attention?: boolean
  meta: string | null
  ctx: PanelCtx
}) {
  return (
    <div className={"bf-row" + (attention ? " attention" : "")} data-job-id={wf.id}>
      <StatusDot status={wf.lastStatus} />
      <div className="bf-row-info">
        <div className="bf-row-name">{wf.label || wf.id}</div>
        {meta && <div className="bf-row-meta">{meta}</div>}
      </div>
      {attention && (
        <Button
          className="bf-open-btn"
          variant="primary"
          size="sm"
          label={`Open ${wf.label || wf.id}`}
          onClick={() => openFlow(ctx, wf.id)}
        >
          Open
        </Button>
      )}
    </div>
  )
}

function Section({
  label,
  rows,
}: {
  label: string
  rows: ReadonlyArray<ReactNode>
}) {
  return (
    <div className="bf-section">
      <div className="bf-section-label">{label}</div>
      {rows.length === 0 ? <div className="bf-empty">None</div> : rows}
    </div>
  )
}

export function BriefingPanel({ ctx }: BriefingPanelProps) {
  // One store per mounted panel instance - each Moon panel window is its own
  // document/JS realm (see boot.tsx's identical per-mount rationale).
  const storeRef = useRef<ReturnType<typeof createMoonStore> | null>(null)
  if (storeRef.current === null) storeRef.current = createMoonStore()
  const store = storeRef.current

  const workflows = useMoonSelector(store, (s) => s.workflows as ReadonlyArray<WorkflowGalleryItem>)
  // Ephemeral UI-only gate: "have we heard a hello, and did it grant the
  // workflows capability" - not modeled in the shared reducer (no
  // hello-received flag exists there), so it stays local component state,
  // set only from the WS registry's hello handler alongside the dispatch.
  const [gateNotice, setGateNotice] = useState<string | null>(null)
  const clientRef = useRef<ReturnType<NonNullable<PanelCtx["connectWs"]>> | null>(null)

  useEffect(() => {
    const lunaWs = window.LunaWS
    if (!ctx.connectWs || !lunaWs) return

    const registry = lunaWs.createFrameRegistry()

    registry.register("hello", (frame: any) => {
      store.dispatch(frame)
      const caps = frame && frame.capabilities ? frame.capabilities : {}
      setGateNotice(caps.workflows ? null : "This server doesn't expose workflows.")
    })

    registry.register("workflow-list", (frame: any) => {
      store.dispatch(frame)
    })

    const client = ctx.connectWs(registry, { autoPong: true })
    clientRef.current = client

    return () => {
      client.close()
      clientRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store/ctx stable per mount
  }, [ctx])

  function handleRefresh() {
    clientRef.current?.send({ type: "workflow-refresh" })
  }

  if (gateNotice) {
    return <div className="notice">{gateNotice}</div>
  }

  const { attention, recent, scheduled } = groupWorkflows(workflows)

  return (
    <div className="briefing-panel">
      <div className="bf-refresh-row">
        <Button className="panel-btn" variant="secondary" size="sm" label="Refresh" onClick={handleRefresh} />
      </div>
      <div id="bf-body">
        <Section
          label="Needs attention"
          rows={attention.map((wf) => (
            <Row key={wf.id} wf={wf} attention meta={attentionMeta(wf)} ctx={ctx} />
          ))}
        />
        <Section
          label="Ran recently"
          rows={recent.map((wf) => (
            <Row key={wf.id} wf={wf} meta={relativeTime(wf.lastRun)} ctx={ctx} />
          ))}
        />
        <Section
          label="Scheduled next"
          rows={scheduled.map((wf) => (
            <Row key={wf.id} wf={wf} meta={scheduleLabel(wf)} ctx={ctx} />
          ))}
        />
      </div>
    </div>
  )
}
