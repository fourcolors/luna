/**
 * queueTray.ts - the "Queued" tray above the composer (Queue + Steer).
 *
 * A message sent while Luna is mid-turn waits on the server and runs after
 * the turn ends. The server lists the waiting messages in `queue-update`
 * frames; this tray draws them, each with a Steer button that sends a
 * `steer` frame to push that message into the running turn now.
 *
 * The server is the only source of truth. The tray never adds or removes
 * rows on its own: a Steer click only disables its button, and the
 * `queue-update` that follows redraws the list. Every open Moon window
 * therefore shows the same queue.
 *
 * Per-thread lists are kept so a background thread's queue is ready when
 * the operator switches to it. A `thread-snapshot` clears that thread's list
 * (the server re-sends `queue-update` after the snapshot only when something
 * is waiting).
 */

export interface QueuedMessage {
  readonly userMessageId: string
  readonly text: string
}

export interface QueueTrayDeps {
  /** The tray host element (`#queue-tray`). Null renders nothing. */
  readonly host: HTMLElement | null
  readonly getActiveThreadId: () => string | null | undefined
  /** Sends a client frame over the WebSocket. */
  readonly send: (frame: {
    readonly type: "steer"
    readonly threadId: string
    readonly userMessageId: string
  }) => void
}

export function createQueueTray(deps: QueueTrayDeps) {
  const byThread = new Map<string, ReadonlyArray<QueuedMessage>>()

  function render(): void {
    const host = deps.host
    if (!host) return
    const threadId = deps.getActiveThreadId()
    const queued = (threadId && byThread.get(threadId)) || []
    host.replaceChildren()
    if (!threadId || queued.length === 0) {
      host.hidden = true
      return
    }
    host.hidden = false

    const head = document.createElement("div")
    head.className = "queue-tray-head"
    const label = document.createElement("span")
    label.textContent = "Queued · runs after this turn"
    const count = document.createElement("span")
    count.className = "queue-tray-count"
    count.textContent = String(queued.length)
    head.append(label, count)
    host.append(head)

    for (const q of queued) {
      const row = document.createElement("div")
      row.className = "queue-tray-item"
      row.dataset.userMessageId = q.userMessageId

      const text = document.createElement("span")
      text.className = "queue-tray-text"
      text.textContent = q.text
      text.title = q.text

      const steer = document.createElement("button")
      steer.type = "button" // inside the composer <form>: never submit
      steer.className = "queue-tray-steer"
      steer.textContent = "Steer ↗"
      steer.title = "Send this into the running turn now"
      steer.setAttribute("aria-label", `Steer now: ${q.text}`)
      steer.addEventListener("click", () => {
        steer.disabled = true
        steer.textContent = "Steering…"
        deps.send({ type: "steer", threadId, userMessageId: q.userMessageId })
      })

      row.append(text, steer)
      host.append(row)
    }
  }

  return {
    /** Apply a server `queue-update` frame. */
    applyUpdate(frame: {
      readonly threadId?: string
      readonly queued?: ReadonlyArray<QueuedMessage>
    }): void {
      if (!frame || !frame.threadId) return
      const queued = Array.isArray(frame.queued) ? frame.queued : []
      if (queued.length === 0) byThread.delete(frame.threadId)
      else byThread.set(frame.threadId, queued)
      render()
    },
    /** A snapshot replaces the thread's state; its queue starts empty. */
    clearThread(threadId: string | undefined): void {
      if (threadId) byThread.delete(threadId)
      render()
    },
    /** Redraw for the current active thread (call on thread switch). */
    render,
    /** Test hook. */
    _queued: (threadId: string) => byThread.get(threadId) || [],
  }
}

export type QueueTray = ReturnType<typeof createQueueTray>
