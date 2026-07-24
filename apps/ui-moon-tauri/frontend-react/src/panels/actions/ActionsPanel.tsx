/**
 * ActionsPanel.tsx - React 19 + Astryx port of frontend/panels/actions.js
 * (the Suggested Actions panel).
 *
 * Behavioral contract ported 1:1 from the vanilla module (see the deleted
 * vanilla suite's assertions, now reproduced in this port's own
 * test/panel-actions.test.tsx):
 *   - No `thread` param (empty threadId prop) -> "No conversation selected."
 *     notice, no WS connect.
 *   - Connects via window.__panelCtx.connectWs (the exact same
 *     invoke/connect plumbing every still-vanilla panels/*.js module uses -
 *     see src/panels/panel-ctx.ts), gated on capabilities.suggestedActions
 *     (raw-fallback pattern: `!!(frame.capabilities && frame.capabilities.
 *     suggestedActions)` - do NOT rely on a parsed-capabilities helper
 *     knowing this newer flag).
 *   - hello without the capability -> replaces the panel with a "doesn't
 *     support suggested actions" notice.
 *   - suggested-action-set (full replace) and suggested-action-update
 *     (single delta) are handled per SuggestedActionWire.
 *   - Accept/Dismiss send suggested-action-respond and optimistically flip
 *     the row's status before the server confirms.
 *
 * State model: unlike the vanilla module's hand-rolled `actions` array +
 * imperative re-render, every inbound frame is dispatched into the SAME
 * shared reducer ui-web already relies on (@luna/ui-shared/core -
 * UIState.suggestedActions is a per-threadId map, already modeled for
 * exactly this PRD slice) and read back out via useMoonSelector
 * (useSyncExternalStore underneath). Because the reducer partitions
 * suggestedActions by threadId itself, a frame for a DIFFERENT thread simply
 * updates that other thread's slice of the map - this panel's own
 * `suggestedActions.get(threadId)` selection is naturally unaffected, so
 * there is no manual "ignore frames for other threads" filtering to get
 * wrong (the vanilla module had to hand-roll that guard; the shared reducer
 * makes it structural). The WS registry callbacks below only ever call
 * `store.dispatch(frame)` or send a request/response - never touch the DOM
 * directly - React re-renders from the store subscription, per the
 * conversion's state-ownership rule.
 *
 * Optimistic accept/dismiss note: the reducer's suggested-action-update case
 * fully REPLACES the row by id (`frame.action`), it does not merge - so the
 * optimistic dispatch below builds a full SuggestedActionWire (current row
 * merged with the status delta) rather than sending a bare {id, status}
 * partial, which would otherwise blank out title/rationale/etc.
 */
import { useEffect, useRef, useState } from "react"
import { createMoonStore, useMoonSelector } from "../../state/store"
import { Badge, type BadgeVariant, Button, Card } from "../../astryx-kit"
import type { LunaFrameRegistry, PanelCtx } from "../panel-ctx"
import type { SuggestedActionStatus, SuggestedActionWire } from "@luna/ui-shared/core"
import "./actions-panel.css"

declare global {
  interface Window {
    __panelCtx?: PanelCtx
    LunaWS?: {
      createFrameRegistry: () => LunaFrameRegistry
    }
  }
}

export interface ActionsPanelProps {
  ctx: PanelCtx
  /** From panel.html's `?thread=` URL param (read by actions-mount.tsx).
   *  Empty string -> "No conversation selected." */
  threadId: string
}

const TYPE_LABELS: Record<string, string> = {
  task: "Task",
  research: "Research",
  create_skill: "Create Skill",
  create_workflow: "Create Workflow",
  run_workflow: "Run Workflow",
}

function typeLabel(actionType: string | undefined): string {
  return (actionType && TYPE_LABELS[actionType]) || actionType || ""
}

/** Purely cosmetic Astryx Badge variant for a status - a layer on top of the
 *  `.action-status-badge.<status>` class the tests actually assert on (that
 *  class carries the watercolor color language verbatim, see
 *  actions-panel.css). */
function badgeVariant(status: string | undefined): BadgeVariant {
  switch (status) {
    case "proposed":
      return "info"
    case "accepted":
    case "completed":
      return "success"
    case "in_progress":
      return "warning"
    case "failed":
      return "error"
    default:
      return "neutral"
  }
}

