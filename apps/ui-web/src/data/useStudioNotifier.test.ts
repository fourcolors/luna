import { describe, expect, it } from "vitest"
import type { ServerFrame } from "@luna/ui-shared/core"
import {
  classify,
  claimDedupe,
  dedupeSignature,
  emitNotification,
  isWindowFocused,
  notificationsEnabled,
  processNotifyHit,
  shouldSuppress,
  type NotifyHit,
} from "./useStudioNotifier"

// The suite runs in the vitest "node" environment (jsdom is not a dependency),
// so it never touches a DOM: the gate predicates take injected storage / focus
// booleans, and the bridge is exercised with __TAURI__ + Notification absent.

/** Minimal in-memory Storage stand-in for the opt-out + dedupe gates. */
function mockStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      m.set(k, String(v))
    },
    removeItem: (k: string) => {
      m.delete(k)
    },
    clear: () => {
      m.clear()
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  } as unknown as Storage
}

const asFrame = (f: unknown): ServerFrame => f as ServerFrame

describe("classify - the 7 rows", () => {
  it("result-delivered -> done (label appended)", () => {
    const hit = classify(
      asFrame({
        type: "result-delivered",
        threadId: "t1",
        source: "background-job",
        label: "Nightly digest",
        preview: "Here is your digest",
        ts: 111,
      }),
    )
    expect(hit).toEqual<NotifyHit>({
      kind: "done",
      title: "Luna · Nightly digest",
      body: "Here is your digest",
      threadId: "t1",
      seenKey: "done:t1:111",
      ts: 111,
    })
  })

  it("result-delivered with empty label -> bare 'Luna' title", () => {
    const hit = classify(
      asFrame({
        type: "result-delivered",
        threadId: "t1",
        source: "s",
        label: "",
        preview: "p",
        ts: 5,
      }),
    )
    expect(hit?.title).toBe("Luna")
  })

  it("assistant-done WITH delivery -> done, keyed by message.ts", () => {
    const hit = classify(
      asFrame({
        type: "assistant-done",
        threadId: "t2",
        turnId: "turn1",
        seq: 5,
        message: {
          id: "m1",
          seq: 5,
          ts: 222,
          role: "assistant",
          text: "Job done text",
          toolUses: [],
          attachments: [],
          delivery: { source: "background-job", label: "Deploy" },
        },
      }),
    )
    expect(hit).toEqual<NotifyHit>({
      kind: "done",
      title: "Luna · Deploy",
      body: "Job done text",
      threadId: "t2",
      seenKey: "done:t2:222",
      ts: 222,
    })
  })

  it("result-delivered and assistant-done+delivery share a seenKey (threadId+ts dedupe)", () => {
    const rd = classify(
      asFrame({
        type: "result-delivered",
        threadId: "t9",
        source: "s",
        label: "L",
        preview: "p",
        ts: 777,
      }),
    )
    const ad = classify(
      asFrame({
        type: "assistant-done",
        threadId: "t9",
        turnId: "turn",
        seq: 3,
        message: {
          id: "m",
          seq: 3,
          ts: 777,
          role: "assistant",
          text: "p full",
          toolUses: [],
          attachments: [],
          delivery: { source: "s" },
        },
      }),
    )
    expect(rd?.seenKey).toBe("done:t9:777")
    expect(ad?.seenKey).toBe("done:t9:777")
  })

  it("assistant-done LIVE (no delivery) -> null", () => {
    const hit = classify(
      asFrame({
        type: "assistant-done",
        threadId: "t2",
        turnId: "turn1",
        seq: 6,
        message: {
          id: "m2",
          seq: 6,
          ts: 333,
          role: "assistant",
          text: "live reply",
          toolUses: [],
          attachments: [],
        },
      }),
    )
    expect(hit).toBeNull()
  })

  it("suggested-action-set (non-empty) -> suggested, last action's title/id", () => {
    const hit = classify(
      asFrame({
        type: "suggested-action-set",
        threadId: "t3",
        actions: [
          {
            id: "a1",
            threadId: "t3",
            actionType: "task",
            title: "First",
            status: "proposed",
            source: "agent",
            createdAt: 10,
          },
          {
            id: "a2",
            threadId: "t3",
            actionType: "task",
            title: "Second",
            status: "proposed",
            source: "agent",
            createdAt: 20,
          },
        ],
      }),
    )
    expect(hit).toEqual<NotifyHit>({
      kind: "suggested",
      title: "Luna suggests an action",
      body: "Second",
      threadId: "t3",
      seenKey: "suggested:a2",
      ts: 20,
    })
  })

  it("suggested-action-set (empty) -> null", () => {
    const hit = classify(asFrame({ type: "suggested-action-set", threadId: "t3", actions: [] }))
    expect(hit).toBeNull()
  })

  it("suggested-action-update (proposed) -> suggested", () => {
    const hit = classify(
      asFrame({
        type: "suggested-action-update",
        threadId: "t4",
        action: {
          id: "a9",
          threadId: "t4",
          actionType: "research",
          title: "Look into X",
          status: "proposed",
          source: "agent",
          createdAt: 99,
        },
      }),
    )
    expect(hit).toEqual<NotifyHit>({
      kind: "suggested",
      title: "Luna suggests an action",
      body: "Look into X",
      threadId: "t4",
      seenKey: "suggested:a9",
      ts: 99,
    })
  })

  it("suggested-action-update (terminal status) -> null", () => {
    const hit = classify(
      asFrame({
        type: "suggested-action-update",
        threadId: "t4",
        action: {
          id: "a9",
          threadId: "t4",
          actionType: "research",
          title: "Look into X",
          status: "completed",
          source: "agent",
          createdAt: 99,
        },
      }),
    )
    expect(hit).toBeNull()
  })

  it("job-input-request -> needs-input, prompt body, null threadId (broadcast, no owning thread)", () => {
    const hit = classify(
      asFrame({
        type: "job-input-request",
        requestId: "r1",
        runId: 7,
        jobId: "j1",
        jobName: "Nightly",
        prompt: "Which draft?",
        timeoutMs: 60000,
      }),
    )
    expect(hit).toEqual<NotifyHit>({
      kind: "needs-input",
      title: "Luna needs your input",
      body: "Which draft?",
      // Jobs have no owning chat thread - banner is awareness-only (#362).
      threadId: null,
      seenKey: "job:r1",
      ts: null,
    })
  })

  it("job-input-request falls back to jobName when prompt is empty", () => {
    const hit = classify(
      asFrame({
        type: "job-input-request",
        requestId: "r2",
        runId: 8,
        jobId: "j2",
        jobName: "Fallback job",
        prompt: "",
        timeoutMs: 1000,
      }),
    )
    expect(hit?.body).toBe("Fallback job")
  })

  it("secret-request -> needs-input with summoning threadId (#362)", () => {
    const hit = classify(
      asFrame({
        type: "secret-request",
        requestId: "s1",
        threadId: "t-secret-456",
        prompt: "Paste your OpenAI key",
        destinationLabel: "env:OPENAI_API_KEY",
      }),
    )
    expect(hit).toEqual<NotifyHit>({
      kind: "needs-input",
      title: "Luna needs your input",
      body: "Paste your OpenAI key",
      threadId: "t-secret-456",
      seenKey: "secret:s1",
      ts: null,
    })
  })

  it("secret-request falls back to destinationLabel when prompt is empty", () => {
    const hit = classify(
      asFrame({
        type: "secret-request",
        requestId: "s2",
        threadId: "t2",
        prompt: "",
        destinationLabel: "env:FOO",
      }),
    )
    expect(hit?.body).toBe("env:FOO")
    expect(hit?.threadId).toBe("t2")
  })

  it("unrelated frame -> null", () => {
    expect(classify(asFrame({ type: "ping", ts: "2026-01-01T00:00:00Z" }))).toBeNull()
    expect(classify(asFrame({ type: "turn-complete", threadId: "t" }))).toBeNull()
  })
})

