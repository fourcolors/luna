import React, { useEffect, useMemo, useRef, useState } from "react";
import { TweakSection, TweakToggle } from "./tweaks-panel.jsx";

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function deriveVarName(name) {
  return String(name || "")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

export function humanizeRelTime(ts, nowMs = Date.now()) {
  const diffSec = Math.floor((nowMs - ts) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
}

export function writeTierLabel(tier) {
  if (tier === "keychain") return "New secrets → macOS Keychain";
  if (tier === "luna-vault") return "New secrets → Luna encrypted vault";
  return "New secrets → plaintext .env (LUNA_VAULT_STORAGE=env)";
}

export function storageStatusText(storage) {
  let text = writeTierLabel(storage.writeTier);
  if (storage.onePassword === "active") {
    text += " · 1Password: connected";
  } else if (storage.onePassword === "detected") {
    text += " · 1Password: CLI detected - connect a service account to use it";
  }
  if (storage.envResidue > 0) {
    text += ` · ${storage.envResidue} secret${storage.envResidue === 1 ? "" : "s"} still in plaintext .env - run the migration script to secure them`;
  }
  return text;
}

function newReqId() {
  return "vlt_" + (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`);
}

function sourceLabel(source) {
  if (source === "manual") return "manual";
  if (source === "agent") return "agent";
  if (source === "1password") return "1password";
  return "apple-import";
}

const emptyPending = { put: null, delete: null, sync: null };

export function VaultPanel({
  items,
  sync,
  storage,
  onPut,
  onDelete,
  onSyncConfig,
  lastStatus,
  disabled = false,
  closed = false,
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("env-secret");
  const [overrideVar, setOverrideVar] = useState(false);
  const [varName, setVarName] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState(null);
  const [pending, setPending] = useState(emptyPending);
  const [confirmId, setConfirmId] = useState(null);
  const valueRef = useRef(null);
  const unavailableRef = useRef(disabled || closed);

  const [showSync, setShowSync] = useState(false);
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncLabel, setSyncLabel] = useState("");
  const [syncVault, setSyncVault] = useState("Luna");
  const [syncPollSeconds, setSyncPollSeconds] = useState(300);
  const [syncSeeded, setSyncSeeded] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);

  const autoVarName = useMemo(() => deriveVarName(name), [name]);
  const effectiveVarName = overrideVar ? varName.trim() : autoVarName;
  const anyPending = pending.put || pending.delete || pending.sync;

  const wipeSecret = () => {
    if (valueRef.current) valueRef.current.value = "";
  };

  const resetForm = () => {
    wipeSecret();
    setName("");
    setKind("env-secret");
    setOverrideVar(false);
    setVarName("");
    setLabel("");
    setDescription("");
  };

  useEffect(() => () => wipeSecret(), []);

  useEffect(() => {
    const unavailable = disabled || closed;
    const wasUnavailable = unavailableRef.current;
    unavailableRef.current = unavailable;
    if (!unavailable) return;
    wipeSecret();
    setPending(emptyPending);
    setConfirmId(null);
    if (disabled && !wasUnavailable) {
      setStatus({ ok: false, text: "Connection lost - check the list after reconnecting." });
      setSyncStatus({ ok: false, text: "Connection lost - check the list after reconnecting." });
    }
  }, [disabled, closed]);

  useEffect(() => {
    if (!sync || syncSeeded) return;
    setSyncEnabled(!!sync.enabled);
    setSyncLabel(sync.opLabel || "");
    setSyncVault(sync.opVault || "Luna");
    setSyncPollSeconds(Math.max(60, sync.pollSeconds || 300));
    setSyncSeeded(true);
  }, [sync, syncSeeded]);

  useEffect(() => {
    if (!lastStatus) return;
    if (pending.put && lastStatus.requestId === pending.put.id) {
      setStatus({ ok: lastStatus.ok, text: lastStatus.message || (lastStatus.ok ? "Saved." : "That did not work.") });
      if (lastStatus.ok) {
        resetForm();
        setShowAdd(false);
      }
      setPending((p) => ({ ...p, put: null }));
      return;
    }
    if (pending.delete && lastStatus.requestId === pending.delete.id) {
      setStatus({ ok: lastStatus.ok, text: lastStatus.message || (lastStatus.ok ? "Deleted." : "That did not work.") });
      setPending((p) => ({ ...p, delete: null }));
      return;
    }
    if (pending.sync && lastStatus.requestId === pending.sync.id) {
      setSyncStatus({ ok: lastStatus.ok, text: lastStatus.message || (lastStatus.ok ? "Saved." : "That did not work.") });
      if (lastStatus.ok) setSyncSeeded(false);
      setPending((p) => ({ ...p, sync: null }));
    }
  }, [lastStatus, pending]);

  const closeAdd = () => {
    setPending((p) => ({ ...p, put: null }));
    resetForm();
    setShowAdd(false);
    setStatus(null);
  };

  const validate = () => {
    const n = name.trim();
    if (!n) return "Name is required.";
    if (n.length > 64) return "Name must be 64 characters or fewer.";
    const value = valueRef.current?.value || "";
    if (!value) return "Secret value is required.";
    if (kind === "env-secret") {
      if (!effectiveVarName || !VAR_RE.test(effectiveVarName)) {
        return "Variable name must start with a letter or underscore and contain only letters, numbers, and underscores.";
      }
      if (value.includes("\n") || value.includes("\r")) {
        return "Secret value for an API key or secret must not contain newlines.";
      }
    } else if (!label.trim() || !VAR_RE.test(label.trim())) {
      return "Label must start with a letter or underscore and contain only letters, numbers, and underscores.";
    }
    return null;
  };

  const submitAdd = (event) => {
    event.preventDefault();
    const err = validate();
    if (err) {
      setStatus({ ok: false, text: err });
      return;
    }
    const value = valueRef.current.value;
    valueRef.current.value = "";
    const requestId = newReqId();
    const desc = description.trim();
    setStatus(null);
    setPending((p) => ({ ...p, put: { id: requestId } }));
    if (kind === "env-secret") {
      onPut({
        requestId,
        name: name.trim(),
        kind: "env-secret",
        varName: effectiveVarName,
        value,
        ...(desc ? { description: desc } : {}),
      });
    } else {
      onPut({
        requestId,
        name: name.trim(),
        kind: "op-token",
        label: label.trim(),
        value,
        ...(desc ? { description: desc } : {}),
      });
    }
  };

  const armDelete = (id) => {
    setConfirmId(id);
    setStatus(null);
  };

  const confirmDelete = (item) => {
    const requestId = newReqId();
    setConfirmId(null);
    setStatus(null);
    setPending((p) => ({ ...p, delete: { id: requestId } }));
    onDelete({ requestId, id: item.id });
  };

  const saveSync = () => {
    if (!onSyncConfig || disabled) return;
    const requestId = newReqId();
    const pollSeconds = Math.max(60, Number(syncPollSeconds) || 300);
    setSyncPollSeconds(pollSeconds);
    setSyncStatus(null);
    setPending((p) => ({ ...p, sync: { id: requestId } }));
    onSyncConfig({
      requestId,
      enabled: !!syncEnabled,
      ...(syncLabel.trim() ? { opLabel: syncLabel.trim() } : {}),
      ...(syncVault.trim() ? { opVault: syncVault.trim() } : {}),
      pollSeconds,
    });
  };

  return (
    <div className="studio-vault">
      <div className="studio-vault-top">
        <div>
          <div className="studio-vault-kicker">Vault</div>
          <div className="studio-vault-sub">{items.length} credential{items.length === 1 ? "" : "s"} stored</div>
        </div>
        <button
          type="button"
          className="studio-vault-primary"
          disabled={disabled}
          onClick={() => {
            setStatus(null);
            setShowAdd(true);
          }}
        >
          Add credential
        </button>
      </div>

      {storage ? (
        <div className="studio-vault-storage" data-testid="studio-vault-storage">
          {storageStatusText(storage)}
        </div>
      ) : null}

      {status ? (
        <div className={status.ok ? "studio-vault-status ok" : "studio-vault-status error"} role={status.ok ? "status" : "alert"}>
          {status.text}
        </div>
      ) : null}

      <div className="studio-vault-list">
        {items.length === 0 ? (
          <div className="studio-vault-empty">No credentials stored yet.</div>
        ) : (
          items.map((item) => (
            <div key={item.id} className={"studio-vault-row" + (item.shadowed ? " shadowed" : "")}>
              <div className="studio-vault-main">
                <div className="studio-vault-name">
                  <span>{item.name}</span>
                  <span className="studio-vault-badge">{item.kind}</span>
                  {item.synced ? <span className="studio-vault-badge synced">synced</span> : null}
                  {item.shadowed ? <span className="studio-vault-badge warn">shadowed</span> : null}
                </div>
                <div className="studio-vault-meta">
                  <code>{item.ref}</code>
                  <span>{sourceLabel(item.source)}</span>
                  {item.description ? <span>{item.description}</span> : null}
                </div>
              </div>
              {confirmId === item.id ? (
                <div className="studio-vault-confirm">
                  <span>{item.kind === "op-token" ? "Delete this 1Password token? The server will restart." : "Delete this credential?"}</span>
                  <button type="button" className="studio-vault-danger" disabled={disabled} onClick={() => confirmDelete(item)}>
                    Confirm delete
                  </button>
                  <button type="button" className="studio-vault-ghost" onClick={() => setConfirmId(null)}>
                    Keep
                  </button>
                </div>
              ) : (
                <button type="button" className="studio-vault-ghost danger" disabled={disabled} onClick={() => armDelete(item.id)}>
                  Delete
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {showAdd ? (
        <form className="studio-vault-form" onSubmit={submitAdd} autoComplete="off">
          <TweakSection label="Add credential" />
          <label className="studio-vault-field">
            <span>Name</span>
            <input id="studio-vault-name" type="text" value={name} maxLength={64} disabled={disabled} onChange={(e) => setName(e.target.value)} placeholder="Notion API Key" />
          </label>
          <label className="studio-vault-field">
            <span>Kind</span>
            <select id="studio-vault-kind" value={kind} disabled={disabled} onChange={(e) => setKind(e.target.value)}>
              <option value="env-secret">env-secret</option>
              <option value="op-token">op-token</option>
            </select>
          </label>

          {kind === "env-secret" ? (
            <div className="studio-vault-var">
              <button
                type="button"
                className="studio-vault-override"
                role="switch"
                aria-checked={overrideVar}
                onClick={() => {
                  if (!overrideVar) setVarName(autoVarName);
                  setOverrideVar((v) => !v);
                }}
              >
                Override env var
              </button>
              {overrideVar ? (
                <label className="studio-vault-field">
                  <span>Env variable</span>
                  <input id="studio-vault-var-name" type="text" value={varName} disabled={disabled} onChange={(e) => setVarName(e.target.value)} />
                </label>
              ) : (
                <div className="studio-vault-preview">
                  <span>Env variable</span>
                  <code>{autoVarName || "ENV_VAR_NAME"}</code>
                </div>
              )}
            </div>
          ) : (
            <label className="studio-vault-field">
              <span>Label</span>
              <input id="studio-vault-label" type="text" value={label} disabled={disabled} onChange={(e) => setLabel(e.target.value)} placeholder="primary" />
              <small>Saving a 1Password token will restart the server.</small>
            </label>
          )}

          <label className="studio-vault-field">
            <span>Secret value</span>
            <input id="studio-vault-value" ref={valueRef} type="password" disabled={disabled} autoComplete="new-password" placeholder="Paste the secret value" />
          </label>
          <label className="studio-vault-field">
            <span>Description</span>
            <input id="studio-vault-description" type="text" value={description} disabled={disabled} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
          </label>
          <div className="studio-vault-actions">
            <button type="submit" className="studio-vault-primary" disabled={disabled || !!anyPending}>
              {pending.put ? "Saving..." : "Save credential"}
            </button>
            <button type="button" className="studio-vault-ghost" onClick={closeAdd}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <div className="studio-vault-sync">
        <button type="button" className="studio-vault-sync-title" onClick={() => setShowSync((v) => !v)} aria-expanded={showSync}>
          1Password sync
        </button>
        <div className="studio-vault-sync-summary">
          {sync?.enabled ? "on" : "off"}
          {sync?.lastSyncedAt ? ` · synced ${humanizeRelTime(sync.lastSyncedAt)}` : ""}
        </div>
        {sync?.lastError ? <div className="studio-vault-status error" role="alert">{sync.lastError}</div> : null}
        {syncStatus ? <div className={syncStatus.ok ? "studio-vault-status ok" : "studio-vault-status error"}>{syncStatus.text}</div> : null}

        {showSync ? (
          <div className="studio-vault-sync-fields">
            <div className={disabled ? "studio-vault-control disabled" : "studio-vault-control"}>
              <TweakToggle label="Enable" value={syncEnabled} onChange={(v) => !disabled && setSyncEnabled(v)} />
            </div>
            <label className="studio-vault-field">
              <span>Account label</span>
              <input id="studio-vault-sync-label" type="text" value={syncLabel} disabled={disabled} onChange={(e) => setSyncLabel(e.target.value)} placeholder="primary" />
            </label>
            <label className="studio-vault-field">
              <span>1Password vault</span>
              <input id="studio-vault-sync-vault" type="text" value={syncVault} disabled={disabled} onChange={(e) => setSyncVault(e.target.value)} placeholder="Luna" />
            </label>
            <label className="studio-vault-field">
              <span>Poll seconds</span>
              <input
                id="studio-vault-sync-poll"
                type="number"
                min={60}
                value={syncPollSeconds}
                disabled={disabled}
                onChange={(e) => setSyncPollSeconds(Math.max(60, Number(e.target.value) || 60))}
              />
            </label>
            <button type="button" className="studio-vault-primary" disabled={disabled || !!pending.sync} onClick={saveSync}>
              {pending.sync ? "Saving..." : "Save sync settings"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
