import { homedir } from "node:os"
import { defineCommand } from "citty"
import type { ServerFrame } from "@luna/ui-ws"
import type { ChatArgs } from "../chat/args.js"
import { type ChatConfig, loadChatConfig, readLunaDotEnv } from "../chat/config.js"
import { LunaWsClient } from "../chat/ws-client.js"

/**
 * `luna doctor` — a Mac-side connection PREFLIGHT for the Luna client.
 *
 * Three silent, identical-looking hangs motivated this command:
 *   1. expired/missing Claude credential on the server (setup mode),
 *   2. a WS token that was rotated away (401 on upgrade),
 *   3. a server that is up but not answering (wedged / idle-OAuth lapse).
 * From the outside all three look like "connected, no reply". Doctor runs a
 * LAYERED probe against the EXACT connection `luna chat` would use (same
 * resolver, same flags, same ~/.luna/.env), and reports WHICH layer failed.
 *
 * Layers (each gates the next — a failure stops deeper probes that can't run):
 *   L1 REACH  GET /healthz over http — is the server even reachable?
 *   L2 TOKEN  open the /ui WS upgrade — does the resolved token authenticate?
 *   L3 MODE   await the first `hello` frame — is chat ready, or setup-mode?
 *   L4 CHAT   send a real throwaway chat turn — does Claude actually respond?
 *             (only run when L3 reports chat mode; consumes a sliver of quota)
 *
 * NOTE: `luna doctor` sends a small test message to the server (L4) to verify
 * that Claude is reachable. This consumes a tiny amount of Claude API quota.
 *
 * The probes are impure (network, runtime-specific) but each collapses its
 * outcome into a small enum. `renderVerdicts` is a PURE function from those
 * enums → human lines + exit code, so the verdict logic is unit-testable
 * without a live server.
 */

/* -------------------------------------------------------------------------- */
/* Probe outcome enums (the seam between impure probes and pure rendering)     */
/* -------------------------------------------------------------------------- */

type ReachOutcome =
  | { readonly kind: "ok" }
  /** TCP connection refused — a process is not listening on that port. */
  | { readonly kind: "refused" }
  /** DNS / host unreachable / timeout — the box itself isn't answering. */
  | { readonly kind: "unreachable"; readonly detail: string }
  /** Reached the port but /healthz did not return 200. */
  | { readonly kind: "bad-status"; readonly status: number }

type TokenOutcome =
  | { readonly kind: "ok" }
  /** No token resolved from flags / env / dotenv — nothing to present. */
  | { readonly kind: "missing" }
  /** Upgrade was actively rejected (L1 already proved the server reachable). */
  | { readonly kind: "rejected"; readonly detail: string }
  /** Upgrade neither opened nor rejected within the timeout. */
  | { readonly kind: "timeout" }

type ModeOutcome =
  /** hello arrived with capabilities.chat === true. */
  | { readonly kind: "chat"; readonly protocolVersion: number | null }
  /** hello arrived but server is obs/setup-only (no usable Claude credential). */
  | { readonly kind: "setup"; readonly protocolVersion: number | null }
  /** Open succeeded but no hello frame arrived within the timeout. */
  | { readonly kind: "no-hello" }
  /** A non-hello / malformed first frame, or the socket died awaiting it. */
  | { readonly kind: "error"; readonly detail: string }

type ChatOutcome =
  /** Real chat turn completed successfully (assistant-done received). */
  | { readonly kind: "ok" }
  /**
   * assistant-error with kind==="sdk" received — the SDK / subprocess failed,
   * which is the path a post-boot OAuth lapse takes (chat-service.ts catchAllCause
   * emits kind:"sdk"). Classified as an auth/credential failure.
   * (protocol.ts AssistantErrorFrame + chat-service/types.ts ChatErrorKind)
   */
  | { readonly kind: "auth-error"; readonly detail: string }
  /** assistant-error with a non-sdk kind (unknown-thread, idle, interrupted, etc.). */
  | { readonly kind: "other-error"; readonly detail: string }
  /** No assistant-done/error frame arrived within the 30s deadline. */
  | { readonly kind: "timeout" }
  /** L3 mode was not "chat", so there is nothing to probe. */
  | { readonly kind: "skipped" }

