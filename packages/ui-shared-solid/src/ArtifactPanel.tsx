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
  Show,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js"
import {
  countLines,
  downloadArtifact,
  formatBytes,
  type Artifact,
  type PinnedArtifactItem,
} from "@luna/ui-shared/core"
import { CodeBlock, CodeBlockFallback, canonLang } from "./CodeBlock.jsx"

/** Normalised display shape shared between ephemeral Artifact and
 *  PinnedArtifactItem so the detail view can render either. */
interface DisplayItem {
  readonly id: string
  readonly title: string
  readonly lang: string | null
  readonly content: string
  readonly path: string | null
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
}

export const ArtifactPanel: Component<ArtifactPanelProps> = (props) => {
  const [selectedId, setSelectedId] = createSignal<string | null>(
    props.artifacts[0]?.id ?? null,
  )

  // Auto-select newest when artifacts grow or the newest artifact's
  // identity changes. Mirrors the React useEffect — only assigns when
  // there's no current selection so manual clicks stick.
  createEffect(() => {
    const last = props.artifacts[props.artifacts.length - 1]?.id ?? null
    if (last) setSelectedId((cur) => cur ?? last)
  })

  /** Set of ids that are already in the pinned list. */
  const pinnedIds = createMemo(() => new Set((props.pinned ?? []).map((p) => p.id)))

  /** Resolve the selected display item — search pinned first, then ephemeral. */
  const selected = createMemo<DisplayItem | null>(() => {
    const id = selectedId()
    // 1. Check pinned list
    const inPinned = (props.pinned ?? []).find((p) => p.id === id)
    if (inPinned) {
      return { id: inPinned.id, title: inPinned.title, lang: inPinned.lang, content: inPinned.content, path: null }
    }
    // 2. Check ephemeral list
    const inEphemeral = props.artifacts.find((a) => a.id === id)
    if (inEphemeral) {
      return { id: inEphemeral.id, title: inEphemeral.title, lang: inEphemeral.lang, content: inEphemeral.content, path: inEphemeral.path }
    }
    // 3. Fall back to newest ephemeral
    const last = props.artifacts[props.artifacts.length - 1]
    if (last) {
      return { id: last.id, title: last.title, lang: last.lang, content: last.content, path: last.path }
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

  return (
    <aside class="artifact-panel">
      <div class="artifact-head">
        <span>Artifacts</span>
        <span class="muted small">
          {(props.pinned ?? []).length + props.artifacts.length}
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
              <button
                class={`artifact-row${p.id === selected()?.id ? " selected" : ""}`}
                onClick={() => setSelectedId(p.id)}
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
              </button>
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
                <button
                  class={`artifact-row${a.id === selected()?.id ? " selected" : ""}`}
                  onClick={() => setSelectedId(a.id)}
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
                </button>
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
              <div class="artifact-content">
                <Show
                  when={selectedLang()}
                  fallback={<CodeBlockFallback source={s().content} />}
                >
                  {(lang) => <CodeBlock lang={lang()} source={s().content} />}
                </Show>
              </div>
            </div>
          )
        }}
      </Show>
    </aside>
  )
}
