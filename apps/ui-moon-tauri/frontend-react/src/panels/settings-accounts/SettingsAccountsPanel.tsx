/**
 * SettingsAccountsPanel.tsx - Moon Settings for AccountBroker rows
 * (id / label / kind / health). Distinct from SettingsModelsPanel.
 *
 * Mutations: account-add / account-rm → SQLite + server restart (no broker
 * hot-reload). Composer Auto/pin (#545) is untouched.
 */
import { useEffect, useRef } from "react"
import type { Action } from "@luna/ui-shared/core"
import { Badge, type BadgeVariant, Button, TextInput } from "../../astryx-kit"
import { useLocalStore, useMoonSelector, useMoonStore } from "../../state/store"
import type { LunaFrameRegistry, LunaWsClient, PanelCtx } from "../panel-ctx"
import {
  FIXED_ACCOUNT_KIND,
  healthLabel,
  initialAccountsPanelState,
  newReqId,
  reduceAccountsPanel,
  type AccountsPanelAction,
  type AccountsPanelState,
} from "./accountsReducer"
import "./settings-accounts.css"

export const SETTINGS_ACCOUNTS_TITLE = "Accounts"

declare global {
  interface Window {
    LunaWS?: { createFrameRegistry: () => LunaFrameRegistry }
  }
}

interface AccountRow {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly health: string
}

function socketOpen(client: LunaWsClient | null): boolean {
  const sock = client?.socket() as { readyState?: number } | null | undefined
  const OPEN =
    typeof WebSocket !== "undefined" &&
    (WebSocket as unknown as { OPEN?: number }).OPEN !== undefined
      ? (WebSocket as unknown as { OPEN: number }).OPEN
      : 1
  return !!(sock && sock.readyState === OPEN)
}

function healthBadgeVariant(health: string): BadgeVariant {
  if (health === "healthy") return "success"
  if (health === "rate_limited") return "warning"
  if (health === "spent") return "error"
  return "neutral"
}

function helloHasAccountManage(frame: unknown): boolean {
  const f = frame as { capabilities?: { accountManage?: unknown } } | null | undefined
  return !!(f && f.capabilities && f.capabilities.accountManage)
}

