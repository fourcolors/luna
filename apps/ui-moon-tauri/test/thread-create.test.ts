/**
 * thread-create.test.ts - the new-thread INTENT arbitration
 * (src/chat/threadCreate.ts, stack23 S17e).
 *
 * WHAT THIS ARBITRATES. Two things a user can do milliseconds apart both want
 * to own the window when the server's `thread-created` ack lands: pressing
 * "+ New", and clicking an existing thread row. Every transition here encodes
 * a decision about whose action wins, so a silent regression does not crash -
 * it just puts the user in a thread they did not choose.
 *
 * WHY IT NEEDED ITS OWN FILE. Mutating the module three ways found only ONE
 * caught by the 1457-test Moon suite:
 *   - moveToBackground made a no-op        -> caught
 *   - onDisconnect losing pendingFreshThread -> ALL GREEN
 *   - begin() losing its re-adoption        -> ALL GREEN
 * The two survivors are exactly the recovery paths: what happens when a socket
 * drops mid-create, and what a second "+" press means. Being a pure module is
 * what makes them assertable without booting the page.
 */
import { describe, it, expect } from "vitest"
import {
  begin,
  fail,
  moveToBackground,
  onDisconnect,
  settle,
  type ThreadCreateStateSlice,
} from "../frontend-react/src/chat/threadCreate"

const makeState = (over: Partial<ThreadCreateStateSlice> = {}): ThreadCreateStateSlice => ({
  threadCreateIntent: null,
  threadListAutoSelectPending: false,
  pendingFreshThread: false,
  activeThreadId: null,
  ...over,
})

describe("thread create intent", () => {
  describe("begin", () => {
    it("claims the window and tells the caller to mint", () => {
      const s = makeState()
      expect(begin(s)).toBe(true)
      expect(s.threadCreateIntent).toBe("attach")
    })

    it("a SECOND press does not mint again, but RE-ADOPTS the intent", () => {
      // The survivor mutant. Dropping the re-assert leaves a create stuck in
      // 'background', so the thread the user asked for twice lands silently in
      // the background and the window keeps showing the old one.
      const s = makeState({ threadCreateIntent: "background" })
      expect(begin(s), "a second press must not mint a concurrent thread").toBe(false)
      expect(s.threadCreateIntent, "but it must re-claim the window").toBe("attach")
    })

    it("re-adopting after a row click backgrounded the create", () => {
      const s = makeState()
      begin(s)
      moveToBackground(s) // user clicked another row
      expect(s.threadCreateIntent).toBe("background")
      expect(begin(s)).toBe(false)
      expect(s.threadCreateIntent).toBe("attach")
      expect(settle(s), "the create should now take the window again").toBe(true)
    })

    it("always clears the auto-select pending flag", () => {
      const s = makeState({ threadListAutoSelectPending: true })
      begin(s)
      expect(s.threadListAutoSelectPending).toBe(false)
    })
  })

  describe("moveToBackground", () => {
    it("concedes the window when a create is attached", () => {
      const s = makeState({ threadCreateIntent: "attach" })
      moveToBackground(s)
      expect(s.threadCreateIntent).toBe("background")
    })

    it("does nothing when no create is in flight", () => {
      const s = makeState()
      moveToBackground(s)
      expect(s.threadCreateIntent).toBeNull()
    })

    it("is idempotent once backgrounded", () => {
      const s = makeState({ threadCreateIntent: "background" })
      moveToBackground(s)
      expect(s.threadCreateIntent).toBe("background")
    })
  })

  describe("settle", () => {
    it("attaches an 'attach' create and clears the intent", () => {
      const s = makeState({ threadCreateIntent: "attach" })
      expect(settle(s)).toBe(true)
      expect(s.threadCreateIntent).toBeNull()
    })

    it("does NOT attach a backgrounded create", () => {
      // The whole point of the machine: a create the user superseded must not
      // yank the window away when its ack finally arrives.
      const s = makeState({ threadCreateIntent: "background" })
      expect(settle(s)).toBe(false)
      expect(s.threadCreateIntent).toBeNull()
    })

    it("clears auto-select pending on every outcome", () => {
      for (const intent of ["attach", "background", null] as const) {
        const s = makeState({ threadCreateIntent: intent, threadListAutoSelectPending: true })
        settle(s)
        expect(s.threadListAutoSelectPending).toBe(false)
      }
    })
  })

  describe("fail", () => {
    it("surfaces a failure the user is waiting on", () => {
      const s = makeState({ threadCreateIntent: "attach" })
      expect(fail(s)).toBe(true)
      expect(s.threadCreateIntent).toBeNull()
    })

    it("stays quiet about a backgrounded create's failure", () => {
      // Interrupting the user about a create they already moved on from is
      // noise, not information.
      const s = makeState({ threadCreateIntent: "background" })
      expect(fail(s)).toBe(false)
    })
  })

  describe("onDisconnect", () => {
    it("PRESERVES the fresh-thread intent when a drop kills an attached create", () => {
      // The other survivor mutant. The outcome of an in-flight create is
      // unknowable after a drop, so the stronger intent wins: reconnect mints
      // a fresh thread. Losing this silently attaches an old thread the user
      // never asked to see.
      const s = makeState({ threadCreateIntent: "attach", activeThreadId: null })
      onDisconnect(s)
      expect(s.pendingFreshThread).toBe(true)
      expect(s.threadCreateIntent).toBeNull()
    })

    it("does NOT force a fresh thread when one is already on screen", () => {
      // An extra empty row is only preferable when the window would otherwise
      // be empty; the user is already looking at something here.
      const s = makeState({ threadCreateIntent: "attach", activeThreadId: "thr-1" })
      onDisconnect(s)
      expect(s.pendingFreshThread).toBe(false)
    })

    it("does NOT force a fresh thread for a backgrounded create", () => {
      const s = makeState({ threadCreateIntent: "background", activeThreadId: null })
      onDisconnect(s)
      expect(s.pendingFreshThread).toBe(false)
    })

    it("does nothing when no create was in flight", () => {
      const s = makeState({ activeThreadId: null })
      onDisconnect(s)
      expect(s.pendingFreshThread).toBe(false)
      expect(s.threadCreateIntent).toBeNull()
    })

    it("clears auto-select pending regardless", () => {
      const s = makeState({ threadListAutoSelectPending: true })
      onDisconnect(s)
      expect(s.threadListAutoSelectPending).toBe(false)
    })
  })

  describe("full sequences", () => {
    it("press + -> row click -> ack: the row click keeps the window", () => {
      const s = makeState()
      expect(begin(s)).toBe(true)
      moveToBackground(s)
      expect(settle(s)).toBe(false)
    })

    it("press + -> drop -> reconnect: the fresh thread survives", () => {
      const s = makeState()
      begin(s)
      onDisconnect(s)
      expect(s.pendingFreshThread).toBe(true)
    })

    it("press + -> row click -> press + again -> ack: the create wins", () => {
      const s = makeState()
      begin(s)
      moveToBackground(s)
      begin(s)
      expect(settle(s)).toBe(true)
    })
  })
})