export interface ProbeOutcomes {
  readonly reach: ReachOutcome
  /** undefined when L1 failed and L2 was not run. */
  readonly token?: TokenOutcome
  /** undefined when L1/L2 failed and L3 was not run. */
  readonly mode?: ModeOutcome
  /**
   * undefined when L3 was not run. When L3 ran but mode != chat, kind==="skipped".
   * Only kind==="ok" means the full round-trip succeeded.
   */
  readonly chat?: ChatOutcome
}

/* -------------------------------------------------------------------------- */
/* Pure verdict rendering                                                      */
/* -------------------------------------------------------------------------- */

export interface DoctorReport {
  readonly lines: ReadonlyArray<string>
  readonly exitCode: number
}

const PASS = "[ OK ]"
const FAIL = "[FAIL]"
const SKIP = "[ -- ]"
const WARN = "[WARN]"

/**
 * Pure: strip the query string from a URL for safe display (redacts ?token=…
 * and any other query params that must not appear in doctor output).
 */
export const redactUrl = (url: string): string => {
  const q = url.indexOf("?")
  return q === -1 ? url : url.slice(0, q)
}

/**
 * Pure: classify a hostname as a "transport-safe" target — one where the
 * plaintext ws:// + token-in-URL connection is NOT exposed to an untrusted
 * network. Safe = loopback (127.0.0.1/localhost) OR a Tailscale tailnet target
 * (the 100.64.0.0/10 CGNAT range, or a *.ts.net MagicDNS name). Anything else
 * relies on Tailscale being up (or a private interface) for confidentiality.
 *
 * The CGNAT test is the FULL /10 (100.64.0.0–100.127.255.255), not a `100.*`
 * prefix: public 100.0–100.63 / 100.128+ are NOT Tailscale.
 */
export const isTransportSafeHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase()
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true
  if (host.endsWith(".ts.net")) return true
  // CGNAT 100.64.0.0/10 → first octet 100, second octet in [64, 127].
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (m !== null) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 100 && b >= 64 && b <= 127) return true
  }
  return false
}

/**
 * Pure: given the layered probe outcomes, produce one scannable line per
 * layer (OK/FAIL marker + remedy on failure), a final summary line, and a
 * scriptable exit code (0 iff every layer passed).
 */
