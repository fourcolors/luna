/**
 * VaultPanel — the Vault settings section for the WEB client.
 *
 * Renders the credential registry: list (name, kind badge, ref mono,
 * source, synced/shadowed badges, inline-confirm delete) + an add form
 * (name, kind select, auto-derived var name with advanced override, value
 * password input, optional note). Gated on capabilities.vault in App.tsx.
 *
 * Slice V3 additions:
 *   - 1Password sync section: enable toggle, account-label picker,
 *     vault-name input, poll-interval, last-synced/error status.
 *   - Apple Passwords CSV import: file → RFC-4180 parse → preview (titles
 *     only, NEVER passwords) → sequential chunk sends with per-chunk acks.
 *
 * Security contract:
 *   - The credential value lives ONLY in the type=password input.
 *   - It is wiped one-shot on submit, cancel, panel close, and disconnect.
 *   - CSV row passwords are held in memory only, cleared after send or abort.
 *   - NEVER stored in localStorage, NEVER logged, NEVER rendered back.
 *   - Server-sent strings rendered via Solid text interpolation (textContent),
 *     never via innerHTML.
 *   - vault-sync-config and vault-import sends use the OPEN-socket guard
 *     (caller's `disabled` prop gates the UI; sends only happen when enabled).
 *
 * Status acks: vault-status frames are NOT stored in the reducer (the
 * reducer returns `state` unchanged so the fresh vault-list that follows a
 * successful mutation already updates the list). App.tsx intercepts them
 * via `onVaultStatus` callback and passes the ack result here as a prop.
 */
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Component,
} from "solid-js"
import type { VaultWireItem, VaultSyncWire } from "@luna/ui-shared"

export interface VaultStatusAck {
  readonly requestId: string
  readonly ok: boolean
  readonly message: string
}

export interface VaultPanelProps {
  /** Registry rows from the latest vault-list frame. */
  readonly items: ReadonlyArray<VaultWireItem>
  /** 1Password sync state (slice V3); null = not yet received. */
  readonly sync: VaultSyncWire | null
  /** Called with a vault-put frame payload to send to the server. */
  readonly onPut: (params: {
    requestId: string
    name: string
    kind: "env-secret" | "op-token"
    varName?: string
    label?: string
    value: string
    description?: string
  }) => void
  /** Called with a vault-delete frame payload to send to the server. */
  readonly onDelete: (params: { requestId: string; id: string }) => void
  /** Called with a vault-sync-config frame payload. */
  readonly onSyncConfig?: (params: {
    requestId: string
    enabled: boolean
    opLabel?: string
    opVault?: string
    pollSeconds?: number
  }) => void
  /** Called with a vault-import frame payload (one chunk, IMPORT_CHUNK_SIZE items, protocol cap 20). */
  readonly onImport?: (params: {
    requestId: string
    items: ReadonlyArray<{
      title: string
      url?: string
      username?: string
      password: string
      notes?: string
    }>
  }) => void
  /** The most recent vault-status ack. The panel correlates by requestId. */
  readonly lastStatus: VaultStatusAck | null
  /** When false, disable mutating actions (transport not open). */
  readonly disabled?: boolean
}

/** Derive an env-var name from a human-readable credential name.
 *  "Notion API Key" → "NOTION_API_KEY"
 *  Strips non-word characters, uppercases, collapses repeated underscores. */
const deriveVarName = (name: string): string =>
  name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const kindLabel = (kind: VaultWireItem["kind"]): string => {
  if (kind === "env-secret") return "env"
  if (kind === "op-token") return "op-token"
  return "op-item"
}

const sourceLabel = (source: VaultWireItem["source"]): string => {
  if (source === "manual") return "manual"
  if (source === "agent") return "agent"
  if (source === "1password") return "1P"
  return "import"
}

/** Safe UUID generation: crypto.randomUUID() is secure-context-only and
 *  undefined over plain http from a non-localhost host. Fall back to a
 *  Date+Math.random combination (not cryptographically strong, but fine
 *  for correlation IDs that never leave the session). */
