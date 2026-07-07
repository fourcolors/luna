// vault-panel.jsx — the Luna Vault settings section, ported from
// packages/ui-shared-solid/src/VaultPanel.tsx to React idiom.
//
// Renders the credential registry: list (name, kind badge, ref mono,
// source, synced/shadowed badges, inline-confirm delete) + an add form
// (name, kind select, auto-derived var name with advanced override, value
// password input, optional note), a 1Password sync section (enable toggle,
// account-label picker, vault-name input, poll-interval, last-synced/error
// status), and an Apple Passwords CSV import (RFC-4180 parse -> preview
// (titles only, NEVER passwords) -> sequential chunk sends with per-chunk
// acks).
//
// Gate rendering on `capabilities.vault` at the call site (see the
// integration spec returned alongside this file) — this component assumes
// the server supports the frames.
//
// Security contract (verbatim from the Solid original):
//   - The credential value lives ONLY in the type=password input, read via
//     an uncontrolled ref — it is NEVER lifted into React state.
//   - It is wiped one-shot on submit, cancel, panel unmount, and disconnect.
//   - CSV row passwords are held in this component's local state only (never
//     lifted to ctx/the reducer), cleared after send / abort / unmount.
//   - NEVER stored in localStorage, NEVER logged, NEVER rendered back.
//   - Server-sent strings are rendered via plain JSX text children (React
//     escapes automatically), never via dangerouslySetInnerHTML.
//   - vault-sync-config and vault-import sends use the OPEN-socket guard
//     (the `disabled` prop gates the UI; sends only happen when enabled).
//
// Status acks: vault-status frames are NOT stored in the reducer (see
// packages/ui-shared/src/reducer.ts — it returns state unchanged; the fresh
// vault-list that follows a successful mutation is what updates the list).
// Unlike the Solid original (whose owning App.tsx intercepted vault-status
// before the reducer and handed the ack down as a `lastStatus` prop), THIS
// panel owns that interception itself: it subscribes via the `onServerFrame`
// prop (ctx.onServerFrame from useLunaData) in a useEffect and keeps the
// last ack in local state, unsubscribing on cleanup.
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * @typedef {import("@luna/ui-shared").VaultWireItem} VaultWireItem
 * @typedef {import("@luna/ui-shared").VaultSyncWire} VaultSyncWire
 */

/**
 * @typedef {{ requestId: string, ok: boolean, message: string }} VaultStatusAck
 */

/**
 * Derive an env-var name from a human-readable credential name.
 * "Notion API Key" -> "NOTION_API_KEY"
 * Strips non-word characters, uppercases, collapses repeated underscores.
 * @param {string} name
 * @returns {string}
 */
