/**
 * FlowPanel.tsx - React 19 + Astryx port of panels/flow.js (per-job run
 * inspector, PRD Part C W3).
 *
 * Behavioral contract ported 1:1 from the vanilla module (see the deleted
 * frontend/panels/flow.js and its covering test, test/panel-flow.test.ts):
 *   - No jobId (prop is null) → "No job selected." notice, no WS connect.
 *   - Connects via `ctx.connectWs` (the exact same invoke/connect plumbing
 *     every still-vanilla panels/*.js module uses, and every other
 *     converted panel - see src/panels/panel-ctx.ts / flow-mount.tsx) and
 *     requests this job's run history once `hello` arrives.
 *   - hello without capabilities.workflows → replaces the panel with a
 *     "doesn't expose workflows" notice.
 *   - workflow-runs frames for a DIFFERENT jobId are ignored (server sends
 *     one job's history per request; a stale/concurrent panel's response
 *     must not bleed into ours).
 *   - workflow-list broadcasts update the subtitle (job label + schedule/
 *     on-demand/paused chip) whenever our jobId is present in the list.
 *   - Refresh re-sends the runs request.
 *
 * State model: unlike the vanilla module's hand-rolled `runs`/`jobMeta`
 * variables + imperative re-render, this dispatches every inbound frame
 * into the shared reducer ui-web already relies on (@luna/ui-shared/core -
 * see UIState.workflows / workflowRuns, already modeled for exactly this
 * PRD slice) and reads it back out via useMoonSelector
 * (useSyncExternalStore underneath - src/state/store.ts). The WS registry
 * callbacks below only ever call `store.dispatch(frame)` or send a request -
 * never touch the DOM directly - React re-renders from the store
 * subscription. Bounds/formatting/status-classification stay in
 * flow-model.ts as plain functions (mirrors the sibling Workflows gallery
 * panel's model.ts split), applied over the raw store slice at render time.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { createMoonStore, useMoonSelector } from "../state/store"
import { Badge, Button, HStack } from "../astryx-kit"
import type { LunaFrameRegistry, PanelCtx } from "./panel-ctx"
import { boundRuns, fmtDur, fmtRelative, statusClass, statusLabel, subtitleFor } from "./flow-model"
import "./FlowPanel.css"

declare global {
  interface Window {
    LunaWS?: { createFrameRegistry: () => LunaFrameRegistry }
  }
}

export interface FlowPanelProps {
  ctx: PanelCtx
  /** From the panel window's `?jobId=` URL param. null → "No job selected." */
  jobId: string | null
}

/** Astryx Badge variant for a subtitle chip kind - a purely cosmetic mapping
 *  layered on top of the class names the tests actually assert on. */
function chipVariant(kind: "scheduled" | "paused" | "on-demand"): "info" | "error" | "neutral" {
  if (kind === "paused") return "error"
  if (kind === "scheduled") return "info"
  return "neutral"
}

export function FlowPanel({ ctx, jobId }: FlowPanelProps) {
  // One store per mounted panel instance (each Moon panel window is its own
  // document/JS realm - see boot.tsx's identical per-mount rationale).
  const storeRef = useRef<ReturnType<typeof createMoonStore> | null>(null)
  if (storeRef.current === null) storeRef.current = createMoonStore()
  const store = storeRef.current

  const rawRuns = useMoonSelector(store, (s) => (jobId ? s.workflowRuns.get(jobId) : undefined))
  const workflows = useMoonSelector(store, (s) => s.workflows)
  const jobMeta = useMemo(() => (jobId ? (workflows.find((w) => w.id === jobId) ?? null) : null), [workflows, jobId])
  // Bounded/sorted unconditionally (before the early notice returns below) so
  // hook call order never varies between renders - React's Rules of Hooks.
  const sortedRuns = useMemo(() => boundRuns(rawRuns), [rawRuns])

  const [gateNotice, setGateNotice] = useState<string | null>(null)
  const clientRef = useRef<ReturnType<NonNullable<PanelCtx["connectWs"]>> | null>(null)

  useEffect(() => {
    setGateNotice(null)
    clientRef.current = null
    if (!jobId || !ctx.connectWs || typeof window === "undefined" || !window.LunaWS) return

    const registry = window.LunaWS.createFrameRegistry()

    registry.register("hello", (frame: any) => {
      store.dispatch(frame)
      const caps = frame && frame.capabilities ? frame.capabilities : {}
      if (!caps.workflows) {
        setGateNotice("This server doesn't expose workflows.")
        return
      }
      clientRef.current?.send({ type: "workflow-runs-request", jobId })
    })

    registry.register("workflow-runs", (frame: any) => {
      // Guard: only accept runs for our job - a stale/concurrent panel's
      // response for a different job must never reach this instance's slice.
      if (!frame || frame.jobId !== jobId) return
      store.dispatch(frame)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ctx/store are stable per-mount
  }, [jobId])

  function handleRefresh() {
    if (!jobId) return
    clientRef.current?.send({ type: "workflow-runs-request", jobId })
  }

  if (!jobId) {
    return <div className="notice">No job selected.</div>
  }

  if (gateNotice) {
    return <div className="notice">{gateNotice}</div>
  }

  const subtitle = subtitleFor(jobId, jobMeta)

  return (
    <div className="flow-panel">
      <HStack className="flow-header panel-row" gap={2} vAlign="center">
        <span className="flow-job-id" id="flow-job-id">
          {jobId}
        </span>
        <Button
          id="flow-refresh-btn"
          className="panel-btn"
          variant="secondary"
          size="sm"
          label="Refresh"
          onClick={handleRefresh}
        />
      </HStack>

      <div className="flow-subtitle" id="flow-subtitle" hidden={!subtitle}>
        {subtitle && (
          <>
            <span>{subtitle.label}</span>
            <Badge
              variant={chipVariant(subtitle.badge.kind)}
              label={subtitle.badge.text}
              className={"flow-badge " + subtitle.badge.kind}
            />
          </>
        )}
      </div>

      <div className="flow-runs" id="flow-runs-list">
        {sortedRuns.length === 0 ? (
          <div className="flow-empty">No runs yet.</div>
        ) : (
          sortedRuns.map((run) => {
            const cls = statusClass(run.status)
            const lbl = statusLabel(run.status)
            const dur = fmtDur(run.startedAt, run.finishedAt)
            return (
              <div className="flow-run-row" data-run-id={String(run.id)} key={run.id}>
                <div className="flow-run-top">
                  <span className={"flow-run-dot " + cls} aria-hidden="true" />
                  <span className={"flow-run-status " + cls}>{lbl}</span>
                  <div className="flow-run-meta">
                    <span className="flow-run-time">{fmtRelative(run.startedAt)}</span>
                    {dur && (
                      <>
                        <span>·</span>
                        <span className="flow-run-dur">{dur}</span>
                      </>
                    )}
                    {run.attempt > 1 && (
                      <>
                        <span>·</span>
                        <span className="flow-run-attempt">attempt {run.attempt}</span>
                      </>
                    )}
                  </div>
                </div>
                {run.error && <div className="flow-run-err">{String(run.error).slice(0, 120)}</div>}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
