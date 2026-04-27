/**
 * ToolCallGroup (Solid) — collapsible list of ChatToolUse cards.
 *
 * Mirrors apps/ui-web's React ToolCallGroup (line ~833): a single
 * toggle button reveals each tool's name + JSON-stringified input.
 */
import { type Component, For, Show, createSignal } from "solid-js"
import type { ChatToolUse } from "@luna/ui-shared/core"

const stringifyInput = (input: unknown): string => {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

export const ToolCallGroup: Component<{
  toolUses: ReadonlyArray<ChatToolUse>
}> = (props) => {
  const [open, setOpen] = createSignal(false)

  return (
    <Show when={props.toolUses.length > 0}>
      <div class="tool-group">
        <button
          class={`tool-group-toggle${open() ? " open" : ""}`}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open()}
        >
          <span class="tool-group-chevron">{open() ? "▾" : "▸"}</span>
          {props.toolUses.length === 1
            ? `🛠 ${props.toolUses[0]!.name}`
            : `🛠 ${props.toolUses.length} tool calls`}
        </button>
        <Show when={open()}>
          <div class="tool-group-body">
            <For each={props.toolUses}>
              {(tu) => (
                <div class="tool-card">
                  <div class="tool-card-name">{tu.name}</div>
                  <pre class="tool-card-input">{stringifyInput(tu.input)}</pre>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}
