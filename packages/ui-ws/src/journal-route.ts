/**
 * POST /v1/journal: inbound end-of-session journals from the luna-journal
 * Claude Code mod. Auth is a dedicated write-only token (LUNA_JOURNAL_TOKEN),
 * never the main ui-ws token, because that one can drive the shell bridge.
 *
 * The route only validates and hands a typed entry to the sink. Everything
 * that ends up in memory (label, fencing, redaction) is built server-side by
 * the sink, so nothing here trusts client prose.
 */
import type * as http from "node:http"
import { Effect } from "effect"

export const JOURNAL_PATH = "/v1/journal"
export const JOURNAL_MAX_BODY_BYTES = 64 * 1024
export const JOURNAL_MIN_TOKEN_LENGTH = 32
/** Socket inactivity timeout. */
export const JOURNAL_REQUEST_TIMEOUT_MS = 10_000
/** Absolute deadline for one request, body and sink write included. */
export const JOURNAL_REQUEST_DEADLINE_MS = 15_000
/** Journal requests past auth that may be reading or writing at once. */
export const JOURNAL_MAX_IN_FLIGHT = 4

export const JOURNAL_END_REASONS = [
  "clear",
  "resume",
  "logout",
  "prompt_input_exit",
  "other",
  "crash-recovered",
] as const
export type JournalEndReason = (typeof JOURNAL_END_REASONS)[number]

export const JOURNAL_CLIENTS = [
  "claude-code-cli",
  "claude-code-desktop",
  "claude-code",
] as const
export type JournalClient = (typeof JOURNAL_CLIENTS)[number]

export interface JournalEntry {
  readonly v: 1
  readonly source: "claude-code"
  readonly session_id: string
  readonly entry_id: string
  readonly repo: string
  readonly repo_path: string
  readonly branch: string
  readonly head_sha?: string
  readonly started_at: string
  readonly ended_at: string
  readonly summary: string
  readonly files_changed?: ReadonlyArray<string>
  readonly files_total?: number
  readonly turns?: number
  readonly end_reason?: JournalEndReason
  readonly host: string
  readonly client: JournalClient
  readonly client_version?: string
  readonly summary_model?: string
}

export type JournalSubmitResult =
  | { readonly ok: true; readonly id: string; readonly deduped: boolean }
  | { readonly ok: false }

export interface JournalSink {
  readonly submit: (entry: JournalEntry) => Effect.Effect<JournalSubmitResult>
}

export type JournalValidation =
  | { readonly ok: true; readonly entry: JournalEntry }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> }

const SESSION_ID_RE = /^[A-Za-z0-9-]{8,128}$/
const ENTRY_ID_RE = /^[A-Za-z0-9-]{8,64}$/
const HEAD_SHA_RE = /^[0-9a-f]{7,40}$/
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/
const DAY_MS = 86_400_000

export const SUMMARY_MAX_CHARS = 1200
export const SUMMARY_MAX_LINES = 6
export const FILES_MAX_ITEMS = 200
export const FILE_MAX_CHARS = 300

/**
 * Pure validator. Unknown keys are dropped; wrong types are rejected. `now`
 * is injectable so the "not more than a day in the future" rule is testable.
 */
