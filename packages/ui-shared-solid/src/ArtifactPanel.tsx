/**
 * ArtifactPanel (Solid) — sidebar listing extracted artifacts (files
 * and substantial code blocks) with a CodeBlock preview of the
 * selected one.
 *
 * Solid port of apps/ui-web/src/App.tsx ArtifactPanel (~line 885).
 *
 * Behavior parity:
 *   - Auto-select newest when artifacts grow / replace at same length:
 *     a createEffect that reads `artifacts[length-1]?.id` and only
 *     promotes selection if there's no current selection (preserves
 *     the user's manual click).
 *   - Selected falls back to the newest artifact when the explicit id
 *     is no longer in the list (e.g. server replaced it).
 *   - Download + copy actions reuse the framework-agnostic
 *     downloadArtifact helper hoisted in chunk 8a.
 *
 * PRD Part C (W1) additions:
 *   - Optional `pinned` prop renders a "📌 Pinned" section above ephemeral list.
 *   - Optional `artifactsCapable` enables pin/unpin chips on each row.
 *   - `onPin` / `onUnpin` callbacks wire up to the server frames.
 */
import {
  type Component,
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js"
import {
  countLines,
  downloadArtifact,
  formatBytes,
  type Artifact,
  type ArtifactKind,
  type ObsEvent,
  type PinnedArtifactItem,
} from "@luna/ui-shared/core"
import {
  SANDBOX_ATTR,
  buildMcpSrcdoc,
  buildSrcdoc,
  subscribeAllowed,
} from "@luna/ui-shared/widget-sandbox"
import {
  host as mcpHost,
  type McpHostHandle,
} from "@luna/ui-shared/mcp-app-host"
import { CodeBlock, CodeBlockFallback, canonLang } from "./CodeBlock.jsx"
import { MarkdownView } from "./MarkdownView.jsx"

/** The web client's MCP relay (App stamps requestId + correlates results). */
export interface WebMcpRelay {
  readonly readResource: (
    uri: string,
  ) => Promise<{ ok: boolean; mimeType?: string; text?: string; message?: string }>
  readonly callTool: (
    appUri: string,
    tool: string,
    args: unknown,
  ) => Promise<{ ok: boolean; result?: unknown; message?: string }>
}

/** Kind for an EPHEMERAL artifact (no explicit kind) from its lang/path —
 *  mirrors @luna/core deriveArtifactKind; never returns widget/mcp-app (those
 *  are explicit-only and only ever arrive on PINNED items). */
const deriveContentKind = (
  lang: string | null,
  path: string | null,
): ArtifactKind => {
  const l = (lang ?? "").toLowerCase().trim()
  const p = (path ?? "").toLowerCase().trim()
  if (l === "html" || l === "htm" || p.endsWith(".html") || p.endsWith(".htm")) {
    return "html"
  }
  if (l === "md" || l === "markdown" || p.endsWith(".md") || p.endsWith(".markdown")) {
    return "markdown"
  }
  return "code"
}

/**
 * kind="html": a static HTML PREVIEW rendered LIVE in a hard sandbox — the
 * SAME cage Moon uses (no allow-same-origin, strict CSP, no network), with NO
 * luna.* bridge (a preview has no live-data door). Solid updates `srcdoc`
 * reactively when the content changes.
 */
const HtmlPreviewFrame: Component<{ content: string; title: string }> = (props) => (
  <iframe
    class="artifact-iframe"
    title={`${props.title} (HTML preview)`}
    sandbox={SANDBOX_ATTR}
    referrerpolicy="no-referrer"
    srcdoc={buildMcpSrcdoc(props.content)}
  />
)

/**
 * The obs events to forward to a subscribed widget, given the store's
 * NEWEST-FIRST (and 500-capped) event list and the newest event already seen
 * (by IDENTITY — the store PREPENDS new events, so we can't index by position).
 * Returns the not-yet-seen events that pass the widget's cap gate, in
 * CHRONOLOGICAL (oldest-first) order — the order luna.subscribe callbacks
 * expect. Pure + exported so the forwarding logic is unit-testable in isolation
 * (it was the source of a real bug: index-based forwarding against a
 * newest-first capped array sends stale tail events, then stops at the cap).
 */
export const widgetEventsToForward = (
  events: ReadonlyArray<ObsEvent>,
  lastSeen: ObsEvent | null,
  bridgeCaps: ReadonlyArray<string> | null,
): ReadonlyArray<ObsEvent> => {
  const fresh: ObsEvent[] = []
  for (const ev of events) {
    // events is newest-first; stop at the boundary we already forwarded.
    if (ev === lastSeen) break
    fresh.push(ev)
  }
  fresh.reverse() // → oldest-first (chronological)
  return fresh.filter((ev) => subscribeAllowed(bridgeCaps, ev.kind))
}

/**
 * kind="widget": agent-authored code that EXECUTES, caged in the same sandbox
 * PLUS the luna.* bridge. The host half of that bridge lives here: accept
 * postMessages only from THIS iframe, and forward live obs events into a
 * subscribed widget — but ONLY for kinds its bridge_caps allow (fails closed
 * via subscribeAllowed). Events from subscribe-time onward only (no backlog
 * replay), mirroring Moon's widget.html host loop (which forwards per WS frame;
 * here we advance by event identity over the store's newest-first list).
 */
const LiveWidgetFrame: Component<{
  content: string
  title: string
  bridgeCaps: ReadonlyArray<string> | null
  obsEvents: () => ReadonlyArray<ObsEvent>
}> = (props) => {
  let frame: HTMLIFrameElement | undefined
  let subscribed = false
  // Newest obs event already considered for forwarding (by identity).
  let lastSeen: ObsEvent | null = null

  const onMessage = (e: MessageEvent) => {
    if (!frame || e.source !== frame.contentWindow) return
    const m = e.data as { __luna?: string } | null
    if (!m || typeof m !== "object") return
    if (m.__luna === "subscribe") {
      subscribed = true
      // Anchor at the current newest → forward only events that arrive AFTER
      // subscribe (never replay the backlog).
      lastSeen = props.obsEvents()[0] ?? null
    } else if (m.__luna === "refresh") {
      if (frame) frame.srcdoc = buildSrcdoc(props.content)
    }
  }

  onMount(() => window.addEventListener("message", onMessage))
  onCleanup(() => window.removeEventListener("message", onMessage))

  // Forward newly-arrived obs events to a subscribed widget, cap-gated and in
  // chronological order. The store prepends + caps, so advance by IDENTITY.
  createEffect(() => {
    const events = props.obsEvents()
    if (!subscribed || !frame || !frame.contentWindow) return
    for (const ev of widgetEventsToForward(events, lastSeen, props.bridgeCaps)) {
      frame.contentWindow.postMessage({ __luna: "event", event: ev }, "*")
    }
    if (events.length > 0) lastSeen = events[0]!
  })

  return (
    <iframe
      ref={frame}
      class="artifact-iframe"
      title={`${props.title} (widget)`}
      sandbox={SANDBOX_ATTR}
      referrerpolicy="no-referrer"
      srcdoc={buildSrcdoc(props.content)}
    />
  )
}

/**
 * kind="mcp-app": a LIVE MCP App. Mounted in the same sandbox cage; the shared
 * LunaMcpHost drives the JSON-RPC handshake and routes tools/call over the web
 * MCP relay (props.mcp → WS frames, server-enforced same-server + curated
 * allowlist). Generated/store-backed apps store inline HTML (mounted directly);
 * a `ui://` pointer is fetched via readResource. Re-hosts on content/id change.
 */
const McpAppFrame: Component<{
  content: string
  title: string
  artifactId: string
  mcp: WebMcpRelay
}> = (props) => {
  let frame: HTMLIFrameElement | undefined
  let handle: McpHostHandle | null = null

  createEffect(() => {
    const content = props.content
    const artifactId = props.artifactId
    if (!frame) return
    handle?.dispose()
    const trimmed = content.trim()
    const isPointer = /^ui:\/\//i.test(trimmed)
    const appUri = isPointer
      ? trimmed
      : "ui://luna/app/" + encodeURIComponent(artifactId)
    handle = mcpHost({
      frameEl: frame,
      uri: appUri,
      html: isPointer ? null : content,
      transport: {
        readResource: (uri) => props.mcp.readResource(uri),
        callTool: (tool, args) => props.mcp.callTool(appUri, tool, args),
      },
    })
  })

  onCleanup(() => handle?.dispose())

  return (
    <iframe
      ref={frame}
      class="artifact-iframe"
      title={`${props.title} (app)`}
      sandbox={SANDBOX_ATTR}
      referrerpolicy="no-referrer"
    />
  )
}

/** Normalised display shape shared between ephemeral Artifact and
 *  PinnedArtifactItem so the detail view can render either. */
interface DisplayItem {
  readonly id: string
  readonly title: string
  readonly lang: string | null
  readonly content: string
  readonly path: string | null
  /** Drives kind-aware rendering: code→highlight, markdown→formatted,
   *  html→sandboxed preview, widget→sandboxed iframe + luna.* bridge. */
  readonly kind: ArtifactKind
  /** Widget-only luna.* obs-event allowlist (null for every other kind). */
  readonly bridgeCaps: ReadonlyArray<string> | null
}

export interface ArtifactPanelProps {
  readonly artifacts: ReadonlyArray<Artifact>
  /** PRD Part C / W1 — durable pinned artifacts from server state. */
  readonly pinned?: ReadonlyArray<PinnedArtifactItem>
  /** When true the server supports artifact-pin/unpin frames. */
  readonly artifactsCapable?: boolean
  /** Called when the user clicks the pin chip on an ephemeral artifact. */
  readonly onPin?: (a: Artifact) => void
  /** Called when the user clicks the unpin chip on a pinned artifact. */
  readonly onUnpin?: (id: string) => void
  /** Agent-driven focus (an `open-artifact-widget` frame): select + preview
   *  this artifact. The nonce re-triggers selection even for the same id. */
  readonly focusSignal?: { readonly id: string; readonly nonce: number } | null
  /** Live obs-event stream forwarded (cap-gated) into a kind="widget" iframe.
   *  Omit on surfaces without an event stream — widgets then render static. */
  readonly obsEvents?: ReadonlyArray<ObsEvent>
  /** MCP relay for kind="mcp-app" artifacts. Present only when the server
   *  advertises the mcpApps capability; absent → mcp-apps render as source.
   *  `| undefined` is explicit so callers may pass it conditionally under
   *  exactOptionalPropertyTypes. */
  readonly mcp?: WebMcpRelay | undefined
}

export const ArtifactPanel: Component<ArtifactPanelProps> = (props) => {
  const [selectedId, setSelectedId] = createSignal<string | null>(
    // Seed from the newest ephemeral, else the first pin — so a pins-only
    // panel (a reopened session whose only artifacts are durable) previews
    // something on mount instead of a blank detail area (review W1/web).
    props.artifacts[0]?.id ?? props.pinned?.[0]?.id ?? null,
  )

  // Auto-select newest when artifacts grow or the newest artifact's
  // identity changes. Mirrors the React useEffect — only assigns when
  // there's no current selection so manual clicks stick. Falls back to the
  // first pin when there is no ephemeral artifact (the pins-only case).
  createEffect(() => {
    const last =
      props.artifacts[props.artifacts.length - 1]?.id ??
      props.pinned?.[0]?.id ??
      null
    if (last) setSelectedId((cur) => cur ?? last)
  })

  // Agent-driven focus: an `open-artifact-widget` frame selects the named
  // artifact (overriding the user's current pick — it was an explicit request).
  // `selected()` self-heals if the id isn't in the list yet: a just-pinned
  // artifact whose artifact-list broadcast lands a tick later resolves once it
  // arrives, because the memo re-runs over props.pinned.
  createEffect(() => {
    const f = props.focusSignal
    if (f && f.id) setSelectedId(f.id)
  })

  /** Set of ids that are already in the pinned list. */
  const pinnedIds = createMemo(() => new Set((props.pinned ?? []).map((p) => p.id)))

  /** Resolve the selected display item. Search EPHEMERAL first so an
   *  in-session artifact that is also pinned (same id in both lists) keeps
   *  its richer `path`/provenance — and so this stays consistent with
   *  `artifactForDownload`, which also searches ephemeral first (review
   *  W1/web). Falls back to newest ephemeral, then first pin. */
  const selected = createMemo<DisplayItem | null>(() => {
    const id = selectedId()
    const inEphemeral = props.artifacts.find((a) => a.id === id)
    if (inEphemeral) {
      return { id: inEphemeral.id, title: inEphemeral.title, lang: inEphemeral.lang, content: inEphemeral.content, path: inEphemeral.path, kind: deriveContentKind(inEphemeral.lang, inEphemeral.path), bridgeCaps: null }
    }
    const inPinned = (props.pinned ?? []).find((p) => p.id === id)
    if (inPinned) {
      return { id: inPinned.id, title: inPinned.title, lang: inPinned.lang, content: inPinned.content, path: null, kind: inPinned.kind, bridgeCaps: inPinned.bridgeCaps ?? null }
    }
    const last = props.artifacts[props.artifacts.length - 1]
    if (last) {
      return { id: last.id, title: last.title, lang: last.lang, content: last.content, path: last.path, kind: deriveContentKind(last.lang, last.path), bridgeCaps: null }
    }
    const firstPin = (props.pinned ?? [])[0]
    if (firstPin) {
      return { id: firstPin.id, title: firstPin.title, lang: firstPin.lang, content: firstPin.content, path: null, kind: firstPin.kind, bridgeCaps: firstPin.bridgeCaps ?? null }
    }
    return null
  })

  const selectedLang = createMemo(() => {
    const s = selected()
    return s ? canonLang(s.lang) : null
  })

  /** Synthesise an Artifact-shaped object from a PinnedArtifactItem for
   *  downloadArtifact (which needs source + path). */
  const pinnedToArtifact = (p: PinnedArtifactItem): Artifact => ({
    id: p.id,
    source: "code-fence",
    path: null,
    lang: p.lang,
    title: p.title,
    content: p.content,
  })

  const hasPins = createMemo(
    () => props.artifactsCapable === true && (props.pinned ?? []).length > 0,
  )

  // Rows are <div role="button"> (not <button>) so the pin/unpin chips —
  // themselves <button>s — are valid children (a button may not nest a
  // button; review W1/web). Keyboard activation restores the button a11y.
  const activateOnKey = (fn: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      fn()
    }
  }

  return (
    <aside class="artifact-panel">
      <div class="artifact-head">
        <span>Artifacts</span>
        <span class="muted small">
          {/* Distinct ids — an in-session artifact that is also pinned shares
              its id across both lists and must not be counted twice. */}
          {
            new Set([
              ...(props.pinned ?? []).map((p) => p.id),
              ...props.artifacts.map((a) => a.id),
            ]).size
          }
        </span>
      </div>

      {/* ── Pinned section ── */}
      <Show when={hasPins()}>
        <div class="artifact-head" style={{ "font-size": "0.75rem", "padding-top": "0.25rem" }}>
          <span>📌 Pinned</span>
          <span class="muted small">{(props.pinned ?? []).length}</span>
        </div>
        <div class="artifact-list">
          <For each={props.pinned ?? []}>
            {(p) => (
              <div
                class={`artifact-row${p.id === selected()?.id ? " selected" : ""}`}
                role="button"
                tabindex={0}
                onClick={() => setSelectedId(p.id)}
                onKeyDown={activateOnKey(() => setSelectedId(p.id))}
              >
                <div class="artifact-title">📌 {p.title}</div>
                <div class="artifact-meta muted small">
                  {p.kind} · v{p.version} · {formatBytes(p.content.length)}
                </div>
                <Show when={props.artifactsCapable === true}>
                  <button
                    class="chip muted small"
                    style={{ "margin-top": "0.15rem" }}
                    onClick={(e) => { e.stopPropagation(); props.onUnpin?.(p.id) }}
                    title="Unpin artifact"
                  >
                    unpin
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* ── Ephemeral (this session) section ── */}
      <Show when={props.artifacts.length > 0}>
        <Show when={hasPins()}>
          <div class="artifact-head" style={{ "font-size": "0.75rem", "padding-top": "0.25rem" }}>
            <span>This session</span>
            <span class="muted small">{props.artifacts.length}</span>
          </div>
        </Show>
        <div class="artifact-list">
          <For each={props.artifacts}>
            {(a) => {
              const lines = countLines(a.content)
              const alreadyPinned = createMemo(() => pinnedIds().has(a.id))
              return (
                <div
                  class={`artifact-row${a.id === selected()?.id ? " selected" : ""}`}
                  role="button"
                  tabindex={0}
                  onClick={() => setSelectedId(a.id)}
                  onKeyDown={activateOnKey(() => setSelectedId(a.id))}
                >
                  <div class="artifact-title">
                    {a.source === "tool-write" ? "📄" : "📝"} {a.title}
                  </div>
                  <div class="artifact-meta muted small">
                    {a.source === "tool-write" ? a.path : (a.lang ?? "code")} ·{" "}
                    {lines} {lines === 1 ? "line" : "lines"} ·{" "}
                    {formatBytes(a.content.length)}
                  </div>
                  <Show when={props.artifactsCapable === true}>
                    <Show
                      when={!alreadyPinned()}
                      fallback={
                        <span
                          class="chip muted small"
                          style={{ "margin-top": "0.15rem", cursor: "default" }}
                        >
                          📌 pinned
                        </span>
                      }
                    >
                      <button
                        class="chip small"
                        style={{ "margin-top": "0.15rem" }}
                        onClick={(e) => { e.stopPropagation(); props.onPin?.(a) }}
                        title="Pin artifact"
                      >
                        📌 pin
                      </button>
                    </Show>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>

      {/* ── Detail view ── */}
      <Show when={selected()}>
        {(s) => {
          // For download we need a full Artifact — find it in ephemeral or
          // synthesise from the pinned list.
          const artifactForDownload = createMemo<Artifact>(() => {
            const found = props.artifacts.find((a) => a.id === s().id)
            if (found) return found
            const pin = (props.pinned ?? []).find((p) => p.id === s().id)
            if (pin) return pinnedToArtifact(pin)
            // Fallback: reconstruct from display item
            return {
              id: s().id,
              source: "code-fence" as const,
              path: s().path,
              lang: s().lang,
              title: s().title,
              content: s().content,
            }
          })
          return (
            <div class="artifact-view">
              <div class="artifact-view-head">
                <span class="small" title={s().path ?? undefined}>
                  {s().path ?? s().title}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  class="chip"
                  onClick={() => downloadArtifact(artifactForDownload())}
                  title="Download as file"
                >
                  ⬇ download
                </button>
                <button
                  class="chip"
                  onClick={() => {
                    navigator.clipboard?.writeText(s().content).catch(() => {
                      // ignore — clipboard unavailable or denied
                    })
                  }}
                  title="Copy to clipboard"
                >
                  ⧉ copy
                </button>
              </div>
              {/* Kind-aware render. Rich kinds (markdown/html/widget) get the
                  `is-rich` modifier so the code-oriented dark/pre/mono base is
                  reset. code + mcp-app fall through to the source view (mcp-app
                  gets a live host in a follow-up); html/widget run sandboxed. */}
              <div
                class={`artifact-content${
                  s().kind === "markdown" ||
                  s().kind === "html" ||
                  s().kind === "widget" ||
                  (s().kind === "mcp-app" && props.mcp !== undefined)
                    ? " is-rich"
                    : ""
                }`}
              >
                <Switch
                  fallback={
                    <Show
                      when={selectedLang()}
                      fallback={<CodeBlockFallback source={s().content} />}
                    >
                      {(lang) => <CodeBlock lang={lang()} source={s().content} />}
                    </Show>
                  }
                >
                  <Match when={s().kind === "markdown"}>
                    <MarkdownView text={s().content} />
                  </Match>
                  <Match when={s().kind === "html"}>
                    <HtmlPreviewFrame content={s().content} title={s().title} />
                  </Match>
                  <Match when={s().kind === "widget"}>
                    <LiveWidgetFrame
                      content={s().content}
                      title={s().title}
                      bridgeCaps={s().bridgeCaps}
                      obsEvents={() => props.obsEvents ?? []}
                    />
                  </Match>
                  <Match when={s().kind === "mcp-app" && props.mcp}>
                    {(mcp) => (
                      <McpAppFrame
                        content={s().content}
                        title={s().title}
                        artifactId={s().id}
                        mcp={mcp()}
                      />
                    )}
                  </Match>
                </Switch>
              </div>
            </div>
          )
        }}
      </Show>
    </aside>
  )
}
