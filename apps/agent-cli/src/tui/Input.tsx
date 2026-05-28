import { onMount } from "solid-js"
import type { TuiStore } from "./store.js"
import {
  defaultTextareaKeyBindings,
  type KeyBinding,
  type TextareaRenderable,
} from "@opentui/core"

// Vim-style green block cursor + prompt prefix.
const CURSOR_COLOR = "#00FF87"

export type InputProps = {
  store: TuiStore
  onSubmit: (text: string) => void
}

// Chat-style key handling: plain Enter submits, Shift+Enter inserts a newline.
// OpenTUI's default textarea bindings do the opposite (Enter = newline,
// Meta+Enter = submit), so we override the relevant entries.
const chatKeyBindings: KeyBinding[] = [
  ...defaultTextareaKeyBindings.filter(
    (b) => !((b.name === "return" || b.name === "kpenter") && b.shift !== true),
  ),
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
]

// The textarea owns the edit buffer. `onContentChange` fires with a
// ContentChangeEvent (an object, NOT the text), so we read the current text
// from the renderable's `plainText` getter via a ref. We mirror it into the
// store's inputDraft only so the SlashMenu can react to the leading "/".
export const Input = (props: InputProps) => {
  let textarea: TextareaRenderable | undefined

  const syncDraft = (): void => {
    props.store.setInputDraft(textarea?.plainText ?? "")
  }

  const submit = (): void => {
    const v = textarea?.plainText ?? ""
    textarea?.clear()
    props.store.setInputDraft("")
    props.onSubmit(v)
  }

  // The textarea cursor is block-by-default but only shows when focused; the
  // `focused` prop alone proved unreliable, so claim focus imperatively and
  // pin a visible block cursor once the renderable is mounted.
  onMount(() => {
    if (textarea === undefined) return
    textarea.focus()
    textarea.cursorStyle = { style: "block", blinking: true }
    textarea.cursorColor = CURSOR_COLOR
  })

  return (
    <box style={{ borderStyle: "single", flexShrink: 0, minHeight: 3, flexDirection: "row" }}>
      <text style={{ fg: CURSOR_COLOR }}>{"> "}</text>
      <textarea
        ref={(el: TextareaRenderable) => { textarea = el }}
        focused
        style={{ flexGrow: 1 }}
        keyBindings={chatKeyBindings}
        placeholder="Type a message — Enter to send, Shift+Enter for newline"
        onContentChange={syncDraft}
        onSubmit={submit}
      />
    </box>
  )
}
