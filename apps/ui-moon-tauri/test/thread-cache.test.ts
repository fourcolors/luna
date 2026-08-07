// @vitest-environment jsdom
/**
 * thread-cache.test.ts - unit tests for src/chat/threadCache.ts (stack23 S17d).
 *
 * THE ASSERTION THAT MOTIVATED THIS FILE. Making `paint()` report success even
 * when `loadHistory` throws left the entire Moon suite green (1439/0). That
 * return value is load-bearing: `onRowClick` uses it to decide whether to force
 * a blank render, so a false success leaves the PREVIOUS thread's transcript on
 * screen while the user believes they switched. Silent, and exactly the kind of
 * thing a cache is supposed to be invisible about.
 *
 * The `try`/`catch` shape here is contract, not defensive noise - reset and
 * flush failures are tolerated, loadHistory failure is REPORTED - and each arm
 * is pinned separately below, because collapsing them into one block is the
 * natural "cleanup" that would break it.
 */
import { describe, it, expect, vi } from "vitest"
import {
  clear,
  clearBusy,
  get,
  isBusy,
  markBusy,
  paint,
  put,
  type ThreadCacheCtx,
  type ThreadCacheState,
} from "../frontend-react/src/chat/threadCache"

function makeCtx(over: Partial<ThreadCacheCtx> = {}) {
  const state: ThreadCacheState = { threadCache: {}, busyThreads: {} }
  const requestRender = vi.fn()
  const chatState = { reset: vi.fn(), loadHistory: vi.fn() }
  const chatLoop = { flush: vi.fn() }
  const ctx: ThreadCacheCtx = { state, chatState, chatLoop, requestRender, ...over }
  return { ctx, state, requestRender, chatState, chatLoop }
}