export const renderVerdicts = (
  outcomes: ProbeOutcomes,
  ctx: { readonly profileName: string; readonly url: string },
): DoctorReport => {
  const lines: string[] = []
  lines.push(`luna doctor — profile=${ctx.profileName} url=${redactUrl(ctx.url)}`)

  // --- L1 REACH ---
  const reach = outcomes.reach
  let firstFailure: string | null = null
  if (reach.kind === "ok") {
    lines.push(`${PASS} L1 REACH  server reachable (/healthz 200)`)
    // Transport-security WARN: a reachable server on a non-loopback,
    // non-Tailscale host means this plaintext ws:// connection (token in the
    // URL) has no transport confidentiality of its own — it relies on Tailscale
    // (or a private interface) being up. Surface the host ONLY (never ctx.url —
    // it carries ?token=…). Stays a WARN: does NOT set firstFailure, does NOT
    // change the exit code.
    let warnHost: string | null = null
    try {
      warnHost = new URL(ctx.url).hostname
    } catch {
      warnHost = null
    }
    if (warnHost !== null && !isTransportSafeHost(warnHost)) {
      lines.push(
        `${WARN} L1 REACH  '${warnHost}' is not loopback/Tailscale — this plaintext ws:// connection (token in URL) relies on Tailscale/a private interface for security`,
      )
    }
  } else {
    const remedy =
      reach.kind === "refused"
        // Under bun, "connection refused" and "bad host" collapse to the same
        // signal, so own the ambiguity: it's EITHER the server process being
        // down OR the host being unreachable (e.g. Tailscale down). For the
        // remote/Tailscale install this command targets, both are live.
        ? "server DOWN or host unreachable — start it (check the unit) / is Tailscale up?"
        : reach.kind === "unreachable"
          ? `host unreachable — is Tailscale up? (${reach.detail})`
          : `server reachable but /healthz returned ${reach.status} (wrong URL?)`
    lines.push(`${FAIL} L1 REACH  ${remedy}`)
    firstFailure = "L1 REACH"
  }

  // --- L2 TOKEN ---
  const token = outcomes.token
  if (token === undefined) {
    lines.push(`${SKIP} L2 TOKEN  skipped — server not reachable`)
  } else if (token.kind === "ok") {
    lines.push(`${PASS} L2 TOKEN  token accepted (WS upgrade 101)`)
  } else {
    const remedy =
      token.kind === "missing"
        ? `no token configured — set LUNA_${ctx.profileName.toUpperCase()}_UI_WS_TOKEN in ~/.luna/.env (or pass --token)`
        : token.kind === "rejected"
          ? "token REJECTED — rotated/invalid; re-pair or update the token in ~/.luna/.env"
          : "upgrade hung — server reachable but the /ui handshake did not complete"
    lines.push(`${FAIL} L2 TOKEN  ${remedy}`)
    firstFailure ??= "L2 TOKEN"
  }

  // --- L3 MODE ---
  const mode = outcomes.mode
  if (mode === undefined) {
    lines.push(`${SKIP} L3 MODE   skipped — connection not established`)
  } else if (mode.kind === "chat") {
    const ver = mode.protocolVersion === null ? "" : ` (protocol v${mode.protocolVersion})`
    lines.push(`${PASS} L3 MODE   chat ready${ver}`)
  } else {
    const remedy =
      mode.kind === "setup"
        ? "server is in SETUP MODE — Claude login needed (run `claude setup-token` on the server)"
        : mode.kind === "no-hello"
          ? "connected but server not responding (possible idle-OAuth lapse or server wedged)"
          : `connected but first frame was unexpected (${mode.detail})`
    lines.push(`${FAIL} L3 MODE   ${remedy}`)
    firstFailure ??= "L3 MODE"
  }

  // --- L4 CHAT ---
  const chat = outcomes.chat
  if (chat === undefined) {
    lines.push(`${SKIP} L4 CHAT   skipped — connection not established`)
  } else if (chat.kind === "skipped") {
    lines.push(`${SKIP} L4 CHAT   skipped — server not in chat mode`)
  } else if (chat.kind === "ok") {
    lines.push(`${PASS} L4 CHAT   active chat probe succeeded (assistant responded)`)
  } else if (chat.kind === "timeout") {
    // SOFT verdict (not a hard FAIL): a slow first turn (cold-start: SDK
    // subprocess spawn + per-turn MCP wiring) can exceed the probe window on a
    // freshly-restarted server, yet the server is fine. Reporting a hard FAIL
    // here cries wolf (it did exactly that against a server that demonstrably
    // chats). WARN + re-run guidance, and it does NOT set firstFailure, so a
    // slow-but-otherwise-green server still exits 0.
    lines.push(
      `${WARN} L4 CHAT   no response within ${Math.round(CHAT_PROBE_TIMEOUT_MS / 1000)}s — server slow (cold start?) or wedged; re-run to confirm`,
    )
  } else {
    const remedy =
      chat.kind === "auth-error"
        ? `server can't reach Claude — the login likely lapsed; run \`claude setup-token\` on the server (${chat.detail})`
        : `chat turn failed unexpectedly (${chat.detail})`
    lines.push(`${FAIL} L4 CHAT   ${remedy}`)
    firstFailure ??= "L4 CHAT"
  }

  // --- summary ---
  if (firstFailure === null) {
    lines.push(`${PASS} PASS — connection healthy; \`luna chat\` should work`)
    return { lines, exitCode: 0 }
  }
  const action = lines.find((l) => l.startsWith(FAIL) && l.includes(firstFailure!))
  const remedy = action === undefined ? "" : `: ${action.slice(action.indexOf("  ") + 2).trim()}`
  lines.push(`${FAIL} FAIL at ${firstFailure}${remedy}`)
  return { lines, exitCode: 1 }
}

/* -------------------------------------------------------------------------- */
/* Impure probes (network, runtime-specific) — quarantined here                */
/* -------------------------------------------------------------------------- */

const REACH_TIMEOUT_MS = 3_000
const UPGRADE_TIMEOUT_MS = 4_000
const HELLO_TIMEOUT_MS = 4_000
// Generous: a one-shot human-invoked diagnostic, and a real cloud-Claude turn
// on a cold-started server (SDK subprocess spawn + per-turn MCP wiring) can run
// well past 30s. A timeout here is a soft WARN, not a hard FAIL (see render).
const CHAT_PROBE_TIMEOUT_MS = 60_000