describe("opt-out gate (fail OPEN)", () => {
  it("enabled by default (nothing stored)", () => {
    expect(notificationsEnabled(mockStorage())).toBe(true)
  })

  it("disabled only on the exact 'false' sentinel", () => {
    const s = mockStorage()
    s.setItem("luna_notifications_enabled", "false")
    expect(notificationsEnabled(s)).toBe(false)
    s.setItem("luna_notifications_enabled", "true")
    expect(notificationsEnabled(s)).toBe(true)
    s.setItem("luna_notifications_enabled", "0")
    expect(notificationsEnabled(s)).toBe(true)
  })

  it("fails OPEN when storage is unavailable", () => {
    expect(notificationsEnabled(undefined)).toBe(true)
  })
})

describe("per-kind dedupe gate", () => {
  const doneHit: NotifyHit = {
    kind: "done",
    title: "Luna",
    body: "some body text",
    threadId: "t1",
    seenKey: "done:t1:1",
    ts: 1,
  }

  it("signature blends kind, threadId, ts, and a 40-char body prefix", () => {
    expect(dedupeSignature(doneHit)).toBe("done:t1:1:some body text")
    const needs: NotifyHit = {
      kind: "needs-input",
      title: "x",
      body: "b",
      threadId: null,
      seenKey: "job:1",
      ts: null,
    }
    expect(dedupeSignature(needs)).toBe("needs-input:::b")
  })

  it("claims once, then rejects the identical repeat", () => {
    const s = mockStorage()
    expect(claimDedupe(doneHit, s)).toBe(true)
    expect(claimDedupe(doneHit, s)).toBe(false)
  })

  it("keys per-kind so a done never cross-suppresses a needs-input", () => {
    const s = mockStorage()
    const needs: NotifyHit = {
      kind: "needs-input",
      title: "Luna needs your input",
      body: "some body text",
      threadId: null,
      seenKey: "job:z",
      ts: null,
    }
    expect(claimDedupe(doneHit, s)).toBe(true)
    // Same body slice, different kind -> different localStorage key -> allowed.
    expect(claimDedupe(needs, s)).toBe(true)
  })

  it("fails OPEN when storage is unavailable", () => {
    expect(claimDedupe(doneHit, undefined)).toBe(true)
  })
})

