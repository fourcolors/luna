/**
 * Unit tests for the JobInputBridge — job-summoned operator input
 * (widget-system.md Phase 5). Focus: the BROADCAST fan-out (every registered
 * client sees the request), first-answer-wins arbitration (winner acked
 * ok:true, losers acked "already answered"), timeout + cancel resolution,
 * the one-pending-request-per-run guard, unregister safety (stale ids no-op;
 * last-client-out fails pending requests), and answer containment (the
 * answer reaches ONLY the resolved promise — never a frame or log line).
 */
import { describe, expect, it, vi } from "vitest"
import {
  createJobInputBridge,
  type JobInputBridge,
  type JobInputOutcome,
} from "../src/job-input-bridge.js"
import type {
  JobInputRequestFrame,
  JobInputStatusFrame,
} from "../src/protocol.js"

type OutFrame = JobInputRequestFrame | JobInputStatusFrame

const REQ = {
  runId: 7,
  jobId: "job-abc",
  jobName: "Daily brief",
  prompt: "Which draft should I send?",
  timeoutMs: 60_000,
} as const

interface Harness {
  bridge: JobInputBridge
  logs: string[]
  /** Per-connId captured outbound frames. */
  frames: Map<string, OutFrame[]>
  wire: (connId: string) => (f: OutFrame) => void
}

const make = (): Harness => {
  const logs: string[] = []
  const frames = new Map<string, OutFrame[]>()
  const bridge = createJobInputBridge({ log: (m) => logs.push(m) })
  const wire = (connId: string) => {
    const sink: OutFrame[] = []
    frames.set(connId, sink)
    return (f: OutFrame) => sink.push(f)
  }
  return { bridge, logs, frames, wire }
}

const requestIdFrom = (h: Harness, connId: string): string => {
  const f = h.frames
    .get(connId)
    ?.find((x) => x.type === "job-input-request") as
    | JobInputRequestFrame
    | undefined
  if (!f) throw new Error(`no job-input-request reached ${connId}`)
  return f.requestId
}

describe("JobInputBridge — broadcast + first answer wins", () => {
  it("fans the request out to every registered client with run identity", async () => {
    const h = make()
    for (const id of ["A", "B", "C"]) {
      h.bridge.registerClient(id, h.wire(id))
    }
    const p = h.bridge.request(REQ)

    for (const id of ["A", "B", "C"]) {
      const got = h.frames.get(id)![0] as JobInputRequestFrame
      expect(got.type).toBe("job-input-request")
      expect(got.runId).toBe(7)
      expect(got.jobId).toBe("job-abc")
      expect(got.jobName).toBe("Daily brief")
      expect(got.prompt).toBe("Which draft should I send?")
      expect(got.timeoutMs).toBe(60_000)
    }
    // all three saw the SAME requestId
    expect(requestIdFrom(h, "A")).toBe(requestIdFrom(h, "B"))
    expect(requestIdFrom(h, "B")).toBe(requestIdFrom(h, "C"))

    h.bridge.acceptResult(
      { type: "job-input-result", requestId: requestIdFrom(h, "A"), answer: "draft 2" },
      h.wire("A-reply"),
    )
    const res = await p
    expect(res).toEqual({ ok: true, answer: "draft 2" })
  })

  it("first answer wins; the winner is acked ok:true and losers get already-answered", async () => {
    const h = make()
    h.bridge.registerClient("A", h.wire("A"))
    h.bridge.registerClient("B", h.wire("B"))
    const p = h.bridge.request(REQ)
    const requestId = requestIdFrom(h, "A")

    const winnerReplies: OutFrame[] = []
    const loserReplies: OutFrame[] = []
    h.bridge.acceptResult(
      { type: "job-input-result", requestId, answer: "first!" },
      (f) => winnerReplies.push(f),
    )
    h.bridge.acceptResult(
      { type: "job-input-result", requestId, answer: "too late" },
      (f) => loserReplies.push(f),
    )

    const res = await p
    expect(res).toEqual({ ok: true, answer: "first!" })

    const winStatus = winnerReplies[0] as JobInputStatusFrame
    expect(winStatus.type).toBe("job-input-status")
    expect(winStatus.ok).toBe(true)

    const loseStatus = loserReplies[0] as JobInputStatusFrame
    expect(loseStatus.type).toBe("job-input-status")
    expect(loseStatus.ok).toBe(false)
    expect(loseStatus.message.toLowerCase()).toContain("already answered")
    // the late answer is dropped unread — nothing echoes it
    expect(JSON.stringify([...winnerReplies, ...loserReplies])).not.toContain(
      "too late",
    )
  })

  it("the answer never appears in any frame or log — only in the resolved promise", async () => {
    const h = make()
    h.bridge.registerClient("A", h.wire("A"))
    h.bridge.registerClient("B", h.wire("B"))
    const p = h.bridge.request(REQ)
    const replies: OutFrame[] = []
    h.bridge.acceptResult(
      {
        type: "job-input-result",
        requestId: requestIdFrom(h, "A"),
        answer: "OPERATOR_ANSWER_42",
      },
      (f) => replies.push(f),
    )
    const res = await p
    expect(res).toEqual({ ok: true, answer: "OPERATOR_ANSWER_42" })

    const everything = JSON.stringify([
      ...h.frames.values(),
      replies,
      h.logs,
    ])
    expect(everything).not.toContain("OPERATOR_ANSWER_42")
  })
})