export function validateJournalEntry(
  raw: unknown,
  now: number = Date.now(),
): JournalValidation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["body: must be a JSON object"] }
  }
  const r = raw as Record<string, unknown>
  const errors: string[] = []

  const str = (key: string, min: number, max: number, required: boolean): string | undefined => {
    const v = r[key]
    if (v === undefined) {
      if (required) errors.push(`${key}: required`)
      return undefined
    }
    if (typeof v !== "string" || v.length < min || v.length > max) {
      errors.push(`${key}: must be a string of ${min}-${max} chars`)
      return undefined
    }
    return v
  }
  const re = (key: string, pattern: RegExp, required: boolean): string | undefined => {
    const v = r[key]
    if (v === undefined) {
      if (required) errors.push(`${key}: required`)
      return undefined
    }
    if (typeof v !== "string" || !pattern.test(v)) {
      errors.push(`${key}: invalid format`)
      return undefined
    }
    return v
  }
  const int = (key: string, min: number, max: number): number | undefined => {
    const v = r[key]
    if (v === undefined) return undefined
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      errors.push(`${key}: must be an integer ${min}-${max}`)
      return undefined
    }
    return v
  }
  const oneOf = <T extends string>(
    key: string,
    allowed: ReadonlyArray<T>,
    required: boolean,
  ): T | undefined => {
    const v = r[key]
    if (v === undefined) {
      if (required) errors.push(`${key}: required`)
      return undefined
    }
    if (typeof v !== "string" || !(allowed as ReadonlyArray<string>).includes(v)) {
      errors.push(`${key}: must be one of ${allowed.join("|")}`)
      return undefined
    }
    return v as T
  }
  const date = (key: string): number | undefined => {
    const v = r[key]
    if (v === undefined) {
      errors.push(`${key}: required`)
      return undefined
    }
    const t = typeof v === "string" && ISO_RE.test(v) ? Date.parse(v) : NaN
    if (!Number.isFinite(t)) {
      errors.push(`${key}: must be an ISO 8601 timestamp`)
      return undefined
    }
    if (t > now + DAY_MS) {
      errors.push(`${key}: more than one day in the future`)
      return undefined
    }
    return t
  }

  if (r["v"] !== 1) errors.push("v: must be 1")
  if (r["source"] !== "claude-code") errors.push("source: must be \"claude-code\"")
  const session_id = re("session_id", SESSION_ID_RE, true)
  const entry_id = re("entry_id", ENTRY_ID_RE, true)
  const repo = str("repo", 1, 100, true)
  const repo_path = str("repo_path", 1, 300, true)
  const branch = str("branch", 1, 200, true)
  const head_sha = re("head_sha", HEAD_SHA_RE, false)
  const startedMs = date("started_at")
  const endedMs = date("ended_at")
  if (startedMs !== undefined && endedMs !== undefined && endedMs < startedMs) {
    errors.push("ended_at: must not be before started_at")
  }
  let summary = str("summary", 1, SUMMARY_MAX_CHARS, true)
  if (summary !== undefined && summary.trim().length === 0) {
    errors.push("summary: must not be blank")
    summary = undefined
  }
  if (summary !== undefined && summary.split("\n").length > SUMMARY_MAX_LINES) {
    errors.push(`summary: at most ${SUMMARY_MAX_LINES} lines`)
    summary = undefined
  }
  let files_changed: string[] | undefined
  const fc = r["files_changed"]
  if (fc !== undefined) {
    if (!Array.isArray(fc) || fc.length > FILES_MAX_ITEMS) {
      errors.push(`files_changed: must be an array of at most ${FILES_MAX_ITEMS} items`)
    } else if (!fc.every((f) => typeof f === "string" && f.length >= 1 && f.length <= FILE_MAX_CHARS)) {
      errors.push(`files_changed: each item must be a string of 1-${FILE_MAX_CHARS} chars`)
    } else {
      files_changed = fc as string[]
    }
  }
  const files_total = int("files_total", 0, 1_000_000)
  const turns = int("turns", 0, 10_000)
  const end_reason = oneOf("end_reason", JOURNAL_END_REASONS, false)
  const host = str("host", 1, 64, true)
  const client = oneOf("client", JOURNAL_CLIENTS, true)
  const client_version = str("client_version", 1, 32, false)
  const summary_model = str("summary_model", 1, 64, false)

  if (errors.length > 0) return { ok: false, errors }

  const entry: JournalEntry = {
    v: 1,
    source: "claude-code",
    session_id: session_id!,
    entry_id: entry_id!,
    repo: repo!,
    repo_path: repo_path!,
    branch: branch!,
    ...(head_sha !== undefined ? { head_sha } : {}),
    started_at: r["started_at"] as string,
    ended_at: r["ended_at"] as string,
    summary: summary!,
    ...(files_changed !== undefined ? { files_changed } : {}),
    ...(files_total !== undefined ? { files_total } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(end_reason !== undefined ? { end_reason } : {}),
    host: host!,
    client: client!,
    ...(client_version !== undefined ? { client_version } : {}),
    ...(summary_model !== undefined ? { summary_model } : {}),
  }
  return { ok: true, entry }
}

/**
 * A token shorter than the minimum disables the route rather than weakening
 * it. Returns the usable token or null.
 */
export function resolveJournalToken(
  raw: string | null | undefined,
  warn: (msg: string) => void = (m) => console.warn(m),
): string | null {
  const t = raw?.trim() ?? ""
  if (t.length === 0) return null
  if (t.length < JOURNAL_MIN_TOKEN_LENGTH) {
    warn(
      `[ui-ws] journal token is shorter than ${JOURNAL_MIN_TOKEN_LENGTH} chars; /v1/journal stays disabled`,
    )
    return null
  }
  return t
}

