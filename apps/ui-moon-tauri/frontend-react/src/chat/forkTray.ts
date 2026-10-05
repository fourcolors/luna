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
 * Every Moon window receives every update, so the switch rule is narrow:
 *  - the window must still be ON the parent thread (an intent from a thread
 *    you have since left is dropped, never a surprise navigation), and
 *  - it must be the window that clicked Continue, or (autoOpen) any window on
 *    the parent.
 * The host may still decline (`openThread` returns false), for example while
 * you are typing a draft. A declined switch becomes a "New chat ready" card
 * with an Open button, so nothing is lost and nothing moves under you.
 * The server stays the source of truth: a click only disables its button;
 * the next update redraws the card.
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
  /**
   * Switch this window to a newly created chat. `reason` says who asked:
   * "click" (Continue), "auto" (create_thread), or "open" (the ready card's
   * Open button). Return (or resolve) false to decline or on failure; the
   * tray then shows (or keeps) a ready card.
   */
  readonly openThread: (
    threadId: string,
    title: string,
    reason: "click" | "auto" | "open",
  ) => boolean | Promise<boolean>
}

interface ReadyChat {
  readonly childThreadId: string
  readonly title: string
}

const isLive = (p: ForkProposal): boolean =>
  !p.autoOpen && (p.status === "pending" || p.status === "accepting")

export function createForkTray(deps: ForkTrayDeps) {
  const byThread = new Map<string, Map<string, ForkProposal>>()
  /**
   * Proposals THIS window accepted (id -> parent thread). Only these switch on
   * a click-accept, and an entry is dropped the moment this window shows a
   * different thread, so A -> B -> A never revives a stale intent.
   */
  const acceptedHere = new Map<string, string>()
  /** Children already handled (opened or parked), so a replay never repeats. */
  const opened = new Set<string>()
  /** Declined switches, per parent thread, waiting on an Open click. */
  const ready = new Map<string, Map<string, ReadyChat>>()

  function store(p: ForkProposal): void {
    let m = byThread.get(p.parentThreadId)
    if (!m) { m = new Map(); byThread.set(p.parentThreadId, m) }
    if (isLive(p)) m.set(p.id, p)
    else m.delete(p.id)
    if (m.size === 0) byThread.delete(p.parentThreadId)
  }

  function maybeOpen(p: ForkProposal): void {
    if (p.status !== "accepted" || !p.childThreadId || opened.has(p.childThreadId)) return
    const mine = acceptedHere.delete(p.id)
    const onParent = deps.getActiveThreadId() === p.parentThreadId
    if (!onParent) return // you moved on: the new chat is in Chats, no jump
    if (!mine && p.autoOpen !== true) return
    const child = p.childThreadId
    opened.add(child)
    const park = () => {
      let m = ready.get(p.parentThreadId)
      if (!m) { m = new Map(); ready.set(p.parentThreadId, m) }
      m.set(child, { childThreadId: child, title: p.title })
      render()
    }
    const result = deps.openThread(child, p.title, mine ? "click" : "auto")
    if (result === false) park()
    else if (result !== true) void Promise.resolve(result).then((ok) => { if (!ok) park() }, park)
  }

  function dropReady(parent: string, child: string): void {
    const m = ready.get(parent)
    if (!m) return
    m.delete(child)
    if (m.size === 0) ready.delete(parent)
  }

  function renderReady(host: HTMLElement, parent: string, r: ReadyChat): void {
    // Same structure and classes as a suggestion card (see render), so the
    // tray styling covers both.
    const card = document.createElement("div")
    card.className = "fork-card fork-card-ready"
    card.dataset.childThreadId = r.childThreadId
    const text = document.createElement("div")
    text.className = "fork-card-text"
    const title = document.createElement("span")
    title.className = "fork-card-title"
    title.textContent = r.title
    title.title = r.title
    const summary = document.createElement("span")
    summary.className = "fork-card-summary"
    summary.textContent = "Created. Open it now, or find it in Chats later."
    text.append(title, summary)
    const go = document.createElement("button")
    go.type = "button"
    go.className = "fork-card-go"
    go.textContent = "Open"
    go.setAttribute("aria-label", `Open new chat: ${r.title}`)
    go.addEventListener("click", () => {
      go.disabled = true
      // Keep the card until the open actually succeeds (a pinned window opens
      // a separate window, which can fail).
      void Promise.resolve(deps.openThread(r.childThreadId, r.title, "open")).then(
        (ok) => {
          if (ok) dropReady(parent, r.childThreadId)
          render()
        },
        () => render(),
      )
    })
    const no = document.createElement("button")
    no.type = "button"
    no.className = "fork-card-dismiss"
    no.textContent = "Later"
    no.setAttribute("aria-label", `Keep ${r.title} in Chats for later`)
    no.addEventListener("click", () => {
      dropReady(parent, r.childThreadId)
      render()
    })
    const actions = document.createElement("div")
    actions.className = "fork-card-actions"
    actions.append(go, no)
    card.append(text, actions)
    host.append(card)
  }

  function render(): void {
    const host = deps.host
    if (!host) return
    const threadId = deps.getActiveThreadId()
    for (const [id, parent] of acceptedHere) if (parent !== threadId) acceptedHere.delete(id)
    const m = threadId ? byThread.get(threadId) : undefined
    const live = m ? [...m.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)) : []
    const parked = threadId ? [...(ready.get(threadId)?.values() ?? [])] : []
    host.replaceChildren()
    if (!threadId || (live.length === 0 && parked.length === 0)) {
      host.hidden = true
      return
    }
    host.hidden = false

    const header = (text: string, n: number) => {
      const head = document.createElement("div")
      head.className = "fork-tray-head"
      const headLabel = document.createElement("span")
      headLabel.textContent = text
      const count = document.createElement("span")
      count.className = "fork-tray-count"
      count.textContent = String(n)
      head.append(headLabel, count)
      host.append(head)
    }

    if (parked.length > 0) {
      header("Ready · new chat", parked.length)
      for (const r of parked) renderReady(host, threadId, r)
    }
    if (live.length > 0) header("Suggested · new chat", live.length)

    for (const p of live) {
      const card = document.createElement("div")
      card.className = "fork-card"
      card.dataset.proposalId = p.id

      const text = document.createElement("div")
      text.className = "fork-card-text"
      const title = document.createElement("span")
      title.className = "fork-card-title"
      title.textContent = p.title
      title.title = p.title
      text.append(title)
      if (p.summary && p.summary !== p.title) {
        const summary = document.createElement("span")
        summary.className = "fork-card-summary"
        summary.textContent = p.summary
        summary.title = p.summary
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
        acceptedHere.set(p.id, threadId)
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

      const actions = document.createElement("div")
      actions.className = "fork-card-actions"
      actions.append(go, no)
      card.append(text, actions)
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
    /** Test hooks. */
    _live: (threadId: string) => [...(byThread.get(threadId)?.values() ?? [])],
    _ready: (threadId: string) => [...(ready.get(threadId)?.values() ?? [])],
  }
}

export type ForkTray = ReturnType<typeof createForkTray>
