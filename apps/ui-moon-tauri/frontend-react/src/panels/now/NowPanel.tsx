/**
 * NowPanel.tsx - React 19 + Astryx port of panels/now.js (the live "Now"
 * rail: running work + needs-input answer surface).
 *
 * Behavioral contract ported 1:1 from the vanilla module (see the deleted
 * frontend/panels/now.js and its covering test, test/panel-now.test.tsx):
 *   - Connects via ctx.connectWs (the exact same invoke/connect plumbing
 *     every still-vanilla panels/*.js module uses - see ../panel-ctx.ts)
 *     and gates on parseHelloCapabilities(frame).workflows.
 *   - hello without capabilities.workflows → replaces the whole panel with
 *     a "doesn't expose workflows" notice.
 *   - workflow-list renders a compact rail of rows sorted
 *     waiting → running → rest (by recency).
 *   - job-input-request pins an answer card to the top (newest-on-top);
 *     card state survives a workflow-list re-render.
 *   - Answer sends job-input-result {requestId, answer}; empty input is
 *     blocked with an inline hint. Dismiss sends
 *     job-input-result {requestId, cancelled:true} and removes the card
 *     immediately (no round trip).
 *   - job-input-status settles the card ("answered ✓" / server message),
 *     removed ~2s later. An unanswered request past its own timeoutMs
 *     shows "expired", removed the same ~2s later.
 *
 * State model: unlike the vanilla module's hand-rolled `workflows`/
 * `pendingCards` variables + imperative DOM mutation, this dispatches every
 * inbound frame into the SAME shared reducer ui-web already relies on
 * (@luna/ui-shared/core - see UIState.workflows / pendingInputRequests,
 * modeled for exactly this PRD slice) and reads it back out via
 * useMoonSelector (useSyncExternalStore underneath) - mirrors FlowPanel.tsx's
 * conversion. The WS registry callbacks below only ever call
 * `store.dispatch(frame)`; timers dispatch local (ChatLocalAction) state
 * transitions - never touch the DOM directly. React re-renders from the
 * store subscription, per the conversion's state-ownership rule.
 */
import { useEffect, useRef, useState } from "react"
import { createMoonStore, useMoonSelector } from "../../state/store"
import { Badge, Button, TextInput } from "../../astryx-kit"
import type { LunaFrameRegistry, LunaWsClient, PanelCtx } from "../panel-ctx"
import type { PendingInputRequest, WorkflowGalleryItem } from "@luna/ui-shared/core"
import "./NowPanel.css"

export const NOW_PANEL_TITLE = "Now"

declare global {
  interface Window {
    __panelCtx?: PanelCtx
    LunaWS?: {
      createFrameRegistry: () => LunaFrameRegistry
    }
    __NowPanelInternals?: {
      dispatch: ReturnType<typeof createMoonStore>["dispatch"]
      getState: ReturnType<typeof createMoonStore>["getState"]
    }
  }
}

export interface NowPanelProps {
  /** Defaults to window.__panelCtx (panel.html's hand-off - see ../panel-ctx.ts)
   *  so production mounts need not thread it explicitly; tests inject a mock. */
  ctx?: PanelCtx
}

// ── Helpers (ported verbatim from panels/now.js) ────────────────────────────

type Status = "success" | "running" | "waiting" | "failed" | "queued" | "cancelled"

function normalizeStatus(raw: unknown): Status {
  const s = String(raw || "").toLowerCase()
  if (s === "success" || s === "ok" || s === "completed") return "success"
  if (s === "running" || s === "started") return "running"
  if (s === "waiting") return "waiting"
  if (s === "failed" || s === "error") return "failed"
  if (s === "queued") return "queued"
  if (s === "cancelled" || s === "canceled") return "cancelled"
  return "queued"
}

function statusLabel(norm: Status): string {
  if (norm === "success") return "ok"
  if (norm === "failed") return "failed"
  if (norm === "running") return "running"
  if (norm === "waiting") return "needs input"
  if (norm === "queued") return "queued"
  return "cancelled"
}

/** Astryx Badge variant for a status dot/label - cosmetic only, the tests
 *  assert on the (kept-verbatim) `now-status-dot`/`now-wf-status-label`
 *  class names, not this mapping. */
