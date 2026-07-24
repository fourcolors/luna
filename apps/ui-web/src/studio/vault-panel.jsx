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
//
// Astryx conversion notes (single-file scope):
// - Kind/1P-synced/shadowed pills -> Astryx Badge. Kept the original
//   `skill-badge`/`vault-kind-*`/`vault-badge-*` classNames on each Badge so
//   the existing theme-aware color overrides in devops-panels.css keep
//   applying verbatim: Luna's CSS loads unlayered while Astryx's own rules
//   live in `@layer astryx-base` (main.tsx), so the shared classNames still
//   win the cascade over Badge's default variant chrome.
// - Delete confirm / row delete / header "+ Add" / add-form Save+Cancel /
//   sync-form Save / CSV import Confirm+Cancel+"Import another" -> Astryx
//   Button, using its own variant system (primary/secondary/ghost/
//   destructive) rather than the old `chip`/`chip small`/`danger` classes -
//   matching the precedent set by the already-converted connectors-panel.jsx
//   (those shared chip classes stay defined in devops-panels.css for the
//   not-yet-converted skills-panel.jsx sibling).
// - Kind select -> Astryx Selector (single-select, no clear).
// - Env-var-override / op-token label / name / note text fields -> Astryx
//   TextInput. Poll-interval -> Astryx NumberInput (its onChange only fires
//   already-validated numbers, so the old manual parseInt/isNaN/clamp
//   handler collapses to a plain `Math.max(60, v)`). Enable-sync toggle ->
//   Astryx CheckboxInput. CSV file picker -> Astryx FileInput (compact
//   `mode="input"`), which is *controlled* by a File object instead of an
//   uncontrolled DOM ref, so the file-reset dance that used to go through
//   `fileInputRef.current.value = ""` is now just `setPickedFile(null)`.
// - The 1Password Sync section -> Astryx Collapsible (controlled `isOpen`),
//   which gives real aria-expanded/aria-controls disclosure semantics for
//   free - a clean parity target flagged in the porting recon, since the
//   original toggle already carried `aria-expanded` by hand. The "on" badge
//   and "synced Xm ago" meta move into the `trigger` node (Collapsible's
//   trigger area is always visible, matching the original layout), and the
//   existing `.vault-sync-form` bordered-card div is kept nested *inside*
//   Collapsible's content slot so the card chrome (border/radius/padding/
//   background) is unaffected by the swap.
// - SECURITY (do not "fix" this): the credential-value password field stays
//   a plain native `<input type="password">` read via `valueInputRef`, NOT
//   an Astryx TextInput. TextInputProps has no uncontrolled/defaultValue
//   mode - `value`/`onChange` are mandatory and the value is mirrored into
//   an internal `useOptimistic` - so swapping it in would lift the raw
//   secret into React state/devtools and silently break the one-shot-wipe
//   contract documented at the top of this file. Same reasoning kept the
//   CSV row `password` values (parseAppleCsv output) out of any Astryx
//   input: they're rendered nowhere and never touch a controlled field.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, CheckboxInput, Collapsible, FileInput, NumberInput, Selector, TextInput } from "./astryx-kit.tsx";

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
  // Astryx FileInput is a controlled component (File | File[] | null), so the
  // picked file lives here instead of behind an uncontrolled `fileInputRef`.
  // It never carries a secret (only CSV title/username/password rows parsed
  // out of it do, and those stay in `importRows`, wiped the same as before).
  const [pickedFile, setPickedFile] = useState(null);

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
        setPickedFile(null);
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

  function handleFileChange(file) {
    // FileInput's onChange fires with `null` on a cleared/removed selection.
    if (!file) {
      setPickedFile(null);
      return;
    }
    setPickedFile(file);
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
   * picker after send/abort. Does NOT touch importDone so the "Done" message
   * stays visible until the user explicitly dismisses it.
   */
  function clearImportRowsAndFile() {
    setImportRows([]);
    setImportProgress(null);
    setPickedFile(null);
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
          <Button
            label="+ Add"
            variant="secondary"
            size="sm"
            isDisabled={disabled === true}
            clickAction={() => {
              setStatusMsg(null);
              setShowAdd(true);
            }}
          />
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
                  <Badge className={`skill-badge vault-kind-${item.kind}`} variant="neutral" label={kindLabel(item.kind)} />
                  {item.synced && (
                    <Badge
                      className="skill-badge vault-badge-synced"
                      variant="neutral"
                      label="1P"
                      title="Confirmed in 1Password"
                    />
                  )}
                  {item.shadowed && (
                    <Badge
                      className="skill-badge vault-badge-shadowed"
                      variant="neutral"
                      label="shadowed"
                      title="Defined by the server's environment — edits here won't take effect"
                    />
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
                  <Button
                    label="Yes"
                    variant="destructive"
                    size="sm"
                    isDisabled={disabled === true}
                    clickAction={() => handleDelete(item)}
                  />{" "}
                  <Button label="No" variant="ghost" size="sm" clickAction={() => setConfirmDeleteId(null)} />
                </span>
              ) : (
                <Button
                  label="Delete"
                  variant="destructive"
                  size="sm"
                  className="vault-delete-btn"
                  isDisabled={disabled === true}
                  clickAction={() => setConfirmDeleteId(item.id)}
                  tooltip={`Delete ${item.name}`}
                />
              )}
            </div>
          ))
        )}
      </div>

      {/* ── 1Password sync section ────────────────────────────────── */}
      <Collapsible
        trigger={
          <span className="vault-sync-header">
            <span className="vault-sync-toggle-btn">1Password Sync</span>
            {sync?.enabled && (
              <span className="vault-badge-synced skill-badge" style={{ fontSize: "10px" }}>
                on
              </span>
            )}
            {sync?.lastSyncedAt && (
              <span className="vault-sync-meta">synced {humanizeRelTime(sync.lastSyncedAt)}</span>
            )}
          </span>
        }
        isOpen={showSync}
        onOpenChange={(next) => {
          if (!next) {
            // Closing the section: wipe any parsed CSV rows + file selection
            // so passwords do not survive a collapsed-section lifecycle.
            clearImportRowsAndFile();
            setImportDone(false);
          }
          setShowSync(next);
        }}
      >
        <div className="vault-sync-form">
          {/* Show server-reported last error in red, via plain text content. */}
          {sync?.lastError && (
            <div className="skills-error vault-sync-error" role="alert">
              {sync.lastError}
            </div>
          )}

          <div className="vault-field">
            <CheckboxInput
              label="Enable 1Password sync"
              size="sm"
              value={syncEnabled}
              isDisabled={disabled === true}
              onChange={setSyncEnabled}
            />
          </div>

          <div className="vault-field">
            {/* datalist auto-completes from op-token items already in the vault.
                `list` isn't a named TextInput prop but passes straight through
                to the underlying native <input> via its `...rest` spread. */}
            <TextInput
              label="Account label"
              className="vault-mono"
              list="vault-op-labels"
              placeholder="e.g. MY_OP_TOKEN"
              value={syncOpLabel}
              isDisabled={disabled === true}
              onChange={setSyncOpLabel}
            />
            <datalist id="vault-op-labels">
              {opLabels.map((label) => (
                <option key={label} value={label} />
              ))}
            </datalist>
          </div>

          <div className="vault-field">
            <TextInput
              label="1Password vault name"
              placeholder="Luna"
              value={syncOpVault}
              isDisabled={disabled === true}
              onChange={setSyncOpVault}
            />
            <p className="vault-warn-text">
              Create this vault in 1Password and grant your service account access — service accounts can't see
              Personal vaults.
            </p>
          </div>

          <div className="vault-field">
            <NumberInput
              label="Poll interval (seconds, min 60)"
              value={syncPollSeconds}
              min={60}
              isDisabled={disabled === true}
              onChange={(v) => setSyncPollSeconds(Math.max(60, v))}
            />
          </div>

          <div className="vault-actions">
            <Button
              label={pending?.op === "sync" ? "Saving…" : "Save sync settings"}
              variant="primary"
              isDisabled={disabled === true || pending !== null}
              clickAction={handleSyncSave}
            />
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
                        <FileInput
                          label="Choose Apple Passwords CSV export"
                          isLabelHidden
                          mode="input"
                          accept=".csv"
                          className="vault-import-file"
                          isDisabled={disabled === true || pending !== null}
                          value={pickedFile}
                          onChange={handleFileChange}
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
                          <Button
                            label="Confirm import"
                            variant="primary"
                            isDisabled={disabled === true || pending !== null}
                            clickAction={() => {
                              void runImport();
                            }}
                          />
                          <Button label="Cancel" variant="ghost" size="sm" clickAction={clearImportState} />
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
                    <Button
                      label="Import another"
                      variant="ghost"
                      size="sm"
                      style={{ marginLeft: "8px" }}
                      clickAction={() => setImportDone(false)}
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="vault-import-disabled-note">
                Enable 1Password sync above to import Apple Passwords.
                <Button
                  label="Choose file"
                  variant="ghost"
                  size="sm"
                  isDisabled
                  style={{ marginLeft: "8px", opacity: 0.5 }}
                />
              </div>
            )}
          </div>
        </div>
      </Collapsible>

      {/* ── add form ─────────────────────────────────────────────── */}
      {showAdd && (
        <div className="vault-add-form">
          <div className="vault-field">
            <TextInput
              label="Name"
              placeholder="e.g. Notion API Key"
              value={name}
              isDisabled={disabled === true}
              maxLength={64}
              onChange={(v) => {
                setName(v);
                // Reset override preview when name changes if the user
                // hasn't explicitly touched it yet.
                if (!showVarOverride) setVarNameOverride(null);
              }}
            />
          </div>

          <div className="vault-field">
            <Selector
              label="Kind"
              options={[
                { value: "env-secret", label: "API key / secret (default)" },
                { value: "op-token", label: "1Password service-account token" },
              ]}
              value={kind}
              isDisabled={disabled === true}
              onChange={setKind}
            />
          </div>

          {kind === "env-secret" && (
            <div className="vault-field">
              <label className="vault-label">{showVarOverride ? "Env variable name" : "Env variable name (auto)"}</label>
              {!showVarOverride ? (
                <div className="vault-varname-row">
                  <code className="vault-varname-preview">{autoVarName || "…"}</code>
                  <Button
                    label="Override"
                    variant="ghost"
                    size="sm"
                    clickAction={() => {
                      setVarNameOverride(autoVarName);
                      setShowVarOverride(true);
                    }}
                  />
                </div>
              ) : (
                <TextInput
                  label="Env variable name"
                  isLabelHidden
                  className="vault-mono"
                  value={varNameOverride ?? autoVarName}
                  isDisabled={disabled === true}
                  onChange={setVarNameOverride}
                />
              )}
            </div>
          )}

          {kind === "op-token" && (
            <div className="vault-field">
              {/* Finding 1: op-token label uses its own dedicated state so the
                  typed value is preserved through validateForm and handleSubmit. */}
              <TextInput
                label="Label"
                className="vault-mono"
                placeholder="e.g. MY_OP_TOKEN"
                value={opTokenLabel}
                isDisabled={disabled === true}
                onChange={setOpTokenLabel}
              />
              <p className="vault-warn-text">Saving a 1Password token will restart the server.</p>
            </div>
          )}

          <div className="vault-field">
            {/* SECURITY: stays a plain uncontrolled native input - see the
                Astryx-conversion notes at the top of this file for why
                TextInput cannot be used here without breaking the one-shot
                secret-wipe contract. */}
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
            <TextInput
              label="Note (optional)"
              placeholder="Short description"
              value={note}
              isDisabled={disabled === true}
              onChange={setNote}
            />
          </div>

          <div className="vault-actions">
            {/* Finding 6: Save shows "Saving..." only for a put in-flight (not delete). */}
            <Button
              label={pending?.op === "put" ? "Saving…" : "Save credential"}
              variant="primary"
              isDisabled={disabled === true || pending !== null}
              clickAction={handleSubmit}
            />
            <Button label="Cancel" variant="ghost" clickAction={closeAdd} />
          </div>
        </div>
      )}
    </div>
  );
}

export default VaultPanel;