/** The throwaway model used by the L4 active chat probe. Matches luna chat default. */
const PROBE_MODEL = "claude-sonnet-4-5"

/** Convert a ws(s):// URL to its http(s) /healthz sibling on the same host:port. */
export const healthzUrlFor = (wsUrl: string): string => {
  const u = new URL(wsUrl)
  u.protocol = u.protocol === "wss:" ? "https:" : "http:"
  u.pathname = "/healthz"
  u.search = ""
  u.hash = ""
  return u.toString()
}

const probeReach = async (wsUrl: string): Promise<ReachOutcome> => {
  let healthz: string
  try {
    healthz = healthzUrlFor(wsUrl)
  } catch (e) {
    return { kind: "unreachable", detail: `invalid url: ${e instanceof Error ? e.message : String(e)}` }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REACH_TIMEOUT_MS)
  try {
    const res = await fetch(healthz, { signal: controller.signal, redirect: "manual" })
    if (res.status === 200) return { kind: "ok" }
    return { kind: "bad-status", status: res.status }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Our own abort fired → the box never answered (DNS / host-unreachable /
    // dead route). This is the Tailscale-down / wrong-host signal.
    if (controller.signal.aborted) {
      return { kind: "unreachable", detail: `timeout after ${REACH_TIMEOUT_MS}ms` }
    }
    // Connection actively refused → a host answered but nothing is listening
    // on the port (server process down). Node uses code "ECONNREFUSED"; bun
    // uses "ConnectionRefused". Bun collapses bad-host into the same code, but
    // "server down" is the more common + more actionable read for a refused
    // connect, and genuine host-unreachable surfaces via the abort path above.
    const code = (e as { code?: string } | undefined)?.code ?? ""
    if (
      code === "ECONNREFUSED" ||
      code === "ConnectionRefused" ||
      /ECONNREFUSED|connection refused|unable to connect/i.test(msg)
    ) {
      return { kind: "refused" }
    }
    return { kind: "unreachable", detail: msg }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Open the /ui WS upgrade with the resolved token, then await the first
 * `hello` frame. Returns BOTH the L2 (token) and L3 (mode) outcomes from a
 * single connection — a successful upgrade IS L2-pass, and we reuse that open
 * socket for L3 rather than reconnecting.
 *
 * IMPORTANT: on success the returned `client` is OPEN. The caller MUST close
 * it (in a try/finally) after any further probing — it is NOT closed here.
 * This allows L4 to reuse the same socket without reopening.
 *
 * Note (bun): the readable HTTP-401 path (`unexpected-response`) is only wired
 * under Node; under bun a rejected upgrade surfaces as a generic connection
 * error. That is FINE here: L1 already proved the server reachable, so any
 * upgrade rejection at L2 is definitionally a token problem, not "server down".
 */
const probeTokenAndMode = async (
  wsUrl: string,
  token: string,
): Promise<{ token: TokenOutcome; mode?: ModeOutcome; client?: LunaWsClient }> => {
  let client: LunaWsClient
  try {
    client = await LunaWsClient.connect({ url: wsUrl, token, timeoutMs: UPGRADE_TIMEOUT_MS })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // The client throws a distinct "timed out after Nms" on timeout vs an
    // early connection-error reject. Key off that (not bun's error text).
    if (/timed out after \d+ms/.test(msg)) return { token: { kind: "timeout" } }
    return { token: { kind: "rejected", detail: msg } }
  }

  // Upgrade succeeded → token OK. Now race the first frame against a timeout.
  try {
    const helloRace = await raceFrame(client, HELLO_TIMEOUT_MS)
    if (helloRace.kind === "timeout") {
      await client.close().catch(() => {})
      return { token: { kind: "ok" }, mode: { kind: "no-hello" } }
    }
    const frame = helloRace.frame
    if (frame.type !== "hello") {
      await client.close().catch(() => {})
      return { token: { kind: "ok" }, mode: { kind: "error", detail: `first frame was '${frame.type}'` } }
    }
    const caps = (frame as { capabilities?: { chat?: boolean } }).capabilities
    const protocolVersion =
      typeof (frame as { protocolVersion?: unknown }).protocolVersion === "number"
        ? (frame as { protocolVersion: number }).protocolVersion
        : null
    if (caps?.chat === true) {
      // Return the live client so L4 can reuse this connection.
      return { token: { kind: "ok" }, mode: { kind: "chat", protocolVersion }, client }
    }
    await client.close().catch(() => {})
    return { token: { kind: "ok" }, mode: { kind: "setup", protocolVersion } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await client.close().catch(() => {})
    return { token: { kind: "ok" }, mode: { kind: "error", detail: msg } }
  }
}

type FrameRace =
  | { readonly kind: "frame"; readonly frame: ServerFrame }
  | { readonly kind: "timeout" }

/** Race `client.nextFrame()` against a timeout so L3 can never hang. */
const raceFrame = (client: LunaWsClient, timeoutMs: number): Promise<FrameRace> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<FrameRace>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs)
  })
  const next = client.nextFrame().then((frame): FrameRace => ({ kind: "frame", frame }))
  return Promise.race([next, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * L4 ACTIVE CHAT PROBE — drive a real chat turn on the already-open socket.
 *
 * Doctor now catches:
 *   A = server down/unreachable (L1)
 *   B = bad/rotated token (L2)
 *   C = server in setup mode / no Claude credential at boot (L3)
 *   D = post-boot OAuth lapse / credential now invalid (L4 — this probe)
 *
 * Honest scope: L4 does NOT catch a client-specific frame-name protocol bug
 * (e.g. a subscribe-thread-style name drift). Doctor sends its OWN correct
 * frames, so it cannot reproduce a DIFFERENT client's typo. That failure mode
 * is covered separately by the planned version-skew defenses (server
 * unknown-frame reply + a frame-literal snapshot test).
 *
 * The probe creates a NEW throwaway thread (new-thread), so it NEVER touches
 * the user's existing conversation. The server auto-subscribes on new-thread
 * (server.ts:802), so the explicit subscribe frame is belt-and-suspenders.
 *
 * Error classification: AssistantErrorFrame carries error.kind (ChatErrorKind
 * per protocol.ts:105-119 + chat-service/types.ts:18-24). kind==="sdk" is the
 * path a post-boot credential lapse takes (chat-service.ts catchAllCause emits
 * kind:"sdk"). All other kinds → other-error.
 *
 * Frame interleaving: the socket receives broadcast obs events (event/drop/ping)
 * and possibly survey-request / thread-snapshot / user-accepted / assistant-delta
 * / tool-call / tool-result alongside the turn frames. We use a deadline loop
 * that skips non-matching frames rather than a naive single-await, and always
 * matches by threadId so a stale frame from another thread can't confuse us.
 */
const probeChatActive = async (client: LunaWsClient): Promise<ChatOutcome> => {
  const deadline = Date.now() + CHAT_PROBE_TIMEOUT_MS

  // Step 1: send new-thread, await thread-created to get the throwaway thread id.
  client.send({ type: "new-thread", model: PROBE_MODEL, title: "doctor-probe" })

  let threadId: string | undefined
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const race = await raceFrame(client, remaining)
    if (race.kind === "timeout") break
    if (race.frame.type === "thread-created") {
      threadId = (race.frame as { thread: { id: string } }).thread.id
      break
    }
    // skip broadcast / unrelated frames and keep waiting
  }

  if (threadId === undefined) {
    return { kind: "timeout" }
  }

  // Step 2: subscribe (belt-and-suspenders — server already auto-subscribed).
  client.send({ type: "subscribe", threadId })

  // Step 3: send the probe message.
  client.send({ type: "user-message", threadId, text: "Reply with just: pong" })

  // Step 4: race for assistant-done or assistant-error, skipping all other frames.
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const race = await raceFrame(client, remaining)
    if (race.kind === "timeout") break
    const f = race.frame
    if (f.type === "assistant-done" && (f as { threadId: string }).threadId === threadId) {
      return { kind: "ok" }
    }
    if (f.type === "assistant-error" && (f as { threadId: string }).threadId === threadId) {
      const errFrame = f as { error: { kind: string; message: string } }
      const errKind = errFrame.error.kind
      const errMsg = errFrame.error.message
      // kind==="sdk" is the path a post-boot OAuth lapse takes.
      if (errKind === "sdk") {
        return { kind: "auth-error", detail: errMsg }
      }
      return { kind: "other-error", detail: `${errKind}: ${errMsg}` }
    }
    // skip assistant-delta, user-accepted, event, ping, survey-request, etc.
  }

  return { kind: "timeout" }
}

/** Run the layered probe end to end. Each layer gates the next. */
export const runDoctorProbes = async (cfg: ChatConfig): Promise<ProbeOutcomes> => {
  const reach = await probeReach(cfg.url)
  if (reach.kind !== "ok") return { reach }

  if (cfg.token === null || cfg.token.length === 0) {
    return { reach, token: { kind: "missing" } }
  }

  const { token, mode, client } = await probeTokenAndMode(cfg.url, cfg.token)
  if (mode === undefined) return { reach, token }

  // L4 only runs when L3 reported chat mode AND we have a live socket.
  if (mode.kind !== "chat" || client === undefined) {
    return { reach, token, mode, chat: { kind: "skipped" } }
  }

  // Reuse the open socket from L3 for L4 — do NOT reconnect.
  let chat: ChatOutcome
  try {
    chat = await probeChatActive(client)
  } finally {
    await client.close().catch(() => {})
  }
  return { reach, token, mode, chat }
}

/* -------------------------------------------------------------------------- */
/* Config resolution — reuse the EXACT resolver `luna chat` uses               */
/* -------------------------------------------------------------------------- */

/**
 * Build the minimal `ChatArgs` doctor cares about (the connection-selecting
 * subset) so we can drive the shared `loadChatConfig` resolver — same
 * --profile/--dev/--url/--token flags and the same env/dotenv precedence as
 * `luna chat`. We do NOT go through `parseChatArgs` (it expects argv[0]==="chat"
 * and is wired for the full chat arg set), so `--dev` → profile is mapped here.
 */
export const doctorChatArgs = (args: {
  readonly profile?: string
  readonly dev?: boolean
  readonly url?: string
  readonly "fallback-url"?: string
  readonly token?: string
}): ChatArgs => ({
  command: "chat",
  unknown: [],
  ...(args.dev === true ? { profile: "dev" } : args.profile !== undefined ? { profile: args.profile } : {}),
  ...(args.url !== undefined ? { url: args.url } : {}),
  ...(args["fallback-url"] !== undefined ? { fallbackUrl: args["fallback-url"] } : {}),
  ...(args.token !== undefined ? { token: args.token } : {}),
})

export const resolveDoctorConfig = (
  args: Parameters<typeof doctorChatArgs>[0],
  env: Record<string, string | undefined>,
  homeDir: string,
  cwd: string,
): ChatConfig =>
  loadChatConfig({
    args: doctorChatArgs(args),
    env,
    dotenv: readLunaDotEnv(homeDir),
    homeDir,
    cwd,
  })

/* -------------------------------------------------------------------------- */
/* citty command                                                               */
/* -------------------------------------------------------------------------- */

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description:
      "Preflight the Luna connection: reachability, token, server mode, and active Claude probe (L4 sends a tiny test message that consumes a sliver of Claude quota)",
  },
  args: {
    profile: { type: "string", description: "named profile from ~/.luna/.env (default: stable)" },
    dev: { type: "boolean", description: "shortcut for --profile dev" },
    url: { type: "string", description: "UI WebSocket URL" },
    "fallback-url": { type: "string", description: "fallback UI WebSocket URL" },
    token: { type: "string", description: "UI WebSocket bearer token" },
  },
  async run({ args }) {
    const cfg = resolveDoctorConfig(
      {
        profile: args.profile,
        dev: args.dev === true,
        url: args.url,
        "fallback-url": args["fallback-url"],
        token: args.token,
      },
      process.env,
      homedir(),
      process.cwd(),
    )

    const outcomes = await runDoctorProbes(cfg)
    const report = renderVerdicts(outcomes, { profileName: cfg.profileName, url: cfg.url })

    // Write all lines as one chunk and await the write callback so the last
    // line is never truncated when stdout is redirected to a pipe or file
    // (Fix B: process.exit() must not fire before the OS flushes the buffer).
    // The write() callback fires after the data has been flushed to the OS,
    // regardless of whether the internal buffer was full (ok===false) or not.
    const output = report.lines.map((l) => `${l}\n`).join("")
    await new Promise<void>((resolve) => {
      process.stdout.write(output, () => resolve())
    })
    process.exit(report.exitCode)
  },
})
