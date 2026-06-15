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

export const createWidgetSummonBridge = (): WidgetSummonBridge => {
  let current: Registrant | null = null

  return {
    registerClient(clientId, send, widgets) {
      const sane = (Array.isArray(widgets) ? widgets : []).filter(
        (w): w is WidgetDirectoryEntry =>
          !!w && typeof w.kind === "string" && w.kind.length > 0 &&
          typeof w.title === "string" && typeof w.description === "string",
      )
      current = { clientId, send, widgets: sane }
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
      if (!current) {
        return {
          ok: false,
          message:
            "No widget-capable client is connected (the Luna Moon app opens artifact windows when it connects).",
        }
      }
      try {
        current.send({
          type: "open-artifact-widget",
          artifactId,
          title,
          kind,
        })
        return { ok: true, message: `Asked the app to open "${title}".` }
      } catch {
        return { ok: false, message: "The widget host connection failed mid-send." }
      }
    },
  }
}