export interface JournalRateLimiterOptions {
  readonly perMinute?: number
  readonly perDay?: number
  readonly globalPerDay?: number
  readonly now?: () => number
}

export type RateDecision = { readonly ok: true } | { readonly ok: false; readonly retryAfterSec: number }

/**
 * In-memory fixed-window limiter. Per process and reset on restart, which is
 * fine for a single-operator route; it is a brake, not a security boundary.
 *
 * Keyed on the socket address, but behind the incus proxy every client
 * arrives from 127.0.0.1, so in that deployment the per-key limits are
 * effectively global. Only token holders reach check(), so the worst case is
 * the token holder throttling itself; no forwarded header is trusted.
 */
export class JournalRateLimiter {
  private readonly perMinute: number
  private readonly perDay: number
  private readonly globalPerDay: number
  private readonly now: () => number
  private readonly byKey = new Map<string, { min: number; minCount: number; day: number; dayCount: number }>()
  private global = { day: -1, count: 0 }
  private authFail = { min: -1, logged: false, suppressed: 0 }

  constructor(opts: JournalRateLimiterOptions = {}) {
    this.perMinute = opts.perMinute ?? 30
    this.perDay = opts.perDay ?? 500
    this.globalPerDay = opts.globalPerDay ?? 1000
    this.now = opts.now ?? Date.now
  }

  check(key: string): RateDecision {
    const t = this.now()
    const min = Math.floor(t / 60_000)
    const day = Math.floor(t / DAY_MS)
    const toNextMin = Math.max(1, Math.ceil(((min + 1) * 60_000 - t) / 1000))
    const toNextDay = Math.max(1, Math.ceil(((day + 1) * DAY_MS - t) / 1000))

    if (this.global.day !== day) this.global = { day, count: 0 }
    if (this.byKey.size > 10_000) {
      for (const [k, v] of this.byKey) if (v.day !== day) this.byKey.delete(k)
    }
    let s = this.byKey.get(key)
    if (s === undefined) {
      s = { min, minCount: 0, day, dayCount: 0 }
      this.byKey.set(key, s)
    }
    if (s.min !== min) {
      s.min = min
      s.minCount = 0
    }
    if (s.day !== day) {
      s.day = day
      s.dayCount = 0
    }
    if (this.global.count >= this.globalPerDay || s.dayCount >= this.perDay) {
      return { ok: false, retryAfterSec: toNextDay }
    }
    if (s.minCount >= this.perMinute) return { ok: false, retryAfterSec: toNextMin }
    s.minCount++
    s.dayCount++
    this.global.count++
    return { ok: true }
  }

  /**
   * Whether to log this auth failure: one line per minute, carrying how many
   * were swallowed since, so a stream of bad bearers cannot flood the log.
   */
  authFailureLog(): { readonly log: boolean; readonly suppressed: number } {
    const min = Math.floor(this.now() / 60_000)
    if (this.authFail.min !== min) this.authFail = { min, logged: false, suppressed: this.authFail.suppressed }
    if (this.authFail.logged) {
      this.authFail.suppressed++
      return { log: false, suppressed: 0 }
    }
    const suppressed = this.authFail.suppressed
    this.authFail = { min, logged: true, suppressed: 0 }
    return { log: true, suppressed }
  }
}

/** Counts authenticated journal requests in progress; one per server. */
export class JournalInFlight {
  private n = 0
  constructor(readonly max: number = JOURNAL_MAX_IN_FLIGHT) {}
  get count(): number {
    return this.n
  }
  tryAcquire(): boolean {
    if (this.n >= this.max) return false
    this.n++
    return true
  }
  release(): void {
    this.n = Math.max(0, this.n - 1)
  }
}

export interface JournalRouteDeps {
  readonly token: string | null
  readonly sink: JournalSink | null
  readonly tokenEq: (a: string, b: string) => boolean
  readonly rateLimiter: JournalRateLimiter
  readonly inFlight: JournalInFlight
  /** Overrides JOURNAL_REQUEST_DEADLINE_MS; tests use a short one. */
  readonly deadlineMs?: number
  readonly log?: (msg: string) => void
}

const sendJson = (
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void => {
  if (res.headersSent) return
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...extra,
  })
  res.end(JSON.stringify(body))
}

