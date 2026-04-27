/**
 * Sidebar (Solid) — list of threads with selection + new-thread button.
 *
 * Solid port of apps/ui-web/src/App.tsx Sidebar (~line 473). Same
 * structure: header with "Threads" + "+ New", then a scrollable list
 * of thread rows. The owning App is responsible for ordering the
 * threads array (server returns them sorted by lastMessageAt).
 *
 * `onNew` is nullable (mirrors React) to express "disabled" — the
 * button shows the tooltip "connect first" when null. Same wire
 * contract; no behavior drift.
 */
import { type Component, For, Show } from "solid-js"
import {
  deriveTitle,
  relativeTime,
  type SessionSummary,
  type ThreadView,
} from "@luna/ui-shared/core"

export interface SidebarProps {
  readonly threads: ReadonlyArray<SessionSummary>
  readonly threadViews: ReadonlyMap<string, ThreadView>
  readonly selectedId: string | null
  readonly onSelect: (id: string) => void
  readonly onNew: (() => void) | null
}

export const Sidebar: Component<SidebarProps> = (props) => {
  return (
    <aside class="sidebar">
      <div class="sidebar-head">
        <span>Threads</span>
        <button
          onClick={() => props.onNew?.()}
          disabled={props.onNew === null}
          title={props.onNew === null ? "connect first" : "new thread"}
        >
          + New
        </button>
      </div>
      <div class="sidebar-list">
        <Show when={props.threads.length === 0}>
          <div class="sidebar-empty">
            <p class="muted">No threads yet.</p>
            <Show when={props.onNew !== null}>
              <button onClick={() => props.onNew?.()} class="chip primary">
                Start your first thread
              </button>
            </Show>
          </div>
        </Show>
        <For each={props.threads}>
          {(t) => {
            const title = deriveTitle(t, props.threadViews.get(t.id))
            return (
              <button
                class={`thread-row ${props.selectedId === t.id ? "selected" : ""}`}
                onClick={() => props.onSelect(t.id)}
              >
                <div class="thread-title">
                  <Show when={title} fallback={<em class="muted">untitled</em>}>
                    {title}
                  </Show>
                </div>
                <Show
                  when={
                    t.lastMessagePreview && title !== t.lastMessagePreview
                  }
                >
                  <div class="thread-preview">{t.lastMessagePreview}</div>
                </Show>
                <div class="thread-meta">
                  <span class="muted">{t.model || "—"}</span>
                  <Show when={t.lastMessageAt !== null}>
                    <span class="muted">{relativeTime(t.lastMessageAt!)}</span>
                  </Show>
                </div>
              </button>
            )
          }}
        </For>
      </div>
    </aside>
  )
}