function statusBadgeVariant(norm: Status): "success" | "error" | "info" | "warning" | "neutral" {
  if (norm === "success") return "success"
  if (norm === "failed") return "error"
  if (norm === "running") return "info"
  if (norm === "waiting") return "warning"
  return "neutral"
}

/** waiting first, then running, then the rest by recency (lastRun desc, then createdAt desc). */
function sortWorkflows(list: ReadonlyArray<WorkflowGalleryItem>): WorkflowGalleryItem[] {
  const rank: Record<string, number> = { waiting: 0, running: 1 }
  return list.slice().sort((a, b) => {
    const ar = rank[normalizeStatus(a.lastStatus)] ?? 2
    const br = rank[normalizeStatus(b.lastStatus)] ?? 2
    if (ar !== br) return ar - br
    const aT = a.lastRun || a.createdAt || 0
    const bT = b.lastRun || b.createdAt || 0
    return bT - aT
  })
}

// ── Workflow rail row ────────────────────────────────────────────────────

function WorkflowRow({ wf }: { wf: WorkflowGalleryItem }) {
  const norm = normalizeStatus(wf.lastStatus)
  return (
    <div className="now-wf-row">
      <span className={"now-status-dot " + norm} aria-hidden="true" />
      <span className="now-wf-name">{wf.label || wf.id}</span>
      <Badge
        variant={wf.schedule ? "info" : "neutral"}
        label={wf.schedule || "on-demand"}
        className={"now-wf-badge " + (wf.schedule ? "scheduled" : "on-demand")}
      />
      <Badge
        variant={statusBadgeVariant(norm)}
        label={statusLabel(norm)}
        className={"now-wf-status-label " + norm}
      />
    </div>
  )
}

// ── Answer card ──────────────────────────────────────────────────────────

interface AnswerCardProps {
  req: PendingInputRequest
  onAnswer: (requestId: string, answer: string) => void
  onDismiss: (requestId: string) => void
  onExpire: (requestId: string) => void
  onRemove: (requestId: string) => void
}

function AnswerCard({ req, onAnswer, onDismiss, onExpire, onRemove }: AnswerCardProps) {
  const [value, setValue] = useState("")
  const [hint, setHint] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Client-side timeout: fires once while the request is still pending.
  useEffect(() => {
    if (req.status !== "pending") return
    if (!req.timeoutMs || req.timeoutMs <= 0) return
    const handle = setTimeout(() => onExpire(req.requestId), req.timeoutMs)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestId/timeoutMs are stable per card
  }, [req.status])

  // Post-settle/expiry cleanup: remove the card ~2s after it stops being pending.
  useEffect(() => {
    if (req.status === "pending") return
    const handle = setTimeout(() => onRemove(req.requestId), 2000)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestId is stable per card
  }, [req.status])

  if (req.status !== "pending") {
    return (
      <div className="now-answer-card" data-request-id={req.requestId}>
        {req.status === "expired" ? (
          <div className="now-card-timeout">expired</div>
        ) : (
          <div className={"now-card-settled" + (req.status === "rejected" ? " warn" : "")}>
            {req.status === "answered" ? "answered ✓" : req.message || "already answered"}
          </div>
        )}
      </div>
    )
  }

  function handleAnswer() {
    const val = value.trim()
    if (!val) {
      setHint("Please type an answer before submitting.")
      return
    }
    setHint(null)
    setSubmitting(true)
    onAnswer(req.requestId, val)
    // Wipe the input value (clear after send - per spec).
    setValue("")
  }

  function handleDismiss() {
    onDismiss(req.requestId)
  }

  return (
    <div className="now-answer-card" data-request-id={req.requestId}>
      <div className="now-answer-card-job">{req.jobName}</div>
      <div className="now-answer-card-prompt">{req.prompt}</div>
      <div className="now-answer-card-input-row">
        <TextInput
          label="Your answer"
          isLabelHidden
          className="now-answer-input"
          placeholder="Your answer…"
          value={value}
          onChange={setValue}
          isDisabled={submitting}
        />
        <Button
          label="Answer"
          variant="primary"
          size="sm"
          className="now-answer-btn"
          isDisabled={submitting}
          onClick={handleAnswer}
        />
        <Button
          label="Dismiss"
          variant="secondary"
          size="sm"
          className="now-dismiss-btn"
          isDisabled={submitting}
          onClick={handleDismiss}
        />
      </div>
      {hint && <div className="now-card-hint error">{hint}</div>}
    </div>
  )
}

