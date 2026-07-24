/**
 * WorkflowsPanel.tsx — React 19 + Astryx port of panels/workflows.js (the
 * Workflows gallery panel, PRD Part C W3): the full catalog view over the
 * server's workflow gallery, sorted needs-attention → running → most
 * recent. Clicking a row opens that job's run-history inspector (the
 * 'flow' panel — see FlowPanel.tsx — one window per jobId).
 *
 * Behavioral contract ported 1:1 from the deleted frontend/panels/workflows.js
 * (see model.ts for the pure sort/status/bounds helpers, ported verbatim):
 *   - hello without capabilities.workflows → notice, gallery chrome hidden.
 *     A later hello WITH the capability re-enables it (toggle, never
 *     destroy) and — only on that disabled→enabled transition — re-pulls
 *     the catalog, since any list dropped while gated is gone.
 *   - workflow-list is gated on the SAME capability at render time: a frame
 *     that arrives before the first hello, or while denied, is stored (the
 *     shared reducer is a thin untrusted mirror of the wire — see
 *     packages/ui-shared/src/reducer.ts) but never rendered.
 *   - Untrusted rows are bounded before render: malformed/oversized ids
 *     dropped, capped at 500 rows with a "+N more" footer, labels clamped
 *     (see model.ts's boundWorkflows/MAX_*).
 *   - The header count flips to "disconnected" on socket close (while
 *     enabled) and clears on the next open or workflow-list frame; Refresh
 *     surfaces a dead socket the same way instead of silently no-op'ing.
 *   - Window focus re-renders (relative times) and re-pulls the catalog.
 *   - Click / Enter / Space on a row opens the 'flow' panel via open_widget.
 *
 * State model: same as FlowPanel.tsx — every inbound frame is dispatched
 * into the shared @luna/ui-shared reducer (UIState.workflows /
 * capabilities.workflows, already modeled for this PRD slice) and read back
 * via useMoonSelector. Connection-liveness ("disconnected") has no reducer
 * slice (it is not server-authored data, just this socket's own open/close
 * state) so it stays local React state, set only from WS registry callbacks
 * and connectWs's onOpen/onClose — never from a DOM read/write. Mounted by
 * src/panels/workflows-mount.tsx.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import type { WorkflowGalleryItem } from "@luna/ui-shared/core"
import { createMoonStore, useMoonSelector } from "../../state/store"
import { Badge, Button } from "../../astryx-kit"
import type { LunaFrameRegistry, PanelCtx } from "../panel-ctx"
import {
  attentionRank,
  badgeFor,
  boundWorkflows,
  displayName,
  metaText,
  sortWorkflows,
  statusClass,
} from "./model"
import "./workflows-panel.css"

declare global {
  interface Window {
    __panelCtx?: PanelCtx
    LunaWS?: { createFrameRegistry: () => LunaFrameRegistry }
  }
}

type Capability = "unknown" | "enabled" | "disabled"

function openFlow(jobId: string): void {
  // One run-history window per job (the 'flow' panel is non-singleton).
  // Off-Tauri (browser dev / jsdom) invoke rejects — swallow, matches every
  // other converted panel's convention (SettingsLauncherPanel, FlowPanel).
  window.__panelCtx?.invoke("open_widget", { kind: "flow", params: { jobId } }).catch(() => {})
}

function WorkflowRow({ wf }: { wf: WorkflowGalleryItem }) {
  const cls = statusClass(wf.lastStatus)
  const attention = attentionRank(wf) === 0
  const name = displayName(wf)
  const badge = badgeFor(wf)

  function onOpen(): void {
    openFlow(wf.id)
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      onOpen()
    }
  }

  return (
    <div
      className={"wfs-row" + (attention ? " attention" : "")}
      role="button"
      tabIndex={0}
      data-job-id={wf.id}
      aria-label={"Open run history for " + name}
      onClick={onOpen}
      onKeyDown={onKeyDown}
    >
      <span className={"wfs-dot " + cls} aria-hidden="true" />
      <div className="wfs-info">
        <div className="wfs-name-row">
          <span className="wfs-name">{name}</span>
          <Badge label={badge.text} className={badge.className} />
        </div>
        <div className="wfs-meta">{metaText(wf)}</div>
      </div>
    </div>
  )
}

export function WorkflowsPanel() {
  // One store per mounted panel instance — each Moon panel window is its own
  // document/JS realm (see FlowPanel.tsx / boot.tsx's identical rationale).
  const storeRef = useRef<ReturnType<typeof createMoonStore> | null>(null)
  if (storeRef.current === null) storeRef.current = createMoonStore()
  const store = storeRef.current

  const capabilitiesWorkflows = useMoonSelector(store, (s) => s.capabilities.workflows)
  const rawWorkflows = useMoonSelector(store, (s) => s.workflows)

  // The shared reducer's `hello` case replaces `capabilities` wholesale with
  // whatever the server sent — an explicit `{}` (no `workflows` key) is
  // indistinguishable, on the STATE alone, from no hello ever having
  // arrived (both leave capabilities.workflows `undefined`). The vanilla
  // module resolved this via `LunaProtocol.parseHelloCapabilities`, which
  // coerces the field with `!!` at the wire-parsing layer BEFORE it reaches
  // panel state; the shared reducer intentionally does no such coercion (it
  // stays a thin, untrusted mirror of the wire for every slice). So this
  // panel tracks "has any hello arrived" itself, locally.
  const [helloReceived, setHelloReceived] = useState(false)
  const capability: Capability = !helloReceived ? "unknown" : capabilitiesWorkflows ? "enabled" : "disabled"

  const [stale, setStale] = useState(false)
  const clientRef = useRef<ReturnType<NonNullable<PanelCtx["connectWs"]>> | null>(null)
  // Tracks whether the LAST hello denied the capability, so a grant only
  // re-pulls the catalog on an actual disabled→enabled transition (a list
  // dropped while gated is gone) — never on the routine first hello, whose
  // connect-time workflow-list is already on its way.
  const wasDisabledRef = useRef(false)

  function requestRefresh(): boolean {
    const ok = !!clientRef.current?.send({ type: "workflow-refresh" })
    setStale(!ok)
    return ok
  }

  useEffect(() => {
    const ctx = window.__panelCtx
    const lunaWs = window.LunaWS
    if (!ctx || !ctx.connectWs || !lunaWs) return

    const registry = lunaWs.createFrameRegistry()

    registry.register("hello", (frame: any) => {
      store.dispatch(frame)
      setHelloReceived(true)
      const caps = frame && frame.capabilities ? frame.capabilities : {}
      if (caps.workflows) {
        setStale(false)
        if (wasDisabledRef.current) clientRef.current?.send({ type: "workflow-refresh" })
        wasDisabledRef.current = false
      } else {
        wasDisabledRef.current = true
      }
    })

    registry.register("workflow-list", (frame: any) => {
      // The hello gate is a real gate on data, not just on chrome — but that
      // gate is enforced at RENDER time (see `displayed` below), not here:
      // the reducer is a thin untrusted mirror of the wire regardless of
      // capability, same as every other slice (packages/ui-shared/src/reducer.ts).
      store.dispatch(frame)
      setStale(false)
    })

    const client = ctx.connectWs(registry, {
      autoPong: true,
      onOpen: () => {
        if (store.getState().capabilities.workflows) setStale(false)
      },
      onClose: () => {
        if (store.getState().capabilities.workflows) setStale(true)
      },
    })
    clientRef.current = client

    // Pull model: relative times and the attention sort only move when a
    // frame arrives. Re-pull on focus so a gallery left open all day doesn't
    // show "next in 5m" an hour late.
    function onFocus(): void {
      if (!store.getState().capabilities.workflows) return
      requestRefresh()
    }
    window.addEventListener("focus", onFocus)

    return () => {
      window.removeEventListener("focus", onFocus)
      client.close()
      clientRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store/refs are stable per-mount
  }, [])

  const { list: bounded, truncated } = useMemo(
    () => (capability === "enabled" ? boundWorkflows(rawWorkflows) : { list: [], truncated: 0 }),
    [capability, rawWorkflows],
  )
  const sorted = useMemo(() => sortWorkflows(bounded), [bounded])
  const countText = stale ? "disconnected" : bounded.length ? String(bounded.length) : ""

  return (
    <>
      <div className="notice" id="wfs-notice" hidden={capability !== "disabled"}>
        This server doesn't expose workflows.
      </div>
      <div className="wfs-header panel-row" hidden={capability === "disabled"}>
        <span className={"wfs-count" + (stale ? " stale" : "")} id="wfs-count">
          {countText}
        </span>
        <Button
          id="wfs-refresh-btn"
          className="panel-btn"
          label="Refresh"
          onClick={() => requestRefresh()}
        />
      </div>
      <div className="wfs-list" id="wfs-list" hidden={capability === "disabled"}>
        {sorted.length === 0 ? (
          <div className="wfs-empty">No workflows yet.</div>
        ) : (
          <>
            {sorted.map((wf) => (
              <WorkflowRow key={wf.id} wf={wf} />
            ))}
            {truncated > 0 && <div className="wfs-more">+{truncated} more not shown</div>}
          </>
        )}
      </div>
    </>
  )
}
