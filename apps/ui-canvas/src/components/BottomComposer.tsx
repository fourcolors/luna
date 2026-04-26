import { useState } from "react"
import type { InFlightTurn } from "@experiment-agent/ui-shared"

/**
 * BottomComposer — pill-shaped input fixed to bottom-center.
 *
 * Enter alone submits; Shift+Enter inserts a newline. ⌘/Ctrl+Enter
 * also submits as a power-user alias. Stop button replaces submit
 * while a turn is streaming.
 */
export function BottomComposer({
  onSend,
  onInterrupt,
  inFlight,
  disabled,
  model,
}: {
  onSend: (text: string) => void
  onInterrupt: () => void
  inFlight: InFlightTurn | null
  disabled: boolean
  model: string
}) {
  const [draft, setDraft] = useState("")

  const submit = () => {
    const t = draft.trim()
    if (!t) return
    onSend(t)
    setDraft("")
  }

  return (
    <div className="composer-wrap">
      <div className={`composer-pill ${disabled ? "disabled" : ""}`}>
        <div className="composer-actions left">
          <button className="icon-btn ghost" disabled title="Attach (coming soon)">
            +
          </button>
          <button
            className="icon-btn ghost"
            disabled
            title="Toggle layout (coming soon)"
          >
            ▥
          </button>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            disabled
              ? "Connect to start chatting"
              : "What would you like to change or create?"
          }
          disabled={disabled}
          rows={1}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.metaKey &&
              !e.ctrlKey &&
              !e.altKey
            ) {
              e.preventDefault()
              submit()
              return
            }
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-actions right">
          <button className="icon-btn ghost" disabled title="Conversation mode (coming soon)">
            💬
          </button>
          <span className="model-pill" title="Model — change in settings">
            {model}
          </span>
          <button className="icon-btn ghost" disabled title="Voice (coming soon)">
            ☰
          </button>
          {inFlight ? (
            <button
              className="submit-btn stop"
              onClick={onInterrupt}
              title="Stop generation"
            >
              ◼
            </button>
          ) : (
            <button
              className="submit-btn"
              onClick={submit}
              disabled={disabled || !draft.trim()}
              title="Send (Enter)"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