describe("JobInputBridge — cancel / timeout / no clients", () => {
  it("cancel resolves {ok:false, cancelled-message}; the canceller is acked", async () => {
    const h = make()
    h.bridge.registerClient("A", h.wire("A"))
    const p = h.bridge.request(REQ)
    const replies: OutFrame[] = []
    h.bridge.acceptResult(
      { type: "job-input-result", requestId: requestIdFrom(h, "A"), cancelled: true },
      (f) => replies.push(f),
    )
    const res = await p
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message.toLowerCase()).toContain("cancel")
    expect((replies[0] as JobInputStatusFrame).ok).toBe(true)
  })

  it("an empty answer counts as a cancel (no silent empty-string deliveries)", async () => {
    const h = make()
    h.bridge.registerClient("A", h.wire("A"))
    const p = h.bridge.request(REQ)
    h.bridge.acceptResult(
      { type: "job-input-result", requestId: requestIdFrom(h, "A"), answer: "" },
      h.wire("A-reply"),
    )
    const res = await p
    expect(res.ok).toBe(false)
  })

  it("times out → resolves {ok:false, timed out} and broadcasts a dismissal status", async () => {
    vi.useFakeTimers()
    try {
      const h = make()
      h.bridge.registerClient("A", h.wire("A"))
      h.bridge.registerClient("B", h.wire("B"))
      const p = h.bridge.request({ ...REQ, timeoutMs: 5_000 })
      vi.advanceTimersByTime(5_001)
      const res = await p
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.message.toLowerCase()).toContain("timed out")
      // every client got the expiry status so its panel can dismiss
      for (const id of ["A", "B"]) {
        const status = h.frames
          .get(id)!
          .find((f) => f.type === "job-input-status") as JobInputStatusFrame
        expect(status.ok).toBe(false)
      }
      // an answer after expiry is acked already-answered/expired
      const late: OutFrame[] = []
      h.bridge.acceptResult(
        { type: "job-input-result", requestId: requestIdFrom(h, "A"), answer: "late" },
        (f) => late.push(f),
      )
      expect((late[0] as JobInputStatusFrame).ok).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("resolves {ok:false} immediately when no client is registered", async () => {
    const h = make()
    const res = await h.bridge.request(REQ)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain("No connected")
  })
})

describe("JobInputBridge — one pending request per run", () => {
  it("a second request for the SAME run fails cleanly while one is pending", async () => {
    const h = make()
    h.bridge.registerClient("A", h.wire("A"))
    const p1 = h.bridge.request(REQ)
    const res2 = await h.bridge.request(REQ)
    expect(res2.ok).toBe(false)
    if (!res2.ok) expect(res2.message).toContain("already pending")
    // the live request is unaffected
    h.bridge.acceptResult(
      { type: "job-input-result", requestId: requestIdFrom(h, "A"), answer: "yes" },
      h.wire("A-reply"),
    )
    expect(await p1).toEqual({ ok: true, answer: "yes" })
  })

  it("a DIFFERENT run may request concurrently", async () => {
    const h = make()
    h.bridge.registerClient("A", h.wire("A"))
    const p1 = h.bridge.request(REQ)
    const p2 = h.bridge.request({ ...REQ, runId: 8 })
    const requests = h.frames
      .get("A")!
      .filter((f) => f.type === "job-input-request") as JobInputRequestFrame[]
    expect(requests).toHaveLength(2)
    const byRun = new Map(requests.map((r) => [r.runId, r.requestId]))
    h.bridge.acceptResult(
      { type: "job-input-result", requestId: byRun.get(7)!, answer: "one" },
      h.wire("r1"),
    )
    h.bridge.acceptResult(
      { type: "job-input-result", requestId: byRun.get(8)!, answer: "two" },
      h.wire("r2"),
    )
    expect(await p1).toEqual({ ok: true, answer: "one" })
    expect(await p2).toEqual({ ok: true, answer: "two" })
  })

  it("after a request settles, the same run may ask again", async () => {
    const h = make()
    h.bridge.registerClient("A", h.wire("A"))
    const p1 = h.bridge.request(REQ)
    h.bridge.acceptResult(
      { type: "job-input-result", requestId: requestIdFrom(h, "A"), answer: "first" },
      h.wire("r1"),
    )
    await p1
    const p2 = h.bridge.request(REQ)
    const second = h.frames
      .get("A")!
      .filter((f) => f.type === "job-input-request")[1] as JobInputRequestFrame
    h.bridge.acceptResult(
      { type: "job-input-result", requestId: second.requestId, answer: "second" },
      h.wire("r2"),
    )
    expect(await p2).toEqual({ ok: true, answer: "second" })
  })
})

describe("JobInputBridge — unregister safety", () => {
  it("unregistering an unknown/stale connId is a no-op for live clients and pending requests", async () => {
    const h = make()
    h.bridge.registerClient("A", h.wire("A"))
    const p = h.bridge.request(REQ)
    h.bridge.unregisterClient("ghost") // never registered
    h.bridge.unregisterClient("ghost") // double-unregister, still a no-op
    // request is still answerable
    h.bridge.acceptResult(
      { type: "job-input-result", requestId: requestIdFrom(h, "A"), answer: "ok" },
      h.wire("r"),
    )
    expect(await p).toEqual({ ok: true, answer: "ok" })
  })

  it("one client leaving does NOT fail a pending request while others remain", async () => {
    const h = make()
    h.bridge.registerClient("A", h.wire("A"))
    h.bridge.registerClient("B", h.wire("B"))
    const p = h.bridge.request(REQ)
    h.bridge.unregisterClient("A")
    h.bridge.acceptResult(
      { type: "job-input-result", requestId: requestIdFrom(h, "B"), answer: "from B" },
      h.wire("r"),
    )
    expect(await p).toEqual({ ok: true, answer: "from B" })
  })

  it("the LAST client leaving fails pending requests (nobody left to answer)", async () => {
    const h = make()
    h.bridge.registerClient("A", h.wire("A"))
    const p = h.bridge.request(REQ)
    h.bridge.unregisterClient("A")
    const res = await p
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain("No connected client")
  })

  it("a client that throws on send does not break the fan-out to healthy clients", async () => {
    const h = make()
    h.bridge.registerClient("broken", () => {
      throw new Error("socket died")
    })
    h.bridge.registerClient("B", h.wire("B"))
    const p = h.bridge.request(REQ)
    h.bridge.acceptResult(
      { type: "job-input-result", requestId: requestIdFrom(h, "B"), answer: "fine" },
      h.wire("r"),
    )
    expect(await p).toEqual({ ok: true, answer: "fine" })
  })
})

describe("JobInputBridge — outcome type sanity", () => {
  it("ok:true carries answer; ok:false carries message (discriminated)", async () => {
    const h = make()
    h.bridge.registerClient("A", h.wire("A"))
    const p: Promise<JobInputOutcome> = h.bridge.request(REQ)
    h.bridge.acceptResult(
      { type: "job-input-result", requestId: requestIdFrom(h, "A"), answer: "x" },
      h.wire("r"),
    )
    const res = await p
    if (res.ok) {
      expect(res.answer).toBe("x")
      expect((res as Record<string, unknown>)["message"]).toBeUndefined()
    } else {
      throw new Error("expected ok outcome")
    }
  })
})
