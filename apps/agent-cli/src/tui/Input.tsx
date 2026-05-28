import type { TuiStore } from "./store.js"
import type { TextareaProps } from "@opentui/solid"
import { defaultTextareaKeyBindings, type KeyBinding } from "@opentui/core"

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

// NOTE: the OpenTUI/solid types declare TextareaProps.onContentChange as
// (value: string) => void, but it intersects with the underlying
// EditBufferOptions.onContentChange of (event: ContentChangeEvent) => void,
// producing an impossible intersection type. At runtime the textarea emits the
// "change" event with the current text value (a string), so we type the handler
// against that runtime-correct shape and assert it onto the prop.
type ContentChangeHandler = (value: string) => void
type TextareaContentChangeProp = TextareaProps["onContentChange"]

export const Input = (props: InputProps) => {
  const handleContentChange: ContentChangeHandler = (value) => {
    props.store.setInputDraft(value)
  }

  return (
    <box style={{ borderStyle: "single", flexShrink: 0, minHeight: 3 }}>
      <textarea
        focused
        keyBindings={chatKeyBindings}
        placeholder="Type a message — Enter to send, Shift+Enter for newline"
        onContentChange={handleContentChange as unknown as TextareaContentChangeProp}
        onSubmit={() => {
          const v = props.store.inputDraft()
          props.store.setInputDraft("")
          props.onSubmit(v)
        }}
      />
    </box>
  )
}
