/**
 * forkTray.ts - new-chat suggestions above the composer, and the switch to a
 * chat the agent created.
 *
 * Two server features share the fork-proposal frames:
 *
 *  - `fork_thread` stages a PENDING marker. This tray draws it as a card with
 *    Continue and Dismiss. Continue sends `fork-proposal-respond` (accept);
 *    the server creates the chat and broadcasts the proposal as `accepted`
 *    with its `childThreadId`. This window then switches to that chat.
 *  - `create_thread` stages a proposal with `autoOpen: true` that the server
 *    accepts at once. It is never drawn. When it arrives `accepted`, the
 *    window that is viewing the parent thread switches to the new chat.
 *
 * Every Moon window receives every update, so the switch rule is narrow: only
 * the window that clicked Continue, or (for autoOpen) the window currently on
 * the parent thread, switches. The server stays the source of truth: a click
 * only disables its button; the next update redraws the card.
 */

export interface ForkProposal {
  readonly id: string
  readonly parentThreadId: string
  readonly title: string
  readonly summary: string
  readonly status: "pending" | "accepting" | "accepted" | "dismissed"
  readonly createdAt?: number
  readonly childThreadId?: string
  readonly autoOpen?: boolean
}

export interface ForkTrayDeps {
  /** The tray host element (`#fork-tray`). Null renders nothing. */
  readonly host: HTMLElement | null
  readonly getActiveThreadId: () => string | null | undefined
  readonly send: (frame: {
    readonly type: "fork-proposal-respond"
    readonly threadId: string
    readonly proposalId: string
    readonly decision: "accept" | "dismiss"
  }) => void
  /** Switch this window to a newly created chat. */
  readonly openThread: (threadId: string, title: string) => void
}

const isLive = (p: ForkProposal): boolean =>
  !p.autoOpen && (p.status === "pending" || p.status === "accepting")

export function createForkTray(deps: ForkTrayDeps) {
  const byThread = new Map<string, Map<string, ForkProposal>>()
  /** Proposals THIS window accepted; only these switch on a click-accept. */
  const acceptedHere = new Set<string>()
  /** Children already opened, so a replayed update never switches twice. */
  const opened = new Set<string>()

  function store(p: ForkProposal): void {
    let m = byThread.get(p.parentThreadId)
    if (!m) { m = new Map(); byThread.set(p.parentThreadId, m) }
    if (isLive(p)) m.set(p.id, p)
    else m.delete(p.id)
    if (m.size === 0) byThread.delete(p.parentThreadId)
  }

  function maybeOpen(p: ForkProposal): void {
    if (p.status !== "accepted" || !p.childThreadId || opened.has(p.childThreadId)) return
    const mine = acceptedHere.has(p.id)
    const auto = p.autoOpen === true && deps.getActiveThreadId() === p.parentThreadId
    if (!mine && !auto) return
    acceptedHere.delete(p.id)
    opened.add(p.childThreadId)
    deps.openThread(p.childThreadId, p.title)
  }

  function render(): void {
    const host = deps.host
    if (!host) return
    const threadId = deps.getActiveThreadId()
    const m = threadId ? byThread.get(threadId) : undefined
    const live = m ? [...m.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)) : []
    host.replaceChildren()
    if (!threadId || live.length === 0) {
      host.hidden = true
      return
    }
    host.hidden = false
    for (const p of live) {
      const card = document.createElement("div")
      card.className = "fork-card"
      card.dataset.proposalId = p.id

      const text = document.createElement("div")
      text.className = "fork-card-text"
      const label = document.createElement("span")
      label.className = "fork-card-label"
      label.textContent = "Suggested new chat"
      const title = document.createElement("span")
      title.className = "fork-card-title"
      title.textContent = p.title
      text.append(label, title)
      if (p.summary && p.summary !== p.title) {
        const summary = document.createElement("span")
        summary.className = "fork-card-summary"
        summary.textContent = p.summary
        text.append(summary)
      }

      const busy = p.status === "accepting"
      const go = document.createElement("button")
      go.type = "button" // inside the composer <form>: never submit
      go.className = "fork-card-go"
      go.textContent = busy ? "Opening…" : "Continue"
      go.disabled = busy
      go.setAttribute("aria-label", `Open new chat: ${p.title}`)
      go.addEventListener("click", () => {
        go.disabled = true
        go.textContent = "Opening…"
        acceptedHere.add(p.id)
        deps.send({ type: "fork-proposal-respond", threadId, proposalId: p.id, decision: "accept" })
      })

      const no = document.createElement("button")
      no.type = "button"
      no.className = "fork-card-dismiss"
      no.textContent = "Dismiss"
      no.disabled = busy
      no.setAttribute("aria-label", `Dismiss suggested chat: ${p.title}`)
      no.addEventListener("click", () => {
        no.disabled = true
        deps.send({ type: "fork-proposal-respond", threadId, proposalId: p.id, decision: "dismiss" })
      })

      card.append(text, go, no)
      host.append(card)
    }
  }

  return {
    /** Server `fork-proposal-set`: the pending list for one thread (on subscribe). */
    applySet(frame: { readonly threadId?: string; readonly proposals?: ReadonlyArray<ForkProposal> }): void {
      if (!frame || !frame.threadId) return
      byThread.delete(frame.threadId)
      for (const p of Array.isArray(frame.proposals) ? frame.proposals : []) {
        if (p && p.id) store({ ...p, parentThreadId: p.parentThreadId || frame.threadId })
      }
      render()
    },
    /** Server `fork-proposal-update`: one proposal changed. */
    applyUpdate(frame: { readonly threadId?: string; readonly proposal?: ForkProposal }): void {
      const p = frame && frame.proposal
      if (!p || !p.id) return
      const row = { ...p, parentThreadId: p.parentThreadId || frame.threadId || "" }
      if (!row.parentThreadId) return
      store(row)
      maybeOpen(row)
      render()
    },
    /** Redraw for the current active thread (call on thread switch). */
    render,
    /** Test hook. */
    _live: (threadId: string) => [...(byThread.get(threadId)?.values() ?? [])],
  }
}

export type ForkTray = ReturnType<typeof createForkTray>
