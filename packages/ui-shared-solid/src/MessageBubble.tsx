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
import { type Component, For, Show, createSignal } from "solid-js"
import type { ChatMessage } from "@luna/ui-shared/core"
import { MarkdownView } from "./MarkdownView.jsx"
import { ToolCallGroup } from "./ToolCallGroup.jsx"

/** Two overlapping squares — the conventional copy glyph. */
const CopyIcon: Component = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

/** Checkmark shown briefly after a successful copy. */
const CheckIcon: Component = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

export const MessageBubble: Component<{ message: ChatMessage }> = (props) => {
  const [copied, setCopied] = createSignal(false)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.message.text)
      setCopied(true)
      // Revert the checkmark back to the copy glyph after a short beat.
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard write can reject (permissions, insecure context).
      // Swallow — there's no useful recovery and no UI to surface it.
    }
  }

  return (
    <div class={`bubble ${props.message.role}`}>
      <Show when={props.message.text}>
        <button
          class="bubble-copy"
          onClick={copy}
          title={copied() ? "Copied!" : "Copy message"}
          aria-label={copied() ? "Copied" : "Copy message"}
        >
          <Show when={copied()} fallback={<CopyIcon />}>
            <CheckIcon />
          </Show>
        </button>
      </Show>
      <div class="bubble-role">{props.message.role}</div>
      {/* "From a background task" chip (#124) — assistant turns that were
          delivered by a background/accepted job carry `message.delivery`.
          Rendered off the message field so it shows for BOTH live
          (assistant-done) and replayed (thread-snapshot) messages. Uses
          delivery.label when present, else a generic fallback. */}
      <Show when={props.message.delivery}>
        {(delivery) => (
          <div class="bubble-delivery" title="Delivered by a background task">
            <span class="bubble-delivery-glyph" aria-hidden="true">
              ↩
            </span>
            <Show
              when={delivery().label}
              fallback={<span>from a background task</span>}
            >
              {(label) => (
                <span>
                  from “<span class="bubble-delivery-label">{label()}</span>”
                </span>
              )}
            </Show>
          </div>
        )}
      </Show>
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