export function deriveVarName(name) {
  return name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function kindLabel(kind) {
  if (kind === "env-secret") return "env";
  if (kind === "op-token") return "op-token";
  return "op-item";
}

function sourceLabel(source) {
  if (source === "manual") return "manual";
  if (source === "agent") return "agent";
  if (source === "1password") return "1P";
  return "import";
}

/**
 * Human phrasing for where a NEW secret will land (vault-list.storage.writeTier,
 * PR #241 tiered storage). Strings match the Moon settings-vault panel exactly
 * so both surfaces describe the same install identically.
 * @param {string} tier
 * @returns {string}
 */
export function writeTierLabel(tier) {
  if (tier === "keychain") return "New secrets → macOS Keychain";
  if (tier === "luna-vault") return "New secrets → Luna encrypted vault";
  return "New secrets → plaintext .env (LUNA_VAULT_STORAGE=env)";
}

/**
 * The compact storage status line for a vault-list.storage snapshot: write
 * tier, 1Password probe state, and the plaintext .env residue COUNT (never
 * names or values). Callers hide the line entirely when storage is absent
 * (a pre-tiered-storage server omits the field).
 * @param {{ writeTier: string, onePassword: string, envResidue: number }} storage
 * @returns {string}
 */
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

/**
 * Safe UUID generation: crypto.randomUUID() is secure-context-only and
 * undefined over plain http from a non-localhost host. Fall back to a
 * Date+Math.random combination (not cryptographically strong, but fine
 * for correlation IDs that never leave the session).
 * @returns {string}
 */
export function newReqId() {
  return (
    "vlt_" +
    (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`)
  );
}

/**
 * humanizeRelTime — convert a unix-ms timestamp to a short human-readable
 * relative string ("just now", "3 minutes ago", "2 hours ago", "5 days ago").
 * Pure function so it is easy to test.
 * @param {number} ts
 * @param {number} [nowMs]
 * @returns {string}
 */
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

// ── RFC-4180 CSV parser ────────────────────────────────────────────────────

/**
 * A parsed row from an Apple Passwords CSV export.
 * `OTPAuth` is ignored by design (we never handle TOTP seeds).
 * @typedef {{ title: string, url: string, username: string, password: string, notes: string }} AppleCsvRow
 */

/**
 * parseAppleCsv — hand-rolled RFC-4180 parser tuned for Apple Passwords.
 *
 * Handles:
 *   - Quoted fields with embedded commas, newlines, and "" escape.
 *   - Case-insensitive header matching (Title, URL, Username, Password, Notes,
 *     OTPAuth accepted; extra columns tolerated; columns may be reordered).
 *   - CRLF and LF line endings.
 *   - Rows missing Title or Password are silently dropped.
 *   - OTPAuth column is present-but-ignored with no warning.
 *
 * Security: `password` fields stay in memory only and must be cleared by the
 * caller after use.
 * @param {string} raw
 * @returns {AppleCsvRow[]}
 */
export function parseAppleCsv(raw) {
  // Strip a leading UTF-8 BOM (U+FEFF) if present — Excel and some macOS
  // exporters prepend it; it would corrupt the first header column name.
  const input = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  // Split the raw text into RFC-4180 cells. We use a state-machine parser
  // that correctly handles quoted fields containing commas and newlines.
  const records = tokenizeCsv(input);
  if (records.length < 2) return [];

  // Build a case-insensitive column index from the header row.
  const headers = records[0].map((h) => h.trim().toLowerCase());
  const idx = (name) => headers.indexOf(name);

  const colTitle = idx("title");
  const colUrl = idx("url");
  const colUsername = idx("username");
  const colPassword = idx("password");
  const colNotes = idx("notes");

  // Must have at minimum a title and a password column to produce useful rows.
  if (colTitle === -1 || colPassword === -1) return [];

  const results = [];
  for (let i = 1; i < records.length; i++) {
    const row = records[i];
    // Trim all columns except password — password may legitimately have leading
    // or trailing spaces and must be preserved exactly as the user stored it.
    const getColTrimmed = (col) => (col !== -1 && col < row.length ? (row[col] ?? "").trim() : "");
    const getColRaw = (col) => (col !== -1 && col < row.length ? (row[col] ?? "") : "");

    const title = getColTrimmed(colTitle);
    const password = getColRaw(colPassword);
    // Drop rows with no title, or where the password is empty (after trim).
    if (!title || password.trim() === "") continue;

    results.push({
      title,
      url: getColTrimmed(colUrl),
      username: getColTrimmed(colUsername),
      password, // raw — preserve spaces
      notes: getColTrimmed(colNotes),
    });
  }
  return results;
}

/**
 * tokenizeCsv — low-level RFC-4180 tokenizer. Returns an array of rows,
 * each row being an array of field strings (unescaped).
 * @param {string} raw
 * @returns {string[][]}
 */
export function tokenizeCsv(raw) {
  const records = [];
  let row = [];
  let field = "";
  let inQuote = false;
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];

    if (inQuote) {
      if (ch === '"') {
        // Peek at next char: "" -> escaped quote; otherwise end of quoted field.
        if (raw[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuote = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
        i++;
      } else if (ch === ",") {
        row.push(field);
        field = "";
        i++;
      } else if (ch === "\r") {
        // CRLF: skip the \r; the \n will be the row terminator
        i++;
      } else if (ch === "\n") {
        row.push(field);
        field = "";
        records.push(row);
        row = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }

  // Flush the last field/row (no trailing newline case).
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((f) => f !== "")) {
      records.push(row);
    }
  }

  return records;
}

// ── Component ──────────────────────────────────────────────────────────────

/** Derive op-token labels from vault items (kind='op-token', ref='luna-op://<label>'). */
export function extractOpLabels(items) {
  const labels = [];
  for (const item of items) {
    if (item.kind === "op-token" && item.ref.startsWith("luna-op://")) {
      const label = item.ref.slice("luna-op://".length).split("/")[0];
      if (label) labels.push(label);
    }
  }
  return labels;
}

// Each chunk item requires one `op item create` CLI call + a network round-trip
// to 1Password. At ~5 items/chunk the per-chunk wall-clock time stays well under
// CHUNK_ACK_TIMEOUT_MS even on a slow connection, avoiding false timeouts that
// would cause duplicate items on retry.
const IMPORT_CHUNK_SIZE = 5;
const CHUNK_ACK_TIMEOUT_MS = 120_000; // 2 minutes per chunk; each item ~= one op CLI + roundtrip
const LARGE_IMPORT_THRESHOLD = 80;

/**
 * @param {{
 *   items: ReadonlyArray<VaultWireItem>,
 *   sync: VaultSyncWire | null,
 *   disabled?: boolean,
 *   onPut: (params: { requestId: string, name: string, kind: "env-secret"|"op-token", varName?: string, label?: string, value: string, description?: string }) => void,
 *   onDelete: (params: { requestId: string, id: string }) => void,
 *   onSyncConfig?: (params: { requestId: string, enabled: boolean, opLabel?: string, opVault?: string, pollSeconds?: number }) => void,
 *   onImport?: (params: { requestId: string, items: ReadonlyArray<{ title: string, url?: string, username?: string, password: string, notes?: string }> }) => void,
 *   onServerFrame: (listener: (frame: import("@luna/ui-shared/core").ServerFrame) => void) => (() => void),
 * }} props
 */
export function VaultPanel({ items, sync, storage, disabled, onPut, onDelete, onSyncConfig, onImport, onServerFrame }) {
  const rows = items || [];

  // ── vault-status ack interception (owned by this panel) ────────────────
  // The reducer no-ops vault-status by design (see file header); this panel
  // subscribes to the raw frame stream itself instead of receiving an ack
  // prop from a parent store, since Studio's ctx has no such store.
  const [lastStatus, setLastStatus] = useState(null);
  useEffect(() => {
    if (!onServerFrame) return undefined;
    return onServerFrame((frame) => {
      if (frame && frame.type === "vault-status") {
        setLastStatus({ requestId: frame.requestId, ok: frame.ok, message: frame.message });
      }
    });
  }, [onServerFrame]);
  // Latest-value ref so the sequential importer's setInterval poll (below)
  // never reads a stale closure over `lastStatus`.
  const lastStatusRef = useRef(lastStatus);
  useEffect(() => {
    lastStatusRef.current = lastStatus;
  }, [lastStatus]);

  // Latest-value ref so a long-running import loop always checks the FRESH
  // disabled flag (a socket drop mid-import must abort the very next chunk).
  const disabledRef = useRef(disabled === true);
  useEffect(() => {
    disabledRef.current = disabled === true;
  }, [disabled]);

  // ── add form state ───────────────────────────────────────────────────
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("env-secret");
  const [varNameOverride, setVarNameOverride] = useState(null);
  const [showVarOverride, setShowVarOverride] = useState(false);
  // Finding 1: op-token has its own label state so the typed value is used
  // directly in validateForm and handleSubmit instead of the env-var path.
  const [opTokenLabel, setOpTokenLabel] = useState("");
  // Mutable ref — the password input value is managed via DOM ref, not
  // React state, so it never appears in any devtools/render snapshot.
  const valueInputRef = useRef(null);
  const [note, setNote] = useState("");

  // ── in-flight request tracking ───────────────────────────────────────
  // Finding 6: track op + id together so delete-ok never resets the add form
  // and Save only shows "Saving..." when a put is in flight.
  const [pending, setPending] = useState(null); // { id, op: "put"|"delete"|"sync"|"import" } | null
  const [statusMsg, setStatusMsg] = useState(null); // { ok, text } | null

  // ── delete confirm ───────────────────────────────────────────────────
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  // ── sync section state ───────────────────────────────────────────────
  const [showSync, setShowSync] = useState(false);
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncOpLabel, setSyncOpLabel] = useState("");
  const [syncOpVault, setSyncOpVault] = useState("Luna");
  const [syncPollSeconds, setSyncPollSeconds] = useState(300);

  // Seed flag: true once the sync form has been seeded from a non-null
  // `sync` prop; only re-seeded after a successful sync-save ack. Kept in a
  // ref (Solid's untrack()-guarded peek) so the seed effect re-runs ONLY on a
  // new `sync` delivery, never merely because the flag itself flipped —
  // otherwise clearing it from the ack-correlate effect below would
  // immediately re-trigger this effect against the stale `sync` value.
  const syncSeededRef = useRef(false);
  useEffect(() => {
    if (sync == null) return;
    if (syncSeededRef.current) return;
    setSyncEnabled(sync.enabled);
    if (sync.opLabel) setSyncOpLabel(sync.opLabel);
    if (sync.opVault) setSyncOpVault(sync.opVault);
    setSyncPollSeconds(Math.max(60, sync.pollSeconds));
    syncSeededRef.current = true;
  }, [sync]);

  // ── CSV import state ─────────────────────────────────────────────────
  // Security: rows array lives in local component state only (never lifted
  // to ctx/the reducer) — cleared after send / abort / unmount.
  const [importRows, setImportRows] = useState([]);
  const [importProgress, setImportProgress] = useState(null);
  const [importDone, setImportDone] = useState(false);
  const fileInputRef = useRef(null);

  // Finding 7: explicit cleanup of the value input + any parsed CSV rows on
  // unmount.
  useEffect(() => {
    return () => {
      if (valueInputRef.current) valueInputRef.current.value = "";
      setImportRows([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const opLabels = useMemo(() => extractOpLabels(rows), [rows]);

  // Correlate incoming vault-status acks with our pending request.
  useEffect(() => {
    const ack = lastStatus;
    if (!ack) return;
    const p = pending;
    if (!p || ack.requestId !== p.id) return;
    setStatusMsg({ ok: ack.ok, text: ack.message });
    // Finding 6: only reset the add form when it was a put that succeeded.
    if (ack.ok && p.op === "put") resetForm();
    // Sync-save ack: allow re-seed on the next `sync` delivery so the saved
    // state (e.g. corrected pollSeconds from the server) reflects.
    if (ack.ok && p.op === "sync") syncSeededRef.current = false;
    // For sync config: show ack but do not close the section.
    // For import: handled in the sequential importer (resolveAck there).
    if (p.op !== "import") setPending(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastStatus, pending]);

  // Finding 3: when `disabled` transitions true (socket drop / op-token
  // restart) clear any lingering pending id and show a neutral
  // connection-lost message. Functional updates so this effect only needs to
  // depend on `disabled` itself.
  useEffect(() => {
    if (!disabled) return;
    setPending((p) => {
      if (p !== null) {
        setStatusMsg({ ok: false, text: "Connection lost — check the list after reconnecting." });
      }
      return null;
    });
    if (valueInputRef.current) valueInputRef.current.value = "";
    setImportRows((prevRows) => {
      if (prevRows.length > 0) {
        setImportProgress(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return [];
      }
      return prevRows;
    });
  }, [disabled]);

  const autoVarName = useMemo(() => deriveVarName(name), [name]);
  const effectiveVarName = useMemo(
    () => (showVarOverride && varNameOverride !== null ? varNameOverride : autoVarName),
    [showVarOverride, varNameOverride, autoVarName],
  );

  /** Wipe secret value and reset all form state. */
  function resetForm() {
    if (valueInputRef.current) valueInputRef.current.value = "";
    setName("");
    setKind("env-secret");
    setVarNameOverride(null);
    setShowVarOverride(false);
    setOpTokenLabel("");
    setNote("");
  }

  function closeAdd() {
    // Finding 3: abandoning the form while a put is in-flight clears pending.
    setPending(null);
    resetForm();
    setShowAdd(false);
    setStatusMsg(null);
  }

  function validateForm() {
    const n = name.trim();
    if (n.length === 0) return "Name is required.";
    if (n.length > 64) return "Name must be 64 characters or fewer.";
    if (kind === "env-secret") {
      // Finding 1: env-secret path unchanged — uses effectiveVarName.
      const vn = effectiveVarName;
      if (!vn || !VAR_RE.test(vn)) {
        return "Variable name must start with a letter or underscore and contain only letters, numbers, and underscores.";
      }
    } else {
      // Finding 1: op-token uses its own label state, not effectiveVarName.
      const lbl = opTokenLabel.trim();
      if (!lbl || !VAR_RE.test(lbl)) {
        return "Label must start with a letter or underscore and contain only letters, numbers, and underscores.";
      }
    }
    const val = valueInputRef.current?.value ?? "";
    if (val.length === 0) return "Secret value is required.";
    if (kind === "env-secret" && val.includes("\n")) {
      return "Secret value for an API key/secret must not contain newlines.";
    }
    return null;
  }

  function handleSubmit() {
    const err = validateForm();
    if (err) {
      setStatusMsg({ ok: false, text: err });
      return;
    }
    const val = valueInputRef.current.value;
    // Finding 4: use safe newReqId() instead of a bare crypto.randomUUID() call.
    const reqId = newReqId();
    const trimmedName = name.trim();
    const desc = note.trim();

    // Wipe the input immediately after reading — one-shot.
    // NOTE (finding 8): a dead-socket send buffer can retain secret-bearing
    // frames; this is accepted V1 behavior — the secret has already left the
    // DOM and the send is best-effort.
    valueInputRef.current.value = "";

    setStatusMsg(null);
    // Finding 6: mark as put so delete-ok never inadvertently resets the form.
    setPending({ id: reqId, op: "put" });

    if (kind === "env-secret") {
      onPut({
        requestId: reqId,
        name: trimmedName,
        kind: "env-secret",
        varName: effectiveVarName,
        value: val,
        ...(desc ? { description: desc } : {}),
      });
    } else {
      // Finding 1: op-token carries the explicitly typed label, not effectiveVarName.
      onPut({
        requestId: reqId,
        name: trimmedName,
        kind: "op-token",
        label: opTokenLabel.trim(),
        value: val,
        ...(desc ? { description: desc } : {}),
      });
    }
  }

  function handleDelete(item) {
    // Finding 4: use safe newReqId() instead of a bare crypto.randomUUID() call.
    const reqId = newReqId();
    setConfirmDeleteId(null);
    setStatusMsg(null);
    // Finding 6: mark as delete so a delete-ok never resets the add form.
    setPending({ id: reqId, op: "delete" });
    onDelete({ requestId: reqId, id: item.id });
  }

  // ── sync config save ─────────────────────────────────────────────────

  function handleSyncSave() {
    if (!onSyncConfig || disabled) return;
    const reqId = newReqId();
    setPending({ id: reqId, op: "sync" });
    setStatusMsg(null);
    const label = syncOpLabel.trim();
    const vault = syncOpVault.trim();
    onSyncConfig({
      requestId: reqId,
      enabled: syncEnabled,
      ...(label ? { opLabel: label } : {}),
      ...(vault ? { opVault: vault } : {}),
      pollSeconds: syncPollSeconds,
    });
  }

  // ── CSV import ───────────────────────────────────────────────────────

  function handleFileChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      const parsed = parseAppleCsv(text);
      setImportRows(parsed);
      setImportProgress(null);
      setImportDone(false);
    };
    reader.readAsText(file);
  }

  /**
   * clearImportRowsAndFile — wipes the in-memory CSV rows and resets the file
   * input after send/abort. Does NOT touch importDone so the "Done" message
   * stays visible until the user explicitly dismisses it.
   */
  function clearImportRowsAndFile() {
    setImportRows([]);
    setImportProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function clearImportState() {
    clearImportRowsAndFile();
    setImportDone(false);
  }

  /**
   * runImport — sequential chunk sender.
   * Sends IMPORT_CHUNK_SIZE rows at a time (protocol cap is 20); waits for each
   * vault-status ack before the next.
   * On a failed chunk: stops and shows the server message + count so far.
   */
  async function runImport() {
    if (!onImport || disabled) return;
    const rowsToSend = importRows;
    if (rowsToSend.length === 0) return;

    let sent = 0;
    const total = rowsToSend.length;

    for (let start = 0; start < total; start += IMPORT_CHUNK_SIZE) {
      if (disabledRef.current) {
        clearImportRowsAndFile(); // wipe in-memory passwords FIRST (mirrors failed-chunk branch)
        setImportProgress("Import aborted — connection lost.");
        return;
      }

      const chunk = rowsToSend.slice(start, start + IMPORT_CHUNK_SIZE);
      const reqId = newReqId();

      // We need to await an ack for THIS reqId before the next chunk. We
      // register a one-shot promise resolved by a poll over lastStatusRef
      // (kept fresh by the effect above) instead of cross-effect entanglement.
      const ackPromise = new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          const ack = lastStatusRef.current;
          if (ack && ack.requestId === reqId) {
            clearInterval(checkInterval);
            clearTimeout(safetyTimer); // cancel the safety timer — no dangling timer
            resolve(ack);
          }
        }, 50);
        // Safety timeout: cleared above when the ack arrives so no dangling timer.
        // CHUNK_ACK_TIMEOUT_MS is generous (2 min per chunk) — each item is one
        // op CLI call + network roundtrip, so 5 items/chunk clears it easily.
        const safetyTimer = setTimeout(() => {
          clearInterval(checkInterval);
          resolve({ requestId: reqId, ok: false, message: "Timed out waiting for server acknowledgement." });
        }, CHUNK_ACK_TIMEOUT_MS);
      });

      setPending({ id: reqId, op: "import" });
      setImportProgress(`Importing... ${sent} of ${total} done`);

      onImport({
        requestId: reqId,
        items: chunk.map((r) => ({
          title: r.title,
          ...(r.url ? { url: r.url } : {}),
          ...(r.username ? { username: r.username } : {}),
          password: r.password,
          ...(r.notes ? { notes: r.notes } : {}),
        })),
      });

      const ack = await ackPromise;
      setPending(null);

      if (!ack.ok) {
        // Security: wipe in-memory passwords after failure first, then set
        // the error message (clearImportRowsAndFile clears progress too).
        clearImportRowsAndFile();
        setImportProgress(`Import stopped after ${sent} of ${total} — server said: ${ack.message}`);
        return;
      }

      sent += chunk.length;
      setImportProgress(`Imported ${sent} of ${total}...`);
    }

    // All chunks sent successfully.
    setImportProgress(null);
    // Security: wipe in-memory passwords immediately.
    clearImportRowsAndFile();
    // Show "Done" message (stays until the user clicks "Import another").
    setImportDone(true);
  }

  return (
    <div className="skills-panel vault-panel">
      <div className="skills-head">
        <span className="skills-title">Vault</span>
        <span className="skills-count">{rows.length} stored</span>
        {!showAdd && (
          <button
            type="button"
            className="chip small"
            disabled={disabled === true}
            onClick={() => {
              setStatusMsg(null);
              setShowAdd(true);
            }}
          >
            + Add
          </button>
        )}
      </div>

      {/* Tiered-storage status (PR #241): rendered as a text node only; count,
          never names/values. Hidden entirely when the server predates the
          vault-list.storage field. */}
      {storage && <div className="vault-storage-line">{storageStatusText(storage)}</div>}

      {statusMsg && (
        <div className={statusMsg.ok ? "vault-status-ok" : "skills-error"} role={statusMsg.ok ? "status" : "alert"}>
          {statusMsg.text}
        </div>
      )}

      {/* ── list ─────────────────────────────────────────────────── */}
      <div className="skills-list vault-list">
        {rows.length === 0 ? (
          <div className="skills-empty">No credentials stored yet.</div>
        ) : (
          rows.map((item) => (
            <div key={item.id} className="skill-row vault-row">
              <div className="skill-meta">
                <span className="skill-name">
                  {item.name}
                  <span className={`skill-badge vault-kind-${item.kind}`}>{kindLabel(item.kind)}</span>
                  {item.synced && (
                    <span className="skill-badge vault-badge-synced" title="Confirmed in 1Password">
                      1P
                    </span>
                  )}
                  {item.shadowed && (
                    <span
                      className="skill-badge vault-badge-shadowed"
                      title="Defined by the server's environment — edits here won't take effect"
                    >
                      shadowed
                    </span>
                  )}
                </span>
                <span className="skill-desc">
                  <code className="vault-ref">{item.ref}</code>
                  {" · "}
                  {sourceLabel(item.source)}
                  {item.description && (
                    <>
                      {" · "}
                      {item.description}
                    </>
                  )}
                </span>
              </div>
              {confirmDeleteId === item.id ? (
                // Finding 5: warn about server restart when deleting an op-token.
                <span className="vault-confirm-prompt">
                  {item.kind === "op-token" ? "Delete? This will restart the server. " : "Delete? "}
                  <button
                    type="button"
                    className="chip small danger"
                    disabled={disabled === true}
                    onClick={() => handleDelete(item)}
                  >
                    Yes
                  </button>{" "}
                  <button type="button" className="chip small" onClick={() => setConfirmDeleteId(null)}>
                    No
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="chip small vault-delete-btn"
                  disabled={disabled === true}
                  onClick={() => setConfirmDeleteId(item.id)}
                  title={`Delete ${item.name}`}
                >
                  Delete
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {/* ── 1Password sync section ────────────────────────────────── */}
      <div className="vault-sync-header">
        <button
          type="button"
          className="vault-sync-toggle-btn chip small"
          onClick={() =>
            setShowSync((v) => {
              if (v) {
                // Closing the section: wipe any parsed CSV rows + file
                // reference so passwords do not survive a collapsed-section
                // lifecycle.
                clearImportRowsAndFile();
                setImportDone(false);
              }
              return !v;
            })
          }
          aria-expanded={showSync}
        >
          {showSync ? "▾ 1Password Sync" : "▸ 1Password Sync"}
        </button>
        {sync?.enabled && (
          <span className="vault-badge-synced skill-badge" style={{ fontSize: "10px" }}>
            on
          </span>
        )}
        {sync?.lastSyncedAt && <span className="vault-sync-meta">synced {humanizeRelTime(sync.lastSyncedAt)}</span>}
      </div>

      {showSync && (
        <div className="vault-sync-form">
          {/* Show server-reported last error in red, via plain text content. */}
          {sync?.lastError && (
            <div className="skills-error vault-sync-error" role="alert">
              {sync.lastError}
            </div>
          )}

          <div className="vault-field">
            <label className="vault-label">
              <input
                type="checkbox"
                className="vault-sync-checkbox"
                checked={syncEnabled}
                disabled={disabled === true}
                onChange={(e) => setSyncEnabled(e.target.checked)}
              />{" "}
              Enable 1Password sync
            </label>
          </div>

          <div className="vault-field">
            <label className="vault-label" htmlFor="vault-sync-label">
              Account label
            </label>
            {/* datalist auto-completes from op-token items already in the vault. */}
            <input
              id="vault-sync-label"
              type="text"
              className="vault-input vault-mono"
              list="vault-op-labels"
              placeholder="e.g. MY_OP_TOKEN"
              value={syncOpLabel}
              disabled={disabled === true}
              onChange={(e) => setSyncOpLabel(e.target.value)}
            />
            <datalist id="vault-op-labels">
              {opLabels.map((label) => (
                <option key={label} value={label} />
              ))}
            </datalist>
          </div>

          <div className="vault-field">
            <label className="vault-label" htmlFor="vault-sync-vault">
              1Password vault name
            </label>
            <input
              id="vault-sync-vault"
              type="text"
              className="vault-input"
              placeholder="Luna"
              value={syncOpVault}
              disabled={disabled === true}
              onChange={(e) => setSyncOpVault(e.target.value)}
            />
            <p className="vault-warn-text">
              Create this vault in 1Password and grant your service account access — service accounts can't see
              Personal vaults.
            </p>
          </div>

          <div className="vault-field">
            <label className="vault-label" htmlFor="vault-sync-poll">
              Poll interval (seconds, min 60)
            </label>
            <input
              id="vault-sync-poll"
              type="number"
              className="vault-input"
              min={60}
              value={syncPollSeconds}
              disabled={disabled === true}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v)) setSyncPollSeconds(Math.max(60, v));
              }}
            />
          </div>

          <div className="vault-actions">
            <button type="button" className="chip" disabled={disabled === true || pending !== null} onClick={handleSyncSave}>
              {pending?.op === "sync" ? "Saving…" : "Save sync settings"}
            </button>
          </div>

          {/* ── Apple Passwords CSV import ────────────────────────── */}
          <div className="vault-import-section">
            <div className="vault-label vault-import-label">Apple Passwords CSV import</div>

            {syncEnabled ? (
              <>
                {!importDone && (
                  <>
                    {importRows.length === 0 && !importProgress && (
                      <>
                        <input
                          type="file"
                          accept=".csv"
                          className="vault-import-file"
                          disabled={disabled === true || pending !== null}
                          ref={fileInputRef}
                          onChange={handleFileChange}
                          aria-label="Choose Apple Passwords CSV export"
                        />
                        <p className="vault-warn-text">
                          Export from Apple Passwords: File → Export → CSV. Delete the file after import.
                        </p>
                      </>
                    )}

                    {importRows.length > 0 && !importProgress && (
                      // Preview: titles only — NEVER show usernames or passwords
                      <div className="vault-import-preview">
                        <div className="vault-import-count">
                          {importRows.length} password{importRows.length === 1 ? "" : "s"} ready to import
                        </div>
                        {importRows.length > LARGE_IMPORT_THRESHOLD && (
                          <div className="vault-warn-text">
                            Large import — 1Password limits writes to ~100/hour; the import may pause partway.
                          </div>
                        )}
                        <ul className="vault-import-titles">
                          {importRows.slice(0, 5).map((row, i) => (
                            <li key={i} className="vault-import-title-item">
                              {row.title}
                            </li>
                          ))}
                          {importRows.length > 5 && (
                            <li className="vault-import-title-item vault-import-more">
                              … and {importRows.length - 5} more
                            </li>
                          )}
                        </ul>
                        <div className="vault-actions">
                          <button
                            type="button"
                            className="chip"
                            disabled={disabled === true || pending !== null}
                            onClick={() => {
                              void runImport();
                            }}
                          >
                            Confirm import
                          </button>
                          <button type="button" className="chip small" onClick={clearImportState}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {importProgress && (
                      <div
                        className={
                          importProgress.startsWith("Import stopped") || importProgress.startsWith("Import aborted")
                            ? "skills-error"
                            : "vault-import-progress"
                        }
                        role="status"
                      >
                        {importProgress}
                      </div>
                    )}
                  </>
                )}

                {importDone && (
                  <div className="vault-import-done" role="status">
                    Done — you can delete the exported CSV file now.
                    <button
                      type="button"
                      className="chip small"
                      style={{ marginLeft: "8px" }}
                      onClick={() => setImportDone(false)}
                    >
                      Import another
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="vault-import-disabled-note">
                Enable 1Password sync above to import Apple Passwords.
                <button type="button" className="chip small" disabled style={{ marginLeft: "8px", opacity: 0.5 }}>
                  Choose file
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── add form ─────────────────────────────────────────────── */}
      {showAdd && (
        <div className="vault-add-form">
          <div className="vault-field">
            <label className="vault-label" htmlFor="vault-name">
              Name
            </label>
            <input
              id="vault-name"
              type="text"
              className="vault-input"
              placeholder="e.g. Notion API Key"
              value={name}
              disabled={disabled === true}
              maxLength={64}
              onChange={(e) => {
                setName(e.target.value);
                // Reset override preview when name changes if the user
                // hasn't explicitly touched it yet.
                if (!showVarOverride) setVarNameOverride(null);
              }}
            />
          </div>

          <div className="vault-field">
            <label className="vault-label" htmlFor="vault-kind">
              Kind
            </label>
            <select
              id="vault-kind"
              className="vault-input"
              value={kind}
              disabled={disabled === true}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="env-secret">API key / secret (default)</option>
              <option value="op-token">1Password service-account token</option>
            </select>
          </div>

          {kind === "env-secret" && (
            <div className="vault-field">
              <label className="vault-label">{showVarOverride ? "Env variable name" : "Env variable name (auto)"}</label>
              {!showVarOverride ? (
                <div className="vault-varname-row">
                  <code className="vault-varname-preview">{autoVarName || "…"}</code>
                  <button
                    type="button"
                    className="chip small"
                    onClick={() => {
                      setVarNameOverride(autoVarName);
                      setShowVarOverride(true);
                    }}
                  >
                    Override
                  </button>
                </div>
              ) : (
                <input
                  type="text"
                  className="vault-input vault-mono"
                  value={varNameOverride ?? autoVarName}
                  disabled={disabled === true}
                  onChange={(e) => setVarNameOverride(e.target.value)}
                />
              )}
            </div>
          )}

          {kind === "op-token" && (
            <div className="vault-field">
              <label className="vault-label" htmlFor="vault-label">
                Label
              </label>
              {/* Finding 1: op-token label uses its own dedicated state so the
                  typed value is preserved through validateForm and handleSubmit. */}
              <input
                id="vault-label"
                type="text"
                className="vault-input vault-mono"
                placeholder="e.g. MY_OP_TOKEN"
                value={opTokenLabel}
                disabled={disabled === true}
                onChange={(e) => setOpTokenLabel(e.target.value)}
              />
              <p className="vault-warn-text">Saving a 1Password token will restart the server.</p>
            </div>
          )}

          <div className="vault-field">
            <label className="vault-label" htmlFor="vault-value">
              Secret value
            </label>
            <input
              id="vault-value"
              type="password"
              className="vault-input"
              placeholder="Paste your secret here"
              disabled={disabled === true}
              ref={valueInputRef}
              autoComplete="new-password"
            />
          </div>

          <div className="vault-field">
            <label className="vault-label" htmlFor="vault-note">
              Note (optional)
            </label>
            <input
              id="vault-note"
              type="text"
              className="vault-input"
              placeholder="Short description"
              value={note}
              disabled={disabled === true}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <div className="vault-actions">
            {/* Finding 6: Save shows "Saving..." only for a put in-flight (not delete). */}
            <button type="button" disabled={disabled === true || pending !== null} onClick={handleSubmit}>
              {pending?.op === "put" ? "Saving…" : "Save credential"}
            </button>
            <button type="button" className="chip" onClick={closeAdd}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default VaultPanel;