describe("focus-suppression gate", () => {
  const threadHit: NotifyHit = {
    kind: "done",
    title: "Luna",
    body: "b",
    threadId: "t1",
    seenKey: "done:t1:1",
    ts: 1,
  }
  const needsHit: NotifyHit = {
    kind: "needs-input",
    title: "Luna needs your input",
    body: "b",
    threadId: null,
    seenKey: "job:1",
    ts: null,
  }

  it("thread kind suppressed only when focused AND viewing that thread", () => {
    expect(shouldSuppress(threadHit, "t1", true)).toBe(true)
    expect(shouldSuppress(threadHit, "t2", true)).toBe(false)
    expect(shouldSuppress(threadHit, "t1", false)).toBe(false)
    expect(shouldSuppress(threadHit, null, true)).toBe(false)
  })

  it("needs-input is never focus-suppressed (banner is the only Studio cue)", () => {
    expect(shouldSuppress(needsHit, "t1", true)).toBe(false)
    expect(shouldSuppress(needsHit, null, true)).toBe(false)
    expect(shouldSuppress(needsHit, "t1", false)).toBe(false)
  })

  it("isWindowFocused is false with no DOM", () => {
    expect(isWindowFocused()).toBe(false)
  })
})

describe("processNotifyHit gate order", () => {
  const needsHit: NotifyHit = {
    kind: "needs-input",
    title: "Luna needs your input",
    body: "Paste key",
    threadId: null,
    seenKey: "secret:s-order",
    ts: null,
  }
  const doneHit: NotifyHit = {
    kind: "done",
    title: "Luna",
    body: "done body",
    threadId: "t1",
    seenKey: "done:t1:99",
    ts: 99,
  }

  it("emits needs-input even when the window is focused", () => {
    const seen = new Set<string>()
    const emits: NotifyHit[] = []
    const result = processNotifyHit(needsHit, {
      seen,
      selectedThreadId: "t1",
      focused: true,
      storage: mockStorage(),
      emit: (h) => {
        emits.push(h)
        return "native"
      },
    })
    expect(result).toBe("emitted")
    expect(emits).toHaveLength(1)
    expect(seen.has(needsHit.seenKey)).toBe(true)
  })

  it("does NOT burn seenKey when focus-suppressed (done on the open thread)", () => {
    const seen = new Set<string>()
    const emits: NotifyHit[] = []
    const result = processNotifyHit(doneHit, {
      seen,
      selectedThreadId: "t1",
      focused: true,
      storage: mockStorage(),
      emit: (h) => {
        emits.push(h)
        return "native"
      },
    })
    expect(result).toBe("dropped")
    expect(emits).toHaveLength(0)
    expect(seen.has(doneHit.seenKey)).toBe(false)
  })

  it("allows a later emit of a previously focus-suppressed done hit", () => {
    const seen = new Set<string>()
    const storage = mockStorage()
    // First pass: focused on the thread → suppress, no mark.
    expect(
      processNotifyHit(doneHit, {
        seen,
        selectedThreadId: "t1",
        focused: true,
        storage,
        emit: () => "native",
      }),
    ).toBe("dropped")
    // Second pass: user switched away / backgrounded → emit + mark.
    const emits: NotifyHit[] = []
    expect(
      processNotifyHit(doneHit, {
        seen,
        selectedThreadId: "t2",
        focused: true,
        storage,
        emit: (h) => {
          emits.push(h)
          return "native"
        },
      }),
    ).toBe("emitted")
    expect(emits).toHaveLength(1)
    expect(seen.has(doneHit.seenKey)).toBe(true)
  })

  it("does not mark seen when emit returns none", () => {
    const seen = new Set<string>()
    expect(
      processNotifyHit(needsHit, {
        seen,
        selectedThreadId: null,
        focused: false,
        storage: mockStorage(),
        emit: () => "none",
      }),
    ).toBe("dropped")
    expect(seen.has(needsHit.seenKey)).toBe(false)
  })
})