type Decision = "accept" | "dismiss"

export function ActionsPanel({ ctx, threadId }: ActionsPanelProps) {
  // One store per mounted panel instance (each Moon panel window is its own
  // document/JS realm - see boot.tsx's identical per-mount rationale, and
  // FlowPanel.tsx's matching pattern).
  const storeRef = useRef<ReturnType<typeof createMoonStore> | null>(null)
  if (storeRef.current === null) storeRef.current = createMoonStore()
  const store = storeRef.current

  const [helloReceived, setHelloReceived] = useState(false)
  const clientRef = useRef<ReturnType<NonNullable<PanelCtx["connectWs"]>> | null>(null)

  const hasCapability = useMoonSelector(store, (s) => !!s.capabilities.suggestedActions)
  const actionsForThread = useMoonSelector(store, (s) => s.suggestedActions.get(threadId))

  useEffect(() => {
    setHelloReceived(false)
    clientRef.current = null
    if (!threadId) return
    if (!ctx.connectWs || typeof window === "undefined" || !window.LunaWS) return

    const registry: LunaFrameRegistry = window.LunaWS.createFrameRegistry()

    registry.register("hello", (frame: any) => {
      store.dispatch(frame)
      setHelloReceived(true)
    })

    registry.register("suggested-action-set", (frame: any) => {
      store.dispatch(frame)
    })

    registry.register("suggested-action-update", (frame: any) => {
      if (!frame || !frame.action) return
      store.dispatch(frame)
    })

    const client = ctx.connectWs(registry, { autoPong: true })
    clientRef.current = client

    return () => {
      client.close()
      clientRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store is a stable per-mount ref
  }, [threadId])

  function respond(action: SuggestedActionWire, decision: Decision): void {
    clientRef.current?.send({
      type: "suggested-action-respond",
      threadId,
      actionId: action.id,
      decision,
    })
    // Optimistic: flip this row's status immediately, before the server's
    // suggested-action-update confirms (see module doc on why this is a
    // full-object dispatch, not a partial delta).
    const optimisticStatus: SuggestedActionStatus = decision === "accept" ? "accepted" : "dismissed"
    store.dispatch({
      type: "suggested-action-update",
      threadId,
      action: { ...action, status: optimisticStatus },
    })
  }

  if (!threadId) {
    return <div className="notice">No conversation selected.</div>
  }

  if (helloReceived && !hasCapability) {
    return <div className="notice">This server doesn't support suggested actions.</div>
  }

  return (
    <div className="actions-list">
      {!helloReceived || actionsForThread === undefined ? (
        <span className="actions-notice">Connecting…</span>
      ) : actionsForThread.length === 0 ? (
        <span className="actions-notice">
          No suggested actions — Luna will propose here when it has recommendations.
        </span>
      ) : (
        actionsForThread.map((action) => (
          <ActionRow key={action.id} action={action} onRespond={respond} />
        ))
      )}
    </div>
  )
}

function ActionRow({
  action,
  onRespond,
}: {
  action: SuggestedActionWire
  onRespond: (action: SuggestedActionWire, decision: Decision) => void
}) {
  return (
    <Card className="action-row" variant="transparent" data-action-id={action.id}>
      <div className="action-row-header">
        <div className="action-blot" data-source={action.source || "agent"} />
        <div className="action-row-info">
          <span className="action-row-title">
            {action.title || ""}
            <Badge
              className={"action-status-badge " + (action.status || "")}
              variant={badgeVariant(action.status)}
              label={(action.status || "").replace(/_/g, " ")}
            />
          </span>
          <span className="action-type-label">{typeLabel(action.actionType)}</span>
          {action.rationale && <span className="action-row-rationale">{action.rationale}</span>}
        </div>
      </div>
      {action.status === "proposed" && (
        <div className="action-row-actions">
          <Button
            className="action-btn accept"
            variant="ghost"
            size="sm"
            label="Accept"
            onClick={() => onRespond(action, "accept")}
          />
          <Button
            className="action-btn dismiss"
            variant="ghost"
            size="sm"
            label="Dismiss"
            onClick={() => onRespond(action, "dismiss")}
          />
        </div>
      )}
    </Card>
  )
}
