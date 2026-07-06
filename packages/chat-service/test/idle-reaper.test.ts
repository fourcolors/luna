/**
 * Idle-thread reaper policy — pure decision tests.
 *
 * The reaper reclaims the long-lived `claude` subprocess pinned to each chat
 * thread's scope once the thread has been quiet. Until this fix the only thing
 * that closed a thread scope was full server shutdown, so every thread leaked
 * one subprocess (observed: 45 orphaned `claude` procs after 3 days uptime).
 *
 * These tests pin the policy that drives the reaper:
 *   - parseIdleReapMs: how LUNA_CHAT_THREAD_IDLE_MS is interpreted.
 *   - isThreadIdleReapable: when a thread is eligible to be reaped.
 */
import { describe, expect, it } from "vitest"
import {
  DEFAULT_IDLE_REAP_MS,
  isThreadIdleReapable,
  parseIdleReapMs,
} from "../src/chat-service"

describe("parseIdleReapMs", () => {
  it("defaults to 30 minutes when the env var is absent", () => {
    expect(parseIdleReapMs(undefined)).toBe(DEFAULT_IDLE_REAP_MS)
    expect(DEFAULT_IDLE_REAP_MS).toBe(1_800_000)
  })

  it("treats an explicit 0 as 'disabled'", () => {
    expect(parseIdleReapMs("0")).toBe(0)
  })

  it("accepts a positive override verbatim", () => {
    expect(parseIdleReapMs("60000")).toBe(60_000)
    expect(parseIdleReapMs("1")).toBe(1)
  })

  it("falls back to the default for non-numeric or negative input", () => {
    expect(parseIdleReapMs("abc")).toBe(DEFAULT_IDLE_REAP_MS)
    expect(parseIdleReapMs("")).toBe(DEFAULT_IDLE_REAP_MS)
    expect(parseIdleReapMs("-5")).toBe(DEFAULT_IDLE_REAP_MS)
    expect(parseIdleReapMs("NaN")).toBe(DEFAULT_IDLE_REAP_MS)
  })
})

describe("isThreadIdleReapable", () => {
  const idleReapMs = 30 * 60_000 // 30 min
  const base = { now: 1_000_000, lastActivity: 0, inFlightTurnId: null, idleReapMs }

  it("reaps a thread idle past the window with no in-flight turn", () => {
    expect(
      isThreadIdleReapable({ ...base, lastActivity: base.now - idleReapMs }),
    ).toBe(true)
    expect(
      isThreadIdleReapable({ ...base, lastActivity: base.now - idleReapMs - 1 }),
    ).toBe(true)
  })

  it("does NOT reap a thread that is still within the idle window", () => {
    expect(
      isThreadIdleReapable({ ...base, lastActivity: base.now - idleReapMs + 1 }),
    ).toBe(false)
    expect(
      isThreadIdleReapable({ ...base, lastActivity: base.now }),
    ).toBe(false)
  })

  it("NEVER reaps a thread with an in-flight turn, however old", () => {
    expect(
      isThreadIdleReapable({
        ...base,
        lastActivity: base.now - idleReapMs * 100,
        inFlightTurnId: "turn-123",
      }),
    ).toBe(false)
  })

  it("is fully disabled when idleReapMs <= 0", () => {
    expect(
      isThreadIdleReapable({
        ...base,
        lastActivity: base.now - idleReapMs * 100,
        idleReapMs: 0,
      }),
    ).toBe(false)
  })

  it("treats the boundary (exactly idle window) as reapable", () => {
    // now - lastActivity === idleReapMs  → elapsed >= window → reap.
    expect(
      isThreadIdleReapable({
        now: idleReapMs,
        lastActivity: 0,
        inFlightTurnId: null,
        idleReapMs,
      }),
    ).toBe(true)
  })
})