const newReqId = () =>
  "vlt_" +
  (globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}_${Math.random().toString(36).slice(2)}`)

/**
 * humanizeRelTime — convert a unix-ms timestamp to a short human-readable
 * relative string ("just now", "3 minutes ago", "2 hours ago", "5 days ago").
 * Pure function so it is easy to test.
 */
export const humanizeRelTime = (ts: number, nowMs = Date.now()): string => {
  const diffSec = Math.floor((nowMs - ts) / 1000)
  if (diffSec < 60) return "just now"
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`
  const diffDay = Math.floor(diffHour / 24)
  return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`
}

// ── RFC-4180 CSV parser ────────────────────────────────────────────────────

/**
 * A parsed row from an Apple Passwords CSV export.
 * `OTPAuth` is ignored by design (we never handle TOTP seeds).
 */
export interface AppleCsvRow {
  title: string
  url: string
  username: string
  password: string
  notes: string
}

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
 */
export function parseAppleCsv(raw: string): AppleCsvRow[] {
  // Strip a leading UTF-8 BOM (U+FEFF) if present — Excel and some macOS
  // exporters prepend it; it would corrupt the first header column name.
  const input = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  // Split the raw text into RFC-4180 cells. We use a state-machine parser
  // that correctly handles quoted fields containing commas and newlines.
  const records = tokenizeCsv(input)
  if (records.length < 2) return []

  // Build a case-insensitive column index from the header row.
  const headers = records[0]!.map((h) => h.trim().toLowerCase())
  const idx = (name: string): number => headers.indexOf(name)

  const colTitle = idx("title")
  const colUrl = idx("url")
  const colUsername = idx("username")
  const colPassword = idx("password")
  const colNotes = idx("notes")

  // Must have at minimum a title and a password column to produce useful rows.
  if (colTitle === -1 || colPassword === -1) return []

  const results: AppleCsvRow[] = []
  for (let i = 1; i < records.length; i++) {
    const row = records[i]!
    // Trim all columns except password — password may legitimately have leading
    // or trailing spaces and must be preserved exactly as the user stored it.
    const getColTrimmed = (col: number): string =>
      col !== -1 && col < row.length ? (row[col] ?? "").trim() : ""
    const getColRaw = (col: number): string =>
      col !== -1 && col < row.length ? (row[col] ?? "") : ""

    const title = getColTrimmed(colTitle)
    const password = getColRaw(colPassword)
    // Drop rows with no title, or where the password is empty (after trim).
    if (!title || password.trim() === "") continue

    results.push({
      title,
      url: getColTrimmed(colUrl),
      username: getColTrimmed(colUsername),
      password,  // raw — preserve spaces
      notes: getColTrimmed(colNotes),
    })
  }
  return results
}

/**
 * tokenizeCsv — low-level RFC-4180 tokenizer. Returns an array of rows,
 * each row being an array of field strings (unescaped).
 */
function tokenizeCsv(raw: string): string[][] {
  const records: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuote = false
  let i = 0

  while (i < raw.length) {
    const ch = raw[i]!

    if (inQuote) {
      if (ch === '"') {
        // Peek at next char: "" → escaped quote; otherwise end of quoted field.
        if (raw[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuote = false
          i++
        }
      } else {
        field += ch
        i++
      }
    } else {
      if (ch === '"') {
        inQuote = true
        i++
      } else if (ch === ',') {
        row.push(field)
        field = ""
        i++
      } else if (ch === '\r') {
        // CRLF: skip the \r; the \n will be the row terminator
        i++
      } else if (ch === '\n') {
        row.push(field)
        field = ""
        records.push(row)
        row = []
        i++
      } else {
        field += ch
        i++
      }
    }
  }

  // Flush the last field/row (no trailing newline case).
  if (field !== "" || row.length > 0) {
    row.push(field)
    if (row.some((f) => f !== "")) {
      records.push(row)
    }
  }

  return records
}

// ── Component ──────────────────────────────────────────────────────────────

/** Derive op-token labels from vault items (kind='op-token', ref='luna-op://<label>'). */
const extractOpLabels = (items: ReadonlyArray<VaultWireItem>): string[] => {
  const labels: string[] = []
  for (const item of items) {
    if (item.kind === "op-token" && item.ref.startsWith("luna-op://")) {
      const label = item.ref.slice("luna-op://".length).split("/")[0]
      if (label) labels.push(label)
    }
  }
  return labels
}

// Each chunk item requires one `op item create` CLI call + a network round-trip
// to 1Password. At ~5 items/chunk the per-chunk wall-clock time stays well under
// CHUNK_ACK_TIMEOUT_MS even on a slow connection, avoiding false timeouts that
// would cause duplicate items on retry.
const IMPORT_CHUNK_SIZE = 5
const CHUNK_ACK_TIMEOUT_MS = 120_000  // 2 minutes per chunk; each item ≈ one op CLI + roundtrip
const LARGE_IMPORT_THRESHOLD = 80

export const VaultPanel: Component<VaultPanelProps> = (props) => {
  // ── add form state ───────────────────────────────────────────────────
  const [showAdd, setShowAdd] = createSignal(false)
  const [name, setName] = createSignal("")
  const [kind, setKind] = createSignal<"env-secret" | "op-token">("env-secret")
  const [varNameOverride, setVarNameOverride] = createSignal<string | null>(null)
  const [showVarOverride, setShowVarOverride] = createSignal(false)
  // Finding 1: op-token has its own label signal so the typed value is used
  // directly in validateForm and handleSubmit instead of the env-var path.
  const [opTokenLabel, setOpTokenLabel] = createSignal("")
  // Mutable ref — the password input value is managed via DOM ref, not
  // a tracked signal, so it never appears in any reactive log/snapshot.
  let valueInputRef: HTMLInputElement | undefined

  // Finding 7: explicit cleanup of the value input on unmount/close.
  onCleanup(() => {
    if (valueInputRef) valueInputRef.value = ""
    // Wipe any in-memory CSV rows on unmount.
    setImportRows([])
  })

  const [note, setNote] = createSignal("")

  // ── in-flight request tracking ───────────────────────────────────────
  // Finding 6: track op + id together so delete-ok never resets the add form
  // and Save only shows "Saving…" when a put is in flight.
  const [pending, setPending] = createSignal<{
    id: string
    op: "put" | "delete" | "sync" | "import"
  } | null>(null)
  const [statusMsg, setStatusMsg] = createSignal<{ ok: boolean; text: string } | null>(null)

  // ── delete confirm ───────────────────────────────────────────────────
  const [confirmDeleteId, setConfirmDeleteId] = createSignal<string | null>(null)

  // ── sync section state ───────────────────────────────────────────────
  const [showSync, setShowSync] = createSignal(false)
  const [syncEnabled, setSyncEnabled] = createSignal(false)
  const [syncOpLabel, setSyncOpLabel] = createSignal("")
  const [syncOpVault, setSyncOpVault] = createSignal("Luna")
  const [syncPollSeconds, setSyncPollSeconds] = createSignal(300)

  // Seed flag: set to true on first non-null props.sync delivery, then only
  // re-seeded after a successful sync-save ack (so a saved state reflects).
  // Prevents in-progress edits from being clobbered by a background vault-list
  // broadcast while the sync section is open and dirty.
  const [syncSeeded, setSyncSeeded] = createSignal(false)

  // Keep sync form fields seeded from the first non-null props.sync; re-seed
  // after a successful sync-save ack so saved state reflects. Never re-seeds
  // while the section is open and the user may have unsaved edits.
  //
  // Important: syncSeeded() is read via untrack() so the effect only re-runs
  // on props.sync changes, NOT on syncSeeded changes. Without untrack, calling
  // setSyncSeeded(false) from the ack correlator would immediately re-trigger
  // this effect with the OLD props.sync value (stale seed). With untrack we
  // just "peek" at the flag — it gates the seed but doesn't subscribe to it.
  // The next props.sync delivery (from the server's updated vault-list) then
  // finds syncSeeded===false and correctly re-seeds with the fresh server state.
  createEffect(() => {
    const s = props.sync               // tracked: re-runs on each new sync delivery
    if (s === null) return
    if (untrack(syncSeeded)) return    // peek — NOT tracked; no re-run on syncSeeded changes
    setSyncEnabled(s.enabled)
    if (s.opLabel) setSyncOpLabel(s.opLabel)
    if (s.opVault) setSyncOpVault(s.opVault)
    setSyncPollSeconds(Math.max(60, s.pollSeconds))
    setSyncSeeded(true)
  })

  // ── CSV import state ─────────────────────────────────────────────────
  // Security: rows array in memory only — cleared after send / abort / unmount.
  const [importRows, setImportRows] = createSignal<AppleCsvRow[]>([])
  const [importProgress, setImportProgress] = createSignal<string | null>(null)
  const [importDone, setImportDone] = createSignal(false)
  let fileInputRef: HTMLInputElement | undefined

  const opLabels = createMemo(() => extractOpLabels(props.items))

  // Correlate incoming vault-status acks with our pending request.
  createEffect(() => {
    const ack = props.lastStatus
    if (!ack) return
    const p = pending()
    if (!p || ack.requestId !== p.id) return
    setStatusMsg({ ok: ack.ok, text: ack.message })
    // Finding 6: only reset the add form when it was a put that succeeded.
    if (ack.ok && p.op === "put") {
      resetForm()
    }
    // Sync-save ack: allow re-seed on the next props.sync delivery so the
    // saved state (e.g. corrected pollSeconds from the server) reflects.
    if (ack.ok && p.op === "sync") {
      setSyncSeeded(false)
    }
    // For sync config: show ack but do not close the section.
    // For import: handled in the sequential importer (resolveAck below).
    if (p.op !== "import") {
      setPending(null)
    }
  })

  // Finding 3: when disabled transitions true (socket drop / op-token restart)
  // clear any lingering pendingId and show a neutral connection-lost message.
  createEffect(() => {
    if (props.disabled) {
      const p = pending()
      if (p !== null) {
        setPending(null)
        setStatusMsg({
          ok: false,
          text: "Connection lost — check the list after reconnecting.",
        })
      }
      if (valueInputRef) valueInputRef.value = ""
      // Wipe in-memory import rows on disconnect (inlined to avoid TDZ).
      if (importRows().length > 0) {
        setImportRows([])
        setImportProgress(null)
        if (fileInputRef) fileInputRef.value = ""
      }
    }
  })

  const autoVarName = createMemo(() => deriveVarName(name()))
  const effectiveVarName = createMemo(() =>
    showVarOverride() && varNameOverride() !== null
      ? varNameOverride()!
      : autoVarName(),
  )

  /** Wipe secret value and reset all form state. */
  const resetForm = () => {
    if (valueInputRef) valueInputRef.value = ""
    setName("")
    setKind("env-secret")
    setVarNameOverride(null)
    setShowVarOverride(false)
    setOpTokenLabel("")
    setNote("")
  }

  const closeAdd = () => {
    // Finding 3: abandoning the form while a put is in-flight clears pendingId.
    setPending(null)
    resetForm()
    setShowAdd(false)
    setStatusMsg(null)
  }

  const validateForm = (): string | null => {
    const n = name().trim()
    if (n.length === 0) return "Name is required."
    if (n.length > 64) return "Name must be 64 characters or fewer."
    if (kind() === "env-secret") {
      // Finding 1: env-secret path unchanged — uses effectiveVarName.
      const vn = effectiveVarName()
      if (!vn || !VAR_RE.test(vn)) {
        return "Variable name must start with a letter or underscore and contain only letters, numbers, and underscores."
      }
    } else {
      // Finding 1: op-token uses its own label signal, not effectiveVarName.
      const lbl = opTokenLabel().trim()
      if (!lbl || !VAR_RE.test(lbl)) {
        return "Label must start with a letter or underscore and contain only letters, numbers, and underscores."
      }
    }
    const val = valueInputRef?.value ?? ""
    if (val.length === 0) return "Secret value is required."
    if (kind() === "env-secret" && val.includes("\n")) {
      return "Secret value for an API key/secret must not contain newlines."
    }
    return null
  }

  const handleSubmit = () => {
    const err = validateForm()
    if (err) {
      setStatusMsg({ ok: false, text: err })
      return
    }
    const val = valueInputRef!.value
    // Finding 4: use safe newReqId() instead of bare crypto.randomUUID().
    const reqId = newReqId()
    const trimmedName = name().trim()
    const desc = note().trim()

    // Wipe the input immediately after reading — one-shot.
    // NOTE (finding 8): transport.ts sendBuffer retains secret-bearing frames
    // on a dead socket handle; this is accepted V1 behavior — the secret has
    // already left the DOM and the send is best-effort.
    valueInputRef!.value = ""

    setStatusMsg(null)
    // Finding 6: mark as put so delete-ok never inadvertently resets the form.
    setPending({ id: reqId, op: "put" })

    if (kind() === "env-secret") {
      props.onPut({
        requestId: reqId,
        name: trimmedName,
        kind: "env-secret",
        varName: effectiveVarName(),
        value: val,
        ...(desc ? { description: desc } : {}),
      })
    } else {
      // Finding 1: op-token carries the explicitly typed label, not effectiveVarName.
      props.onPut({
        requestId: reqId,
        name: trimmedName,
        kind: "op-token",
        label: opTokenLabel().trim(),
        value: val,
        ...(desc ? { description: desc } : {}),
      })
    }
  }

  const handleDelete = (item: VaultWireItem) => {
    // Finding 4: use safe newReqId() instead of bare crypto.randomUUID().
    const reqId = newReqId()
    setConfirmDeleteId(null)
    setStatusMsg(null)
    // Finding 6: mark as delete so a delete-ok never resets the add form.
    setPending({ id: reqId, op: "delete" })
    props.onDelete({ requestId: reqId, id: item.id })
  }

  // ── sync config save ─────────────────────────────────────────────────

  const handleSyncSave = () => {
    if (!props.onSyncConfig || props.disabled) return
    const reqId = newReqId()
    setPending({ id: reqId, op: "sync" })
    setStatusMsg(null)
    const label = syncOpLabel().trim()
    const vault = syncOpVault().trim()
    props.onSyncConfig({
      requestId: reqId,
      enabled: syncEnabled(),
      ...(label ? { opLabel: label } : {}),
      ...(vault ? { opVault: vault } : {}),
      pollSeconds: syncPollSeconds(),
    })
  }

  // ── CSV import ───────────────────────────────────────────────────────

  const handleFileChange = (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = reader.result as string
      const rows = parseAppleCsv(text)
      setImportRows(rows)
      setImportProgress(null)
      setImportDone(false)
    }
    reader.readAsText(file)
  }

  /**
   * clearImportRowsAndFile — wipes the in-memory CSV rows and resets the file
   * input after send/abort. Does NOT touch importDone so the "Done" message
   * stays visible until the user explicitly dismisses it.
   */
  const clearImportRowsAndFile = () => {
    setImportRows([])
    setImportProgress(null)
    if (fileInputRef) fileInputRef.value = ""
  }

  const clearImportState = () => {
    clearImportRowsAndFile()
    setImportDone(false)
  }

  /**
   * runImport — sequential chunk sender.
   * Sends IMPORT_CHUNK_SIZE rows at a time (protocol cap is 20); waits for each
   * vault-status ack before the next.
   * On a failed chunk: stops and shows the server message + count so far.
   */
  const runImport = async () => {
    if (!props.onImport || props.disabled) return
    const rows = importRows()
    if (rows.length === 0) return

    let sent = 0
    const total = rows.length

    for (let start = 0; start < total; start += IMPORT_CHUNK_SIZE) {
      if (props.disabled) {
        clearImportRowsAndFile()  // wipe in-memory passwords FIRST (mirrors failed-chunk branch)
        setImportProgress("Import aborted — connection lost.")
        return
      }

      const chunk = rows.slice(start, start + IMPORT_CHUNK_SIZE)
      const reqId = newReqId()

      // We need to await an ack for THIS reqId before the next chunk.
      // We do this by registering a one-shot promise that resolves when
      // lastStatus carries our reqId.
      const ackPromise = new Promise<VaultStatusAck>((resolve) => {
        // Poll via a reactive effect — createEffect is synchronous/tracking.
        // We use a simple interval-poll instead to avoid cross-effect entanglement.
        const checkInterval = setInterval(() => {
          const ack = props.lastStatus
          if (ack && ack.requestId === reqId) {
            clearInterval(checkInterval)
            clearTimeout(safetyTimer)  // cancel the safety timer — no dangling timer
            resolve(ack)
          }
        }, 50)
        // Safety timeout: cleared above when the ack arrives so no dangling timer.
        // CHUNK_ACK_TIMEOUT_MS is generous (2 min per chunk) — each item is one
        // op CLI call + network roundtrip, so 5 items/chunk clears it easily.
        const safetyTimer = setTimeout(() => {
          clearInterval(checkInterval)
          resolve({ requestId: reqId, ok: false, message: "Timed out waiting for server acknowledgement." })
        }, CHUNK_ACK_TIMEOUT_MS)
      })

      setPending({ id: reqId, op: "import" })
      setImportProgress(`Importing… ${sent} of ${total} done`)

      props.onImport({
        requestId: reqId,
        items: chunk.map((r) => ({
          title: r.title,
          ...(r.url ? { url: r.url } : {}),
          ...(r.username ? { username: r.username } : {}),
          password: r.password,
          ...(r.notes ? { notes: r.notes } : {}),
        })),
      })

      const ack = await ackPromise
      setPending(null)

      if (!ack.ok) {
        // Security: wipe in-memory passwords after failure first,
        // then set the error message (clearImportRowsAndFile clears progress).
        clearImportRowsAndFile()
        setImportProgress(
          `Import stopped after ${sent} of ${total} — server said: ${ack.message}`,
        )
        return
      }

      sent += chunk.length
      setImportProgress(`Imported ${sent} of ${total}…`)
    }

    // All chunks sent successfully.
    setImportProgress(null)
    // Security: wipe in-memory passwords immediately.
    clearImportRowsAndFile()
    // Show "Done" message (stays until user clicks "Import another").
    setImportDone(true)
  }

  return (
    <div class="skills-panel vault-panel">
      <div class="skills-head">
        <span class="skills-title">Vault</span>
        <span class="skills-count">{props.items.length} stored</span>
        <Show when={!showAdd()}>
          <button
            type="button"
            class="chip small"
            disabled={props.disabled === true}
            onClick={() => {
              setStatusMsg(null)
              setShowAdd(true)
            }}
          >
            + Add
          </button>
        </Show>
      </div>

      <Show when={statusMsg()}>
        {(msg) => (
          <div
            class={msg().ok ? "vault-status-ok" : "skills-error"}
            role={msg().ok ? "status" : "alert"}
          >
            {msg().text}
          </div>
        )}
      </Show>

      {/* ── list ─────────────────────────────────────────────────── */}
      <div class="skills-list vault-list">
        <For each={props.items} fallback={<div class="skills-empty">No credentials stored yet.</div>}>
          {(item) => (
            <div class="skill-row vault-row">
              <div class="skill-meta">
                <span class="skill-name">
                  {item.name}
                  <span class={`skill-badge vault-kind-${item.kind}`}>
                    {kindLabel(item.kind)}
                  </span>
                  <Show when={item.synced}>
                    <span class="skill-badge vault-badge-synced" title="Confirmed in 1Password">
                      1P
                    </span>
                  </Show>
                  <Show when={item.shadowed}>
                    <span
                      class="skill-badge vault-badge-shadowed"
                      title="Defined by the server's environment — edits here won't take effect"
                    >
                      shadowed
                    </span>
                  </Show>
                </span>
                <span class="skill-desc">
                  <code class="vault-ref">{item.ref}</code>
                  {" · "}
                  {sourceLabel(item.source)}
                  <Show when={item.description}>
                    {" · "}
                    {item.description}
                  </Show>
                </span>
              </div>
              <Show
                when={confirmDeleteId() === item.id}
                fallback={
                  <button
                    type="button"
                    class="chip small vault-delete-btn"
                    disabled={props.disabled === true}
                    onClick={() => setConfirmDeleteId(item.id)}
                    title={`Delete ${item.name}`}
                  >
                    Delete
                  </button>
                }
              >
                {/* Finding 5: warn about server restart when deleting an op-token. */}
                <span class="vault-confirm-prompt">
                  {item.kind === "op-token"
                    ? "Delete? This will restart the server. "
                    : "Delete? "}
                  <button
                    type="button"
                    class="chip small danger"
                    disabled={props.disabled === true}
                    onClick={() => handleDelete(item)}
                  >
                    Yes
                  </button>{" "}
                  <button
                    type="button"
                    class="chip small"
                    onClick={() => setConfirmDeleteId(null)}
                  >
                    No
                  </button>
                </span>
              </Show>
            </div>
          )}
        </For>
      </div>

      {/* ── 1Password sync section ────────────────────────────────── */}
      <div class="vault-sync-header">
        <button
          type="button"
          class="vault-sync-toggle-btn chip small"
          onClick={() =>
            setShowSync((v) => {
              if (v) {
                // Closing the section: wipe any parsed CSV rows + file reference
                // so passwords do not survive a collapsed-section lifecycle.
                clearImportRowsAndFile()
                setImportDone(false)
              }
              return !v
            })
          }
          aria-expanded={showSync()}
        >
          {showSync() ? "▾ 1Password Sync" : "▸ 1Password Sync"}
        </button>
        <Show when={props.sync?.enabled}>
          <span class="vault-badge-synced skill-badge" style="font-size:10px">on</span>
        </Show>
        <Show when={props.sync?.lastSyncedAt}>
          {(ts) => (
            <span class="vault-sync-meta">
              synced {humanizeRelTime(ts())}
            </span>
          )}
        </Show>
      </div>

      <Show when={showSync()}>
        <div class="vault-sync-form">
          {/* Show server-reported last error in red, sanitized via text content. */}
          <Show when={props.sync?.lastError}>
            {(err) => (
              <div class="skills-error vault-sync-error" role="alert">
                {err()}
              </div>
            )}
          </Show>

          <div class="vault-field">
            <label class="vault-label">
              <input
                type="checkbox"
                class="vault-sync-checkbox"
                checked={syncEnabled()}
                disabled={props.disabled === true}
                onChange={(e) => setSyncEnabled(e.currentTarget.checked)}
              />
              {" "}Enable 1Password sync
            </label>
          </div>

          <div class="vault-field">
            <label class="vault-label" for="vault-sync-label">Account label</label>
            {/* datalist auto-completes from op-token items already in the vault. */}
            <input
              id="vault-sync-label"
              type="text"
              class="vault-input vault-mono"
              list="vault-op-labels"
              placeholder="e.g. MY_OP_TOKEN"
              value={syncOpLabel()}
              disabled={props.disabled === true}
              onInput={(e) => setSyncOpLabel(e.currentTarget.value)}
            />
            <datalist id="vault-op-labels">
              <For each={opLabels()}>
                {(label) => <option value={label} />}
              </For>
            </datalist>
          </div>

          <div class="vault-field">
            <label class="vault-label" for="vault-sync-vault">1Password vault name</label>
            <input
              id="vault-sync-vault"
              type="text"
              class="vault-input"
              placeholder="Luna"
              value={syncOpVault()}
              disabled={props.disabled === true}
              onInput={(e) => setSyncOpVault(e.currentTarget.value)}
            />
            <p class="vault-warn-text">
              Create this vault in 1Password and grant your service account access — service
              accounts can't see Personal vaults.
            </p>
          </div>

          <div class="vault-field">
            <label class="vault-label" for="vault-sync-poll">Poll interval (seconds, min 60)</label>
            <input
              id="vault-sync-poll"
              type="number"
              class="vault-input"
              min={60}
              value={syncPollSeconds()}
              disabled={props.disabled === true}
              onInput={(e) => {
                const v = parseInt(e.currentTarget.value, 10)
                if (!isNaN(v)) setSyncPollSeconds(Math.max(60, v))
              }}
            />
          </div>

          <div class="vault-actions">
            <button
              type="button"
              class="chip"
              disabled={props.disabled === true || pending() !== null}
              onClick={handleSyncSave}
            >
              {pending()?.op === "sync" ? "Saving…" : "Save sync settings"}
            </button>
          </div>

          {/* ── Apple Passwords CSV import ────────────────────────── */}
          <div class="vault-import-section">
            <div class="vault-label vault-import-label">Apple Passwords CSV import</div>

            <Show
              when={syncEnabled()}
              fallback={
                <div class="vault-import-disabled-note">
                  Enable 1Password sync above to import Apple Passwords.
                  <button
                    type="button"
                    class="chip small"
                    disabled
                    style="margin-left:8px;opacity:0.5"
                  >
                    Choose file
                  </button>
                </div>
              }
            >
              <Show when={!importDone()}>
                <Show when={importRows().length === 0 && !importProgress()}>
                  <input
                    type="file"
                    accept=".csv"
                    class="vault-import-file"
                    disabled={props.disabled === true || pending() !== null}
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    aria-label="Choose Apple Passwords CSV export"
                  />
                  <p class="vault-warn-text">
                    Export from Apple Passwords: File → Export → CSV. Delete the file after import.
                  </p>
                </Show>

                <Show when={importRows().length > 0 && !importProgress()}>
                  {/* Preview: titles only — NEVER show usernames or passwords */}
                  <div class="vault-import-preview">
                    <div class="vault-import-count">
                      {importRows().length} password{importRows().length === 1 ? "" : "s"} ready to import
                    </div>
                    <Show when={importRows().length > LARGE_IMPORT_THRESHOLD}>
                      <div class="vault-warn-text">
                        Large import — 1Password limits writes to ~100/hour; the import may pause
                        partway.
                      </div>
                    </Show>
                    <ul class="vault-import-titles">
                      <For each={importRows().slice(0, 5)}>
                        {(row) => <li class="vault-import-title-item">{row.title}</li>}
                      </For>
                      <Show when={importRows().length > 5}>
                        <li class="vault-import-title-item vault-import-more">
                          … and {importRows().length - 5} more
                        </li>
                      </Show>
                    </ul>
                    <div class="vault-actions">
                      <button
                        type="button"
                        class="chip"
                        disabled={props.disabled === true || pending() !== null}
                        onClick={() => { void runImport() }}
                      >
                        Confirm import
                      </button>
                      <button
                        type="button"
                        class="chip small"
                        onClick={clearImportState}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </Show>

                <Show when={importProgress()}>
                  {(progress) => (
                    <div
                      class={
                        progress().startsWith("Import stopped") || progress().startsWith("Import aborted")
                          ? "skills-error"
                          : "vault-import-progress"
                      }
                      role="status"
                    >
                      {progress()}
                    </div>
                  )}
                </Show>
              </Show>

              <Show when={importDone()}>
                <div class="vault-import-done" role="status">
                  Done — you can delete the exported CSV file now.
                  <button
                    type="button"
                    class="chip small"
                    style="margin-left:8px"
                    onClick={() => setImportDone(false)}
                  >
                    Import another
                  </button>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      </Show>

      {/* ── add form ─────────────────────────────────────────────── */}
      <Show when={showAdd()}>
        <div class="vault-add-form">
          <div class="vault-field">
            <label class="vault-label" for="vault-name">Name</label>
            <input
              id="vault-name"
              type="text"
              class="vault-input"
              placeholder="e.g. Notion API Key"
              value={name()}
              disabled={props.disabled === true}
              maxLength={64}
              onInput={(e) => {
                setName(e.currentTarget.value)
                // Reset override preview when name changes if user hasn't
                // explicitly touched it yet.
                if (!showVarOverride()) setVarNameOverride(null)
              }}
            />
          </div>

          <div class="vault-field">
            <label class="vault-label" for="vault-kind">Kind</label>
            <select
              id="vault-kind"
              class="vault-input"
              value={kind()}
              disabled={props.disabled === true}
              onChange={(e) =>
                setKind(e.currentTarget.value as "env-secret" | "op-token")
              }
            >
              <option value="env-secret">API key / secret (default)</option>
              <option value="op-token">1Password service-account token</option>
            </select>
          </div>

          <Show when={kind() === "env-secret"}>
            <div class="vault-field">
              <label class="vault-label">
                {showVarOverride() ? "Env variable name" : "Env variable name (auto)"}
              </label>
              <Show
                when={!showVarOverride()}
                fallback={
                  <input
                    type="text"
                    class="vault-input vault-mono"
                    value={varNameOverride() ?? autoVarName()}
                    disabled={props.disabled === true}
                    onInput={(e) => setVarNameOverride(e.currentTarget.value)}
                  />
                }
              >
                <div class="vault-varname-row">
                  <code class="vault-varname-preview">{autoVarName() || "…"}</code>
                  <button
                    type="button"
                    class="chip small"
                    onClick={() => {
                      setVarNameOverride(autoVarName())
                      setShowVarOverride(true)
                    }}
                  >
                    Override
                  </button>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={kind() === "op-token"}>
            <div class="vault-field">
              <label class="vault-label" for="vault-label">Label</label>
              {/* Finding 1: op-token label uses its own dedicated signal so the
                  typed value is preserved through validateForm and handleSubmit. */}
              <input
                id="vault-label"
                type="text"
                class="vault-input vault-mono"
                placeholder="e.g. MY_OP_TOKEN"
                value={opTokenLabel()}
                disabled={props.disabled === true}
                onInput={(e) => setOpTokenLabel(e.currentTarget.value)}
              />
              <p class="vault-warn-text">
                Saving a 1Password token will restart the server.
              </p>
            </div>
          </Show>

          <div class="vault-field">
            <label class="vault-label" for="vault-value">Secret value</label>
            <input
              id="vault-value"
              type="password"
              class="vault-input"
              placeholder="Paste your secret here"
              disabled={props.disabled === true}
              ref={valueInputRef}
              autocomplete="new-password"
            />
          </div>

          <div class="vault-field">
            <label class="vault-label" for="vault-note">Note (optional)</label>
            <input
              id="vault-note"
              type="text"
              class="vault-input"
              placeholder="Short description"
              value={note()}
              disabled={props.disabled === true}
              onInput={(e) => setNote(e.currentTarget.value)}
            />
          </div>

          <div class="vault-actions">
            {/* Finding 6: Save shows "Saving…" only for a put in-flight (not delete). */}
            <button
              type="button"
              disabled={props.disabled === true || pending() !== null}
              onClick={handleSubmit}
            >
              {pending()?.op === "put" ? "Saving…" : "Save credential"}
            </button>
            <button
              type="button"
              class="chip"
              onClick={closeAdd}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}