// ── Panel ────────────────────────────────────────────────────────────────

export function NowPanel({ ctx: ctxProp }: NowPanelProps) {
  // One store per mounted panel instance (each Moon panel window is its own
  // document/JS realm - see boot.tsx's identical per-mount rationale).
  const storeRef = useRef<ReturnType<typeof createMoonStore> | null>(null)
  if (storeRef.current === null) storeRef.current = createMoonStore()
  const store = storeRef.current

  const [gateNotice, setGateNotice] = useState<string | null>(null)
  const clientRef = useRef<LunaWsClient | null>(null)

  const workflows = useMoonSelector(store, (s) => s.workflows)
  const pendingInputRequests = useMoonSelector(store, (s) => s.pendingInputRequests)

  // Debug/observability hook, mirroring chat.html's window.__MoonInternals and
  // AgentsPanel.tsx's window.__AgentsPanelInternals - lets agent-browser (and
  // a human) drive this panel's state without a live WS connection
  // (screenshotting, smoke checks). Read-only intent: exposes dispatch/
  // getState, never a substitute for the real transport.
  useEffect(() => {
    window.__NowPanelInternals = { dispatch: store.dispatch, getState: store.getState }
    return () => {
      delete window.__NowPanelInternals
    }
  }, [store])

  useEffect(() => {
    const ctx = ctxProp ?? window.__panelCtx
    const lunaWs = window.LunaWS
    if (!ctx || !ctx.connectWs || !lunaWs) return

    const registry = lunaWs.createFrameRegistry()

    registry.register("hello", (frame: any) => {
      store.dispatch(frame)
      const caps = frame && frame.capabilities ? frame.capabilities : {}
      if (!caps.workflows) {
        setGateNotice("This server doesn't expose workflows.")
      }
    })

    registry.register("workflow-list", (frame: any) => {
      store.dispatch(frame)
      // Note: pending cards are NOT cleared on re-render (spec: card state
      // must survive a workflow-list re-render) - the reducer only ever
      // touches `workflows` for this frame type.
    })

    registry.register("job-input-request", (frame: any) => {
      store.dispatch(frame)
    })

    registry.register("job-input-status", (frame: any) => {
      store.dispatch(frame)
    })

    const client = ctx.connectWs(registry, { autoPong: true })
    clientRef.current = client

    return () => {
      client.close()
      clientRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store/ctxProp are stable per mount
  }, [])

  function handleAnswer(requestId: string, answer: string) {
    clientRef.current?.send({ type: "job-input-result", requestId, answer })
  }

  function handleDismiss(requestId: string) {
    clientRef.current?.send({ type: "job-input-result", requestId, cancelled: true })
    // Removed immediately - no round trip needed for a dismiss.
    store.dispatch({ tag: "remove-input-request", requestId })
  }

  function handleExpire(requestId: string) {
    store.dispatch({ tag: "expire-input-request", requestId })
  }

  function handleRemove(requestId: string) {
    store.dispatch({ tag: "remove-input-request", requestId })
  }

  if (gateNotice) {
    return <div className="notice">{gateNotice}</div>
  }

  const sorted = sortWorkflows(workflows)

  return (
    <div className="now-panel">
      {pendingInputRequests.length > 0 && (
        <div className="now-cards" id="now-cards">
          {pendingInputRequests.map((req) => (
            <AnswerCard
              key={req.requestId}
              req={req}
              onAnswer={handleAnswer}
              onDismiss={handleDismiss}
              onExpire={handleExpire}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}

      <div className="now-section-label">Running work</div>

      <div className="now-rail" id="now-rail">
        {sorted.length === 0 ? (
          <span className="now-empty">No workflows yet.</span>
        ) : (
          sorted.map((wf) => <WorkflowRow key={wf.id} wf={wf} />)
        )}
      </div>
    </div>
  )
}