describe("threadCache", () => {
  describe("put / get", () => {
    it("stores messages and throughSeq, and reads them back", () => {
      const { ctx } = makeCtx()
      put(ctx, "a", [{ text: "hi" }], 7)
      expect(get(ctx, "a")).toEqual({ messages: [{ text: "hi" }], throughSeq: 7 })
    })

    it("COPIES the caller's array rather than aliasing it", () => {
      const { ctx } = makeCtx()
      const incoming = [{ text: "one" }]
      put(ctx, "a", incoming, 1)
      incoming.push({ text: "sneaked in later" })
      // Aliasing would let a later mutation of the frame's message list
      // rewrite history the cache already handed out.
      expect(get(ctx, "a")!.messages).toHaveLength(1)
    })

    it("defaults a non-finite throughSeq to -1 and a non-array payload to []", () => {
      const { ctx } = makeCtx()
      put(ctx, "a", "not-an-array", undefined)
      expect(get(ctx, "a")).toEqual({ messages: [], throughSeq: -1 })
      put(ctx, "b", [], NaN)
      expect(get(ctx, "b")!.throughSeq).toBe(-1)
    })

    it("ignores a falsy thread id on both sides", () => {
      const { ctx, state } = makeCtx()
      put(ctx, "", [{}], 1)
      put(ctx, null, [{}], 1)
      expect(Object.keys(state.threadCache)).toEqual([])
      expect(get(ctx, "")).toBeNull()
      expect(get(ctx, undefined)).toBeNull()
    })

    it("returns null for a thread that was never cached", () => {
      const { ctx } = makeCtx()
      expect(get(ctx, "missing")).toBeNull()
    })
  })

  describe("paint", () => {
    it("loads the cached history and flushes, reporting true", () => {
      const { ctx, chatState, chatLoop } = makeCtx()
      put(ctx, "a", [{ text: "hi" }], 1)
      expect(paint(ctx, "a")).toBe(true)
      expect(chatState.reset).toHaveBeenCalledTimes(1)
      expect(chatState.loadHistory).toHaveBeenCalledWith([{ text: "hi" }])
      expect(chatLoop.flush).toHaveBeenCalledTimes(1)
    })

    it("reports false for a thread with no cache entry, without touching ChatState", () => {
      const { ctx, chatState } = makeCtx()
      expect(paint(ctx, "nope")).toBe(false)
      expect(chatState.reset).not.toHaveBeenCalled()
    })

    // ── the three try/catch arms, pinned separately ────────────────────────
    it("REPORTS FALSE when loadHistory throws", () => {
      // The one that matters. onRowClick uses this to decide whether to force
      // a blank render; a false success leaves the PREVIOUS thread's
      // transcript on screen while the user believes they switched.
      const chatState = {
        reset: vi.fn(),
        loadHistory: vi.fn(() => {
          throw new Error("boom")
        }),
      }
      const { ctx } = makeCtx({ chatState })
      put(ctx, "a", [{ text: "hi" }], 1)
      expect(paint(ctx, "a")).toBe(false)
    })

    it("TOLERATES a failing reset - it is not ready during early boot", () => {
      const chatState = {
        reset: vi.fn(() => {
          throw new Error("not ready")
        }),
        loadHistory: vi.fn(),
      }
      const { ctx } = makeCtx({ chatState })
      put(ctx, "a", [], 1)
      expect(paint(ctx, "a")).toBe(true)
      expect(chatState.loadHistory).toHaveBeenCalled()
    })

    it("TOLERATES a failing flush - the renderer is optional in unit tests", () => {
      const chatLoop = {
        flush: vi.fn(() => {
          throw new Error("no renderer")
        }),
      }
      const { ctx } = makeCtx({ chatLoop })
      put(ctx, "a", [], 1)
      expect(paint(ctx, "a")).toBe(true)
    })

    it("degrades to false rather than throwing when ChatState is absent entirely", () => {
      const { ctx } = makeCtx({ chatState: null, chatLoop: null })
      put(ctx, "a", [], 1)
      expect(() => paint(ctx, "a")).not.toThrow()
    })
  })

  describe("busy tracking", () => {
    it("marks busy and repaints the strip", () => {
      const { ctx, requestRender } = makeCtx()
      markBusy(ctx, "a")
      expect(isBusy(ctx, "a")).toBe(true)
      expect(requestRender).toHaveBeenCalledTimes(1)
    })

    it("is IDEMPOTENT - re-marking an already-busy thread does not repaint", () => {
      // Load-bearing: a redundant repaint mid-drag rebuilds the strip and
      // detaches the row holding pointer capture.
      const { ctx, requestRender } = makeCtx()
      markBusy(ctx, "a")
      markBusy(ctx, "a")
      expect(requestRender).toHaveBeenCalledTimes(1)
    })

    it("clears busy and repaints, but only when it was actually set", () => {
      const { ctx, requestRender } = makeCtx()
      clearBusy(ctx, "a")
      expect(requestRender).not.toHaveBeenCalled()
      markBusy(ctx, "a")
      requestRender.mockClear()
      clearBusy(ctx, "a")
      expect(isBusy(ctx, "a")).toBe(false)
      expect(requestRender).toHaveBeenCalledTimes(1)
    })

    it("survives a throwing requestRender - the sidebar may simply be closed", () => {
      const requestRender = vi.fn(() => {
        throw new Error("no sidebar")
      })
      const { ctx } = makeCtx({ requestRender })
      expect(() => markBusy(ctx, "a")).not.toThrow()
      // The state change still happened; only the repaint failed.
      expect(isBusy(ctx, "a")).toBe(true)
      expect(() => clearBusy(ctx, "a")).not.toThrow()
    })

    it("treats a falsy id as not busy and ignores it", () => {
      const { ctx, requestRender } = makeCtx()
      markBusy(ctx, "")
      markBusy(ctx, null)
      expect(requestRender).not.toHaveBeenCalled()
      expect(isBusy(ctx, "")).toBe(false)
      expect(isBusy(ctx, undefined)).toBe(false)
    })
  })

  describe("clear", () => {
    it("drops one thread's entry and leaves the others", () => {
      const { ctx } = makeCtx()
      put(ctx, "a", [], 1)
      put(ctx, "b", [], 1)
      clear(ctx, "a")
      expect(get(ctx, "a")).toBeNull()
      expect(get(ctx, "b")).not.toBeNull()
    })
  })

  describe("absent state", () => {
    it("every entry point degrades to a no-op when State is not wired yet", () => {
      // The harness mounts modules BEFORE the classic script defines State.
      const { ctx } = makeCtx({ state: null })
      expect(() => put(ctx, "a", [], 1)).not.toThrow()
      expect(get(ctx, "a")).toBeNull()
      expect(paint(ctx, "a")).toBe(false)
      expect(() => markBusy(ctx, "a")).not.toThrow()
      expect(() => clearBusy(ctx, "a")).not.toThrow()
      expect(() => clear(ctx, "a")).not.toThrow()
      expect(isBusy(ctx, "a")).toBe(false)
    })
  })
})