describe("emit bridge", () => {
  it("no-ops (returns 'none') when __TAURI__ and Notification are both absent", () => {
    expect((globalThis as { __TAURI__?: unknown }).__TAURI__).toBeUndefined()
    expect(typeof (globalThis as { Notification?: unknown }).Notification).toBe("undefined")
    const hit: NotifyHit = {
      kind: "done",
      title: "Luna",
      body: "b",
      threadId: "t1",
      seenKey: "done:t1:1",
      ts: 1,
    }
    expect(emitNotification(hit)).toBe("none")
  })

  it("routes through the Tauri invoke when __TAURI__ is present", () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
    const g = globalThis as { __TAURI__?: unknown }
    g.__TAURI__ = {
      core: {
        invoke: (cmd: string, args: Record<string, unknown>) => {
          calls.push({ cmd, args })
          return Promise.resolve()
        },
      },
    }
    try {
      const hit: NotifyHit = {
        kind: "suggested",
        title: "Luna suggests an action",
        body: "Do X",
        threadId: "t7",
        seenKey: "suggested:a1",
        ts: 5,
      }
      expect(emitNotification(hit)).toBe("native")
      expect(calls).toEqual([
        {
          cmd: "notify_thread",
          args: { kind: "suggested", title: "Luna suggests an action", body: "Do X", threadId: "t7" },
        },
      ])
    } finally {
      delete g.__TAURI__
    }
  })

  it("passes an empty threadId string to the native command for needs-input", () => {
    const calls: Array<Record<string, unknown>> = []
    const g = globalThis as { __TAURI__?: unknown }
    g.__TAURI__ = {
      core: { invoke: (_cmd: string, args: Record<string, unknown>) => calls.push(args) },
    }
    try {
      const hit: NotifyHit = {
        kind: "needs-input",
        title: "Luna needs your input",
        body: "Paste key",
        threadId: null,
        seenKey: "secret:s1",
        ts: null,
      }
      expect(emitNotification(hit)).toBe("native")
      expect(calls[0]?.threadId).toBe("")
    } finally {
      delete g.__TAURI__
    }
  })
})
