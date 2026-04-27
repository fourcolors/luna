/**
 * MessageBubble (Solid) — renders a single ChatMessage.
 *
 * Mirrors apps/ui-web's React MessageBubble (line ~874):
 *   - assistant: GFM markdown via MarkdownView (Shiki-highlighted fences)
 *   - user: plain text + image attachment thumbnails (data:base64)
 *   - any role with toolUses → collapsible ToolCallGroup
 *
 * No Suspense wrapper here (Solid loads MarkdownView eagerly via the
 * package barrel — code-splitting can be added with `lazy()` from
 * `solid-js` when chunk 13 measures bundle size).
 */
import { type Component, For, Show } from "solid-js"
import type { ChatMessage } from "@luna/ui-shared/core"
import { MarkdownView } from "./MarkdownView.jsx"
import { ToolCallGroup } from "./ToolCallGroup.jsx"

export const MessageBubble: Component<{ message: ChatMessage }> = (props) => {
  return (
    <div class={`bubble ${props.message.role}`}>
      <div class="bubble-role">{props.message.role}</div>
      <Show
        when={props.message.role === "assistant"}
        fallback={
          <>
            <Show when={props.message.attachments.length > 0}>
              <div class="bubble-attachments">
                <For each={props.message.attachments}>
                  {(a, i) => (
                    <img
                      class="bubble-attach-img"
                      src={`data:${a.mediaType};base64,${a.data}`}
                      alt={`attachment ${i() + 1}`}
                    />
                  )}
                </For>
              </div>
            </Show>
            <Show when={props.message.text}>
              <div class="bubble-text">{props.message.text}</div>
            </Show>
          </>
        }
      >
        <MarkdownView text={props.message.text} />
      </Show>
      <Show when={props.message.toolUses.length > 0}>
        <ToolCallGroup toolUses={props.message.toolUses} />
      </Show>
    </div>
  )
}
