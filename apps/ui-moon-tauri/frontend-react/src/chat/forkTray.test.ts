/**
 * forkTray.test.ts - fork_thread markers render as cards for the active
 * thread; Continue/Dismiss send fork-proposal-respond; and the window switches
 * to a new chat only when it accepted the fork itself or (create_thread) when
 * it is viewing the parent thread.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import { createForkTray, type ForkProposal } from "./forkTray"

const P = (over: Partial<ForkProposal> = {}): ForkProposal => ({
  id: "fork_1", parentThreadId: "thr-a", title: "Clef vs Jev",
  summary: "Compare the model to Jev", status: "pending", createdAt: 1, ...over,
})

describe("forkTray", () => {
  let host: HTMLElement
  let active: string | null
  let sent: Array<Record<string, unknown>>
  let opened: Array<[string, string]>
  let reasons: string[]
  let accept: boolean
  let tray: ReturnType<typeof createForkTray>

  beforeEach(() => {
    document.body.innerHTML = '<form><div id="fork-tray" hidden></div></form>'
    host = document.getElementById("fork-tray")!
    active = "thr-a"
    sent = []
    opened = []
    reasons = []
    accept = true
    tray = createForkTray({
      host,
      getActiveThreadId: () => active,
      send: (f) => sent.push(f),
      openThread: (id, title, reason) => {
        reasons.push(reason)
        if (accept) opened.push([id, title])
        return accept
      },
    })
  })

  const titles = () => Array.from(host.querySelectorAll(".fork-card-title")).map((e) => e.textContent)

  it("draws a pending marker for the active thread, from set and from update", () => {
    tray.applySet({ threadId: "thr-a", proposals: [P()] })
    expect(host.hidden).toBe(false)
    expect(titles()).toEqual(["Clef vs Jev"])
    expect(host.querySelector(".fork-card-summary")!.textContent).toBe("Compare the model to Jev")
    expect(host.querySelector(".fork-tray-count")!.textContent).toBe("1")
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ id: "fork_2", title: "Second", createdAt: 2 }) })
    expect(titles()).toEqual(["Clef vs Jev", "Second"])
  })

  it("hides markers that belong to another thread", () => {
    tray.applyUpdate({ threadId: "thr-b", proposal: P({ parentThreadId: "thr-b" }) })
    expect(host.hidden).toBe(true)
    active = "thr-b"
    tray.render()
    expect(titles()).toEqual(["Clef vs Jev"])
  })

  it("Continue sends accept, and the accepted update switches THIS window", () => {
    tray.applySet({ threadId: "thr-a", proposals: [P()] })
    ;(host.querySelector(".fork-card-go") as HTMLButtonElement).click()
    expect(sent).toEqual([{ type: "fork-proposal-respond", threadId: "thr-a", proposalId: "fork_1", decision: "accept" }])
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ status: "accepting" }) })
    expect((host.querySelector(".fork-card-go") as HTMLButtonElement).disabled).toBe(true)
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ status: "accepted", childThreadId: "thr-new" }) })
    expect(opened).toEqual([["thr-new", "Clef vs Jev"]])
    expect(host.hidden).toBe(true)
    // A replayed update never switches twice.
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ status: "accepted", childThreadId: "thr-new" }) })
    expect(opened).toHaveLength(1)
  })

  it("a fork accepted in ANOTHER window does not switch this one", () => {
    tray.applySet({ threadId: "thr-a", proposals: [P()] })
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ status: "accepted", childThreadId: "thr-new" }) })
    expect(opened).toEqual([])
    expect(host.hidden).toBe(true)
  })

  it("Dismiss sends dismiss and the dismissed update removes the card", () => {
    tray.applySet({ threadId: "thr-a", proposals: [P()] })
    ;(host.querySelector(".fork-card-dismiss") as HTMLButtonElement).click()
    expect(sent[0]).toMatchObject({ decision: "dismiss", proposalId: "fork_1" })
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ status: "dismissed" }) })
    expect(host.hidden).toBe(true)
  })

  it("create_thread (autoOpen) is never drawn and opens only in the window on the parent thread", () => {
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ autoOpen: true }) })
    expect(host.hidden).toBe(true)
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ autoOpen: true, status: "accepted", childThreadId: "thr-made" }) })
    expect(opened).toEqual([["thr-made", "Clef vs Jev"]])

    active = "thr-other"
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ id: "fork_9", autoOpen: true, status: "accepted", childThreadId: "thr-2" }) })
    expect(opened).toHaveLength(1)
  })

  it("never injects markup from a server title", () => {
    tray.applySet({ threadId: "thr-a", proposals: [P({ title: "<img src=x onerror=alert(1)>" })] })
    expect(titles()).toEqual(["<img src=x onerror=alert(1)>"])
    expect(host.querySelector("img")).toBeNull()
  })

  it("drops a click-accept if you moved to another chat before it finished (no surprise jump)", () => {
    tray.applySet({ threadId: "thr-a", proposals: [P()] })
    ;(host.querySelector(".fork-card-go") as HTMLButtonElement).click()
    active = "thr-b"
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ status: "accepted", childThreadId: "thr-new" }) })
    expect(opened).toEqual([])
    // Coming back later does not replay it either.
    active = "thr-a"
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ status: "accepted", childThreadId: "thr-new" }) })
    expect(opened).toEqual([])
  })

  it("a declined switch (draft in the box) becomes a New chat ready card; Open switches, Later clears", async () => {
    accept = false
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ autoOpen: true, status: "accepted", childThreadId: "thr-made" }) })
    expect(reasons).toEqual(["auto"])
    expect(host.hidden).toBe(false)
    expect(host.querySelector(".fork-tray-head")!.textContent).toContain("Ready")
    expect(tray._ready("thr-a")).toHaveLength(1)
    // Open is an explicit action.
    accept = true
    ;(host.querySelector(".fork-card-go") as HTMLButtonElement).click()
    await Promise.resolve(); await Promise.resolve()
    expect(reasons).toEqual(["auto", "open"])
    expect(opened).toEqual([["thr-made", "Clef vs Jev"]])
    expect(host.hidden).toBe(true)

    accept = false
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ id: "fork_2", autoOpen: true, status: "accepted", childThreadId: "thr-2" }) })
    ;(host.querySelector(".fork-card-dismiss") as HTMLButtonElement).click()
    expect(host.hidden).toBe(true)
    expect(tray._ready("thr-a")).toHaveLength(0)
  })

  it("passes \"click\" as the reason for a Continue accept", () => {
    tray.applySet({ threadId: "thr-a", proposals: [P()] })
    ;(host.querySelector(".fork-card-go") as HTMLButtonElement).click()
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ status: "accepted", childThreadId: "thr-new" }) })
    expect(reasons).toEqual(["click"])
  })

  it("A -> B -> A drops a stale click-accept (no jump on return)", () => {
    tray.applySet({ threadId: "thr-a", proposals: [P()] })
    ;(host.querySelector(".fork-card-go") as HTMLButtonElement).click()
    active = "thr-b"
    tray.render() // the window shows B
    active = "thr-a"
    tray.render() // and back to A before the accept lands
    tray.applyUpdate({ threadId: "thr-a", proposal: P({ status: "accepted", childThreadId: "thr-new" }) })
    expect(opened).toEqual([])
  })

  it("an async open that fails keeps (or creates) the ready card", async () => {
    let ok = false
    const t2 = createForkTray({
      host,
      getActiveThreadId: () => active,
      send: () => undefined,
      openThread: () => Promise.resolve(ok),
    })
    t2.applyUpdate({ threadId: "thr-a", proposal: P({ autoOpen: true, status: "accepted", childThreadId: "thr-x" }) })
    await Promise.resolve(); await Promise.resolve()
    expect(t2._ready("thr-a")).toHaveLength(1)
    ;(host.querySelector(".fork-card-go") as HTMLButtonElement).click()
    await Promise.resolve(); await Promise.resolve()
    expect(t2._ready("thr-a")).toHaveLength(1) // failed open: card stays
    ok = true
    ;(host.querySelector(".fork-card-go") as HTMLButtonElement).click()
    await Promise.resolve(); await Promise.resolve()
    expect(t2._ready("thr-a")).toHaveLength(0)
  })
})