const readBody = (
  req: http.IncomingMessage,
  cap: number,
  signal: AbortSignal,
): Promise<Buffer | "too_large" | "aborted"> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const onAbort = () => finish("aborted")
    const finish = (v: Buffer | "too_large" | "aborted") => {
      if (done) return
      done = true
      signal.removeEventListener("abort", onAbort)
      resolve(v)
    }
    if (signal.aborted) {
      finish("aborted")
      return
    }
    signal.addEventListener("abort", onAbort)
    req.on("data", (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > cap) {
        finish("too_large")
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => finish(Buffer.concat(chunks)))
    req.on("error", () => finish("aborted"))
    req.on("close", () => finish("aborted"))
  })

const tooLarge = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  if (res.headersSent) {
    req.destroy()
    return
  }
  res.writeHead(413, { "content-type": "application/json", connection: "close" })
  res.end(JSON.stringify({ ok: false, error: "too_large" }), () => req.destroy())
}

export async function handleJournalRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: JournalRouteDeps,
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.warn(m))
  req.setTimeout(JOURNAL_REQUEST_TIMEOUT_MS, () => req.destroy())

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { allow: "POST" })
    return
  }
  if (deps.sink === null || deps.token === null) {
    sendJson(res, 503, { ok: false, error: "journal_disabled" })
    return
  }
  // Header only: a query-string token would end up in proxy and shell logs.
  const auth = req.headers["authorization"]
  const presented = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null
  if (presented === null || !deps.tokenEq(presented, deps.token)) {
    const l = deps.rateLimiter.authFailureLog()
    if (l.log) {
      const more = l.suppressed > 0 ? ` (${l.suppressed} more since the last line)` : ""
      log(`[ui-ws] journal auth failed: 401 sent to ${req.socket.remoteAddress ?? "unknown"}${more}`)
    }
    sendJson(res, 401, { ok: false, error: "unauthorized" })
    return
  }
  const ctype = req.headers["content-type"]
  if (typeof ctype !== "string" || !ctype.toLowerCase().startsWith("application/json")) {
    sendJson(res, 415, { ok: false, error: "unsupported_media_type" })
    return
  }
  const declared = Number(req.headers["content-length"])
  if (Number.isFinite(declared) && declared > JOURNAL_MAX_BODY_BYTES) {
    tooLarge(req, res)
    return
  }
  // Checked before reading so a throttled client cannot make us buffer bodies.
  const rate = deps.rateLimiter.check(req.socket.remoteAddress ?? "unknown")
  if (!rate.ok) {
    sendJson(res, 429, { ok: false, error: "rate_limited" }, { "retry-after": String(rate.retryAfterSec) })
    return
  }
  if (!deps.inFlight.tryAcquire()) {
    sendJson(res, 503, { ok: false, error: "busy" }, { "retry-after": "5" })
    return
  }

  // One absolute deadline covers a trickled body and a hanging sink alike;
  // the socket timeout above only catches total silence. A client that goes
  // away aborts the same way, so its sink write is interrupted too.
  const abort = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, deps.deadlineMs ?? JOURNAL_REQUEST_DEADLINE_MS)
  const onClose = () => {
    if (!res.writableFinished) abort.abort()
  }
  // Both: Node signals a dropped client on the response, Bun on the socket.
  res.on("close", onClose)
  const socket = req.socket
  socket.on("close", onClose)
  const giveUp = (status: number, error: string): void => {
    if (!timedOut || res.headersSent) {
      req.destroy()
      return
    }
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" })
    res.end(JSON.stringify({ ok: false, error }), () => req.destroy())
  }
  try {
    const body = await readBody(req, JOURNAL_MAX_BODY_BYTES, abort.signal)
    if (body === "too_large") {
      tooLarge(req, res)
      return
    }
    if (body === "aborted") {
      giveUp(408, "timeout")
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString("utf8"))
    } catch {
      sendJson(res, 400, { ok: false, error: "bad_json" })
      return
    }
    const v = validateJournalEntry(parsed)
    if (!v.ok) {
      sendJson(res, 422, { ok: false, errors: v.errors })
      return
    }
    let result: JournalSubmitResult
    try {
      result = await Effect.runPromise(deps.sink.submit(v.entry), { signal: abort.signal })
    } catch {
      if (abort.signal.aborted) {
        giveUp(504, "timeout")
        return
      }
      result = { ok: false }
    }
    if (result.ok) {
      sendJson(res, 200, { ok: true, id: result.id, deduped: result.deduped })
    } else {
      sendJson(res, 500, { ok: false, error: "journal_write_failed" })
    }
  } finally {
    clearTimeout(timer)
    res.off("close", onClose)
    socket.off("close", onClose)
    deps.inFlight.release()
  }
}
