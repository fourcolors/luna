/**
 * WidgetSummonBridge — the server-side half of summon-by-name
 * (widget-system.md "Summon-by-name"). A host client that can open widgets
 * announces its directory after hello (`widget-directory`); the agent's
 * `open_widget` tool calls `open(kind)`, which validates the kind against
 * the ANNOUNCED directory and sends a `widget-open` frame to that client.
 *
 * Design properties:
 *   - The directory comes FROM the client. The server never hardcodes a
 *     host's widget list, so a different host can offer a different
 *     directory and a server without this bridge ignores the frames
 *     entirely (the server-agnostic seam).
 *   - The frame only ever names a kind. The host resolves it through its
 *     own shipped registry, so the agent can summon UI but can never
 *     conjure a window the host didn't already ship.
 *   - Last-announcer-wins, mirroring the secret-request bridge's
 *     last-subscriber model: with one Moon app connected (the normal case)
 *     that is simply "the Moon"; a second host taking over is the same
 *     user-visible model as secret entry.
 *   - Fire-and-forget: `open` resolves as soon as the frame is handed to the
 *     socket. Whether the window actually appeared is the host's concern;
 *     the singleton/registry behavior makes the operation idempotent.
 *
 * The same bridge also carries `openArtifact` — the content-tier sibling of
 * `open`. Where `open` summons a SYSTEM panel by registry kind (validated
 * against the announced directory), `openArtifact` asks the same host to pop a
 * pinned CONTENT artifact (a widget / mcp-app the agent created) into its own
 * window via the `open-artifact-widget` frame. It reuses the one send-closure
 * the host registered, so a single connection serves both summon paths.
 */
import type {
  ArtifactKind,
  OpenArtifactWidgetFrame,
  WidgetDirectoryEntry,
  WidgetOpenFrame,
} from "./protocol.js"

export type SendWidgetFrame = (
  frame: WidgetOpenFrame | OpenArtifactWidgetFrame,
) => void

export interface WidgetSummonBridge {
  /** A client announced (or re-announced) its directory. */
  readonly registerClient: (
    clientId: string,
    send: SendWidgetFrame,
    widgets: ReadonlyArray<WidgetDirectoryEntry>,
  ) => void
  /** A client disconnected; forget it (and its directory if it was current). */
  readonly unregisterClient: (clientId: string) => void
  /** The current directory ([] when no host is connected). */
  readonly directory: () => ReadonlyArray<WidgetDirectoryEntry>
  /**
   * Ask the current host to open `kind`. Validates against the announced
   * directory. Returns ok/message for the tool to relay to the model.
   */
  readonly open: (
    kind: string,
    params?: Readonly<Record<string, string | number | boolean>>,
  ) => { readonly ok: boolean; readonly message: string }
  /**
   * Ask the current host to pop a pinned CONTENT artifact into its own widget
   * window (the content-tier sibling of `open`). Unlike `open`, there is no
   * registry directory to validate against — the host renders the artifact in
   * its sandboxed cage by id, so this can never open a system panel. Returns
   * ok/message; `ok:false` when no host is connected (degrade gracefully, like
   * `open`).
   */
  readonly openArtifact: (
    artifactId: string,
    title: string,
    kind: ArtifactKind,
  ) => { readonly ok: boolean; readonly message: string }
}

interface Registrant {
  readonly clientId: string
  readonly send: SendWidgetFrame
  readonly widgets: ReadonlyArray<WidgetDirectoryEntry>
}

/**
 * Most artifact-opens issued while no host is connected to buffer for replay.
 * Bounded so a host that never reconnects (a headless/cron context) can't grow
 * the buffer without limit; dedup-by-artifactId keeps it small in practice (an
 * iterate-then-reopen loop collapses to one entry). Small on purpose: this is a
 * mid-reconnect bridge, not a durable outbox — the artifact itself is persisted
 * and reopenable by id regardless.
 */
const MAX_PENDING_OPENS = 8

export const createWidgetSummonBridge = (): WidgetSummonBridge => {
  let current: Registrant | null = null
  // Open-artifact intents issued while current===null, keyed by artifactId
  // (insertion-ordered; re-opening the same id keeps only the latest frame).
  // Flushed exactly once to the next host that registers, then cleared — a
  // second registerClient with no new opens in between replays nothing.
  const pendingOpens = new Map<string, OpenArtifactWidgetFrame>()

  return {
    registerClient(clientId, send, widgets) {
      const sane = (Array.isArray(widgets) ? widgets : []).filter(
        (w): w is WidgetDirectoryEntry =>
          !!w && typeof w.kind === "string" && w.kind.length > 0 &&
          typeof w.title === "string" && typeof w.description === "string",
      )
      current = { clientId, send, widgets: sane }
      // Replay any opens that were issued while no host was connected (a Moon
      // mid-turn reconnect is the common case). Flush in issue order, then
      // clear so a later reconnect doesn't re-pop the same windows. A throwing
      // send must not abort registration — the host is still the live one.
      if (pendingOpens.size > 0) {
        const queued = Array.from(pendingOpens.values())
        pendingOpens.clear()
        for (const frame of queued) {
          try {
            send(frame)
          } catch {
            // The socket died mid-flush; the artifact remains pinned and
            // reopenable by id, so drop the replay rather than re-buffering.
          }
        }
      }
    },
    unregisterClient(clientId) {
      if (current && current.clientId === clientId) {
        current = null
      }
    },
    directory() {
      return current ? current.widgets : []
    },
    open(kind, params) {
      if (!current) {
        return {
          ok: false,
          message:
            "No widget-capable client is connected (the Luna Moon app announces its widgets when it connects).",
        }
      }
      const known = current.widgets.some((w) => w.kind === kind)
      if (!known) {
        const kinds = current.widgets.map((w) => w.kind).join(", ")
        return {
          ok: false,
          message: `Unknown widget kind "${kind}". Available: ${kinds || "(none)"}`,
        }
      }
      try {
        current.send({
          type: "widget-open",
          kind,
          ...(params && Object.keys(params).length > 0 ? { params } : {}),
        })
        return { ok: true, message: `Asked the app to open ${kind}.` }
      } catch {
        return { ok: false, message: "The widget host connection failed mid-send." }
      }
    },
    openArtifact(artifactId, title, kind) {
      const frame: OpenArtifactWidgetFrame = {
        type: "open-artifact-widget",
        artifactId,
        title,
        kind,
      }
      if (!current) {
        // No host right now (e.g. Moon mid-reconnect during a long turn). Buffer
        // the intent so the next host to announce pops it, rather than dropping
        // it silently. Dedup by id (keep the latest frame, move to newest) and
        // bound the buffer so a host that never returns can't grow it.
        pendingOpens.delete(artifactId)
        pendingOpens.set(artifactId, frame)
        while (pendingOpens.size > MAX_PENDING_OPENS) {
          const oldest = pendingOpens.keys().next().value
          if (oldest === undefined) break
          pendingOpens.delete(oldest)
        }
        return {
          ok: false,
          message:
            `No widget-capable client is connected right now — queued "${title}" ` +
            "to open as soon as the app reconnects.",
        }
      }
      try {
        current.send(frame)
        return { ok: true, message: `Asked the app to open "${title}".` }
      } catch {
        return { ok: false, message: "The widget host connection failed mid-send." }
      }
    },
  }
}
