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
} from "@luna/ui-shared/core"
import { CodeBlock, CodeBlockFallback, canonLang } from "./CodeBlock.jsx"

export interface ArtifactPanelProps {
  readonly artifacts: ReadonlyArray<Artifact>
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

  const selected = createMemo<Artifact | null>(() => {
    const id = selectedId()
    return (
      props.artifacts.find((a) => a.id === id) ??
      props.artifacts[props.artifacts.length - 1] ??
      null
    )
  })

  const selectedLang = createMemo(() => {
    const s = selected()
    return s ? canonLang(s.lang) : null
  })

  return (
    <aside class="artifact-panel">
      <div class="artifact-head">
        <span>Artifacts</span>
        <span class="muted small">{props.artifacts.length}</span>
      </div>
      <div class="artifact-list">
        <For each={props.artifacts}>
          {(a) => {
            const lines = countLines(a.content)
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
              </button>
            )
          }}
        </For>
      </div>
      <Show when={selected()}>
        {(s) => (
          <div class="artifact-view">
            <div class="artifact-view-head">
              <span class="small" title={s().path ?? undefined}>
                {s().path ?? s().title}
              </span>
              <span style={{ flex: 1 }} />
              <button
                class="chip"
                onClick={() => downloadArtifact(s())}
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
        )}
      </Show>
    </aside>
  )
}