export function SettingsAccountsPanel({ ctx }: { ctx: PanelCtx }) {
  const store = useMoonStore()
  const accounts = useMoonSelector(store, (s) => s.accounts) as ReadonlyArray<AccountRow>

  const local = useLocalStore<AccountsPanelState, AccountsPanelAction>(
    reduceAccountsPanel,
    initialAccountsPanelState(),
  )
  const state = useMoonSelector(local, (s) => s)
  const wsClientRef = useRef<LunaWsClient | null>(null)

  useEffect(() => {
    if (!ctx.connectWs || !window.LunaWS) return
    const registry = window.LunaWS.createFrameRegistry()

    registry.register("hello", (frame) => {
      store.dispatch(frame as Action)
      local.dispatch({ type: "capability", supported: helloHasAccountManage(frame) })
    })

    registry.register("account-list", (frame) => {
      store.dispatch(frame as Action)
    })

    registry.register("account-status", (frame) => {
      local.dispatch({
        type: "account-status-received",
        frame: frame as { requestId?: unknown; ok?: unknown; message?: unknown },
      })
    })

    const client = ctx.connectWs(registry, {})
    wsClientRef.current = client
    client.registerCloseHook(() => {
      local.dispatch({ type: "socket-closed" })
    })
    return () => {
      client.close()
      wsClientRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function submitAdd(): void {
    const id = state.idInput.trim()
    const label = state.labelInput.trim()
    const secretRef = state.secretRefInput.trim()
    if (!id || !label || !secretRef) {
      local.dispatch({
        type: "status-set",
        text: "Id, label, and secret-ref are required.",
        kind: "error",
      })
      return
    }
    if (!socketOpen(wsClientRef.current)) {
      local.dispatch({
        type: "status-set",
        text: "Not connected to a server.",
        kind: "error",
      })
      return
    }
    const requestId = newReqId()
    local.dispatch({ type: "submit-add-started", requestId })
    const sent = wsClientRef.current!.send({
      type: "account-add",
      requestId,
      id,
      label,
      kind: FIXED_ACCOUNT_KIND,
      secretRef,
    })
    if (!sent) {
      local.dispatch({
        type: "status-set",
        text: "Not connected to a server.",
        kind: "error",
      })
    }
  }

  function submitRemove(id: string): void {
    if (!socketOpen(wsClientRef.current)) {
      local.dispatch({
        type: "status-set",
        text: "Not connected to a server.",
        kind: "error",
      })
      return
    }
    const requestId = newReqId()
    local.dispatch({ type: "submit-rm-started", requestId })
    const sent = wsClientRef.current!.send({
      type: "account-rm",
      requestId,
      id,
    })
    if (!sent) {
      local.dispatch({
        type: "status-set",
        text: "Not connected to a server.",
        kind: "error",
      })
    }
  }

  if (state.supported === false) {
    return (
      <div className="moon-astryx-root settings-accounts" data-testid="settings-accounts">
        <p className="settings-accounts-lead" data-testid="account-manage-unsupported">
          This server doesn&apos;t support managing accounts from Moon. Use{" "}
          <code>luna account add|list|rm</code> on the host, then restart.
        </p>
      </div>
    )
  }

  return (
    <div className="moon-astryx-root settings-accounts" data-testid="settings-accounts">
      <p className="settings-accounts-lead">
        Anthropic provider accounts for Luna failover. Changes write to the server
        database and restart so AccountBroker reloads. Composer Auto still omits
        accountId.
      </p>

      <section className="settings-accounts-list" aria-label="Accounts">
        {accounts.length === 0 ? (
          <p className="settings-accounts-empty">No accounts yet.</p>
        ) : (
          <ul className="settings-accounts-rows">
            {accounts.map((a) => (
              <li key={a.id} className="settings-accounts-row" data-testid={`account-row-${a.id}`}>
                <div className="settings-accounts-row-main">
                  <span className="settings-accounts-label">{a.label}</span>
                  <span className="settings-accounts-id">{a.id}</span>
                  <Badge variant="neutral" label={a.kind} />
                  <Badge variant={healthBadgeVariant(a.health)} label={healthLabel(a.health)} />
                </div>
                <div className="settings-accounts-row-actions">
                  {state.confirmId === a.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        label="Confirm remove"
                        data-testid={`account-rm-confirm-${a.id}`}
                        onClick={() => submitRemove(a.id)}
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        label="Cancel"
                        onClick={() => local.dispatch({ type: "confirm-clear" })}
                      />
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="destructive"
                      label="Remove"
                      data-testid={`account-rm-${a.id}`}
                      onClick={() => local.dispatch({ type: "confirm-delete", id: a.id })}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-accounts-add" aria-label="Add account">
        <h3 className="settings-accounts-add-title">Add Anthropic account</h3>
        <TextInput
          label="Id"
          size="sm"
          value={state.idInput}
          data-testid="account-id-input"
          onChange={(value) => local.dispatch({ type: "id-changed", value })}
          placeholder="account-secondary-1"
        />
        <TextInput
          label="Label"
          size="sm"
          value={state.labelInput}
          data-testid="account-label-input"
          onChange={(value) => local.dispatch({ type: "label-changed", value })}
          placeholder="secondary"
        />
        <TextInput
          label="Secret ref"
          size="sm"
          type="password"
          value={state.secretRefInput}
          data-testid="account-secret-ref-input"
          onChange={(value) => local.dispatch({ type: "secret-ref-changed", value })}
          placeholder="claude-code:login | env:VAR | op://… | luna-op://…"
        />
        <Button
          label="Add account"
          variant="primary"
          size="sm"
          data-testid="account-add-submit"
          onClick={submitAdd}
        />
      </section>

      {state.statusLine ? (
        <p
          className={`settings-accounts-status settings-accounts-status-${state.statusLine.kind}`}
          data-testid="account-status"
          role="status"
        >
          {state.statusLine.text}
        </p>
      ) : null}
    </div>
  )
}
