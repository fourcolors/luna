/**
 * VncCards.tsx - the three overlay cards Screen Share shows over the screen
 * area: Connect, Login (whatever fields the server asked for), and the RA2
 * server-identity check. Presentational only; actions come from the panel.
 */
import { useState } from "react"
import { Button, TextInput } from "../../astryx-kit"
import type { CredField, RecentHost } from "./vncModel"

const FIELD_LABEL: Record<CredField, string> = {
  username: "Username",
  password: "Password",
  target: "Target",
}

export interface ConnectCardProps {
  host: string
  port: string
  password: string
  onHost: (v: string) => void
  onPort: (v: string) => void
  onPassword: (v: string) => void
  onConnect: () => void
  /** True when the form was pre-filled by open_widget, not typed. */
  prefilled: boolean
  isError: boolean
  status: string | null
  recent: RecentHost[]
  onPickRecent: (r: RecentHost) => void
  onForgetRecent: (r: RecentHost) => void
  /** Opens the noVNC source page in the default browser (MPL-2.0 notice). */
  onOpenViewerSource: () => void
}

export function ConnectCard(p: ConnectCardProps) {
  return (
    <div className={"vnc-connect-card" + (p.isError ? " is-error" : "")}>
      <div className="vnc-connect-title">Connect</div>
      {p.prefilled && (
        <div className="vnc-prefill-note" data-testid="vnc-prefill-note">
          Luna filled this in. Check the host, then press Connect.
        </div>
      )}
      <div className="vnc-fields">
        <div className="vnc-field-row">
          <div className="vnc-field">
            <span>Host</span>
            <TextInput label="Host" isLabelHidden placeholder="host or ws://" value={p.host} onChange={p.onHost} data-testid="vnc-host-input" />
          </div>
          <div className="vnc-field vnc-field-port">
            <span>Port</span>
            <TextInput label="Port" isLabelHidden placeholder="5900" value={p.port} onChange={p.onPort} width={72} data-testid="vnc-port-input" />
          </div>
        </div>
        <div className="vnc-field">
          <span>Password</span>
          <TextInput label="Password" isLabelHidden type="password" placeholder="optional" value={p.password} onChange={p.onPassword} data-testid="vnc-password-input" />
        </div>
        <div className="vnc-actions">
          <Button label={p.isError ? "Try again" : "Connect"} variant="primary" size="sm" onClick={p.onConnect} data-testid="vnc-connect-btn" />
        </div>
      </div>
      {p.status && (
        <div
          className={"vnc-status" + (p.isError ? " error" : "")}
          role={p.isError ? "alert" : "status"}
          data-testid="vnc-status"
        >
          {p.status}
        </div>
      )}
      {p.recent.length > 0 && (
        <div className="vnc-recent" data-testid="vnc-recent">
          <span className="vnc-recent-label">Recent</span>
          {p.recent.map((r) => (
            <span className="vnc-recent-chip" key={`${r.host}:${r.port}`}>
              <button type="button" className="vnc-recent-pick" onClick={() => p.onPickRecent(r)} title="Fill in this host">
                {r.host}
                {r.port && r.port !== "5900" && !/^wss?:/i.test(r.host) ? `:${r.port}` : ""}
              </button>
              <button type="button" className="vnc-recent-forget" onClick={() => p.onForgetRecent(r)} aria-label={`Forget ${r.host}`} title="Forget">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="vnc-connect-hint">
        Passwords stay on this device and are never saved.{" "}
        <button type="button" className="vnc-link" onClick={p.onOpenViewerSource} data-testid="vnc-novnc-link">
          noVNC source (MPL-2.0)
        </button>
      </div>
    </div>
  )
}

export function CredentialsCard(p: {
  fields: CredField[]
  initialPassword: string
  onSubmit: (creds: Partial<Record<CredField, string>>) => void
  onCancel: () => void
}) {
  // Every requested field starts defined: noVNC re-asks for any field that
  // is undefined, which would make Continue look like it did nothing.
  const [values, setValues] = useState<Record<CredField, string>>(() => ({
    username: "",
    target: "",
    password: p.fields.includes("password") ? p.initialPassword : "",
  }))
  const [missing, setMissing] = useState<string | null>(null)
  const submit = () => {
    const empty = p.fields.filter((f) => f !== "password" && !values[f].trim())
    if (empty.length > 0) {
      setMissing(`Enter ${empty.map((f) => FIELD_LABEL[f].toLowerCase()).join(" and ")}.`)
      return
    }
    const creds: Partial<Record<CredField, string>> = {}
    for (const f of p.fields) creds[f] = values[f]
    p.onSubmit(creds)
  }
  return (
    <div className="vnc-connect-card">
      <div className="vnc-connect-title">Sign in</div>
      <div className="vnc-connect-hint">This screen asked for a login.</div>
      <div className="vnc-fields">
        {p.fields.map((f) => (
          <div className="vnc-field" key={f}>
            <span>{FIELD_LABEL[f]}</span>
            <TextInput
              label={FIELD_LABEL[f]}
              isLabelHidden
              {...(f === "password" ? { type: "password" as const } : {})}
              value={values[f]}
              onChange={(v: string) => setValues((s) => ({ ...s, [f]: v }))}
              data-testid={`vnc-cred-${f}`}
            />
          </div>
        ))}
        {missing && (
          <div className="vnc-status error" role="alert" data-testid="vnc-cred-missing">
            {missing}
          </div>
        )}
        <div className="vnc-actions">
          <Button label="Cancel" variant="ghost" size="sm" onClick={p.onCancel} data-testid="vnc-cred-cancel" />
          <Button label="Continue" variant="primary" size="sm" onClick={submit} data-testid="vnc-cred-submit" />
        </div>
      </div>
    </div>
  )
}

export function VerifyCard(p: { fingerprint: string; onApprove: () => void; onCancel: () => void }) {
  return (
    <div className="vnc-connect-card">
      <div className="vnc-connect-title">Check this server</div>
      <div className="vnc-connect-hint">Encrypted login. Compare this fingerprint with the one on the remote computer.</div>
      <code className="vnc-fingerprint" data-testid="vnc-fingerprint">
        {p.fingerprint}
      </code>
      <div className="vnc-actions">
        <Button label="Cancel" variant="ghost" size="sm" onClick={p.onCancel} data-testid="vnc-verify-cancel" />
        <Button label="Trust and connect" variant="primary" size="sm" onClick={p.onApprove} data-testid="vnc-verify-approve" />
      </div>
    </div>
  )
}
