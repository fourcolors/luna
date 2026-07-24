// packages/core/src/agent-notes/feedback-job-observer.test.ts
//
// pollFeedbackJobsOnce is plain-Promise, so every test below drives it
// directly with fakes — no Effect runtime needed. Mirrors accept-handler.ts's
// completion-observer tests conceptually (list in-progress → check latest run
// → fold terminal status back), but against the ui_feedback_status surface.
import { describe, expect, it, vi } from "vitest"
import { pollFeedbackJobsOnce, type FeedbackJobObserverDeps } from "./feedback-job-observer.js"

const makeDeps = (
  over: Partial<FeedbackJobObserverDeps> = {},
): FeedbackJobObserverDeps => ({
  listQueued: vi.fn(async () => []),
  listRuns: vi.fn(async () => []),
  setStatus: vi.fn(async () => ({ ok: true })),
  nowMs: () => 5000,
  ...over,
})

describe("pollFeedbackJobsOnce", () => {
  it("marks a note resolved when its linked job's latest run succeeded", async () => {
    const setStatus = vi.fn(async () => ({ ok: true }))
    const deps = makeDeps({
      listQueued: vi.fn(async () => [{ id: "fb-1", resolvedRef: "fbj-fb-1" }]),
      listRuns: vi.fn(async (jobId: string) => {
        expect(jobId).toBe("fbj-fb-1")
        return [{ status: "success", finishedAt: 9999, error: null }]
      }),
      setStatus,
    })

    await pollFeedbackJobsOnce(deps)

    expect(setStatus).toHaveBeenCalledTimes(1)
    expect(setStatus.mock.calls[0]![0]).toEqual({
      id: "fb-1",
      status: "resolved",
      resolvedRef: "fbj-fb-1",
      notes: "auto: feedback job completed",
      expectedStatus: "queued",
      appendNotes: true,
    })
    expect(setStatus.mock.calls[0]![1]).toBe(5000)
  })

  it("marks a note job-failed with the run's error when the latest run failed", async () => {
    const setStatus = vi.fn(async () => ({ ok: true }))
    const deps = makeDeps({
      listQueued: vi.fn(async () => [{ id: "fb-2", resolvedRef: "fbj-fb-2" }]),
      listRuns: vi.fn(async () => [
        { status: "failed", finishedAt: 9999, error: "TypeError: boom" },
      ]),
      setStatus,
    })

    await pollFeedbackJobsOnce(deps)

    expect(setStatus).toHaveBeenCalledTimes(1)
    expect(setStatus.mock.calls[0]![0]).toEqual({
      id: "fb-2",
      status: "job-failed",
      resolvedRef: "fbj-fb-2",
      notes: "auto: feedback job failed: TypeError: boom",
      expectedStatus: "queued",
      appendNotes: true,
    })
  })

  it("treats a cancelled run the same as failed", async () => {
    const setStatus = vi.fn(async () => ({ ok: true }))
    const deps = makeDeps({
      listQueued: vi.fn(async () => [{ id: "fb-3", resolvedRef: "fbj-fb-3" }]),
      listRuns: vi.fn(async () => [{ status: "cancelled", finishedAt: 9999, error: null }]),
      setStatus,
    })

    await pollFeedbackJobsOnce(deps)

    expect(setStatus.mock.calls[0]![0]).toMatchObject({ status: "job-failed" })
  })

  it("caps a very long run error so the appended note stays bounded", async () => {
    const longError = "x".repeat(10_000)
    const setStatus = vi.fn(async () => ({ ok: true }))
    const deps = makeDeps({
      listQueued: vi.fn(async () => [{ id: "fb-long", resolvedRef: "fbj-fb-long" }]),
      listRuns: vi.fn(async () => [
        { status: "failed", finishedAt: 9999, error: longError },
      ]),
      setStatus,
    })

    await pollFeedbackJobsOnce(deps)

    expect(setStatus).toHaveBeenCalledTimes(1)
    const notes = String(setStatus.mock.calls[0]![0].notes)
    const prefix = "auto: feedback job failed: "
    expect(notes.startsWith(prefix)).toBe(true)
    expect(notes.length).toBeLessThanOrEqual(prefix.length + 500 + "...".length)
    expect(notes.endsWith("...")).toBe(true)
  })

  it("leaves a row alone when the latest run has not finished yet", async () => {
    const setStatus = vi.fn()
    const deps = makeDeps({
      listQueued: vi.fn(async () => [{ id: "fb-4", resolvedRef: "fbj-fb-4" }]),
      listRuns: vi.fn(async () => [{ status: "running", finishedAt: null, error: null }]),
      setStatus,
    })

    await pollFeedbackJobsOnce(deps)

    expect(setStatus).not.toHaveBeenCalled()
  })

  it("leaves a row alone when there is no run yet at all", async () => {
    const setStatus = vi.fn()
    const deps = makeDeps({
      listQueued: vi.fn(async () => [{ id: "fb-5", resolvedRef: "fbj-fb-5" }]),
      listRuns: vi.fn(async () => []),
      setStatus,
    })

    await pollFeedbackJobsOnce(deps)

    expect(setStatus).not.toHaveBeenCalled()
  })

  it("skips a row with resolvedRef:null without calling listRuns", async () => {
    const listRuns = vi.fn()
    const deps = makeDeps({
      listQueued: vi.fn(async () => [{ id: "fb-6", resolvedRef: null }]),
      listRuns,
    })

    await pollFeedbackJobsOnce(deps)

    expect(listRuns).not.toHaveBeenCalled()
  })

  it("skips a row whose resolvedRef is not a feedback job id (foreign prefix)", async () => {
    const listRuns = vi.fn()
    const deps = makeDeps({
      listQueued: vi.fn(async () => [{ id: "fb-7", resolvedRef: "saj-some-other-action" }]),
      listRuns,
    })

    await pollFeedbackJobsOnce(deps)

    expect(listRuns).not.toHaveBeenCalled()
  })

  it("is best-effort: a throwing listQueued never throws out of the tick", async () => {
    const deps = makeDeps({
      listQueued: vi.fn(async () => {
        throw new Error("db is down")
      }),
    })

    await expect(pollFeedbackJobsOnce(deps)).resolves.toBeUndefined()
  })

  it("is best-effort: a throwing listRuns for one row never blocks the rest of the batch", async () => {
    const setStatus = vi.fn(async () => ({ ok: true }))
    const deps = makeDeps({
      listQueued: vi.fn(async () => [
        { id: "fb-bad", resolvedRef: "fbj-fb-bad" },
        { id: "fb-good", resolvedRef: "fbj-fb-good" },
      ]),
      listRuns: vi.fn(async (jobId: string) => {
        if (jobId === "fbj-fb-bad") throw new Error("listRuns exploded")
        return [{ status: "success", finishedAt: 9999, error: null }]
      }),
      setStatus,
    })

    await pollFeedbackJobsOnce(deps)

    expect(setStatus).toHaveBeenCalledTimes(1)
    expect(setStatus.mock.calls[0]![0]).toMatchObject({ id: "fb-good" })
  })

  it("is best-effort: a throwing setStatus for one row never blocks the rest of the batch", async () => {
    const setStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce({ ok: true })
    const deps = makeDeps({
      listQueued: vi.fn(async () => [
        { id: "fb-bad", resolvedRef: "fbj-fb-bad" },
        { id: "fb-good", resolvedRef: "fbj-fb-good" },
      ]),
      listRuns: vi.fn(async () => [{ status: "success", finishedAt: 9999, error: null }]),
      setStatus,
    })

    await expect(pollFeedbackJobsOnce(deps)).resolves.toBeUndefined()
    expect(setStatus).toHaveBeenCalledTimes(2)
  })

  it("does not clobber a row that left 'queued' and appends outcome notes to surviving rows", async () => {
    type Row = { status: string; resolvedRef: string | null; notes: string | null }
    const rows = new Map<string, Row>([
      ["fb-race", { status: "queued", resolvedRef: "fbj-fb-race", notes: "human note" }],
      ["fb-keep", { status: "queued", resolvedRef: "fbj-fb-keep", notes: "keep me" }],
    ])
    const setStatus = vi.fn(async (args: { id: string; status: string; resolvedRef?: string | null; notes?: string | null; expectedStatus?: string; appendNotes?: boolean }) => {
      const row = rows.get(args.id)
      if (row === undefined) return { ok: false }
      if (args.expectedStatus !== undefined && row.status !== args.expectedStatus) {
        return { ok: false, message: "status precondition failed" }
      }
      row.status = args.status
      if (args.resolvedRef !== undefined) row.resolvedRef = args.resolvedRef ?? null
      if (args.notes !== undefined) {
        row.notes = args.appendNotes && row.notes ? `${row.notes}\n${args.notes}` : (args.notes ?? null)
      }
      return { ok: true }
    })
    const listQueued = vi.fn(async () =>
      Array.from(rows.entries())
        .filter(([, r]) => r.status === "queued")
        .map(([id, r]) => ({ id, resolvedRef: r.resolvedRef })),
    )
    const listRuns = vi.fn(async (jobId: string) => {
      if (jobId === "fbj-fb-race") {
        // Simulate a human/operator flipping the status after listQueued snapshotted it.
        rows.set("fb-race", { status: "triaged", resolvedRef: "fbj-fb-race", notes: "human already looked" })
      }
      return [{ status: "success", finishedAt: 9999, error: null }]
    })

    await pollFeedbackJobsOnce(makeDeps({ listQueued, listRuns, setStatus }))

    expect(rows.get("fb-race")?.status).toBe("triaged")
    expect(rows.get("fb-race")?.notes).toBe("human already looked")
    expect(rows.get("fb-keep")?.status).toBe("resolved")
    expect(rows.get("fb-keep")?.notes).toBe("keep me\nauto: feedback job completed")
    expect(setStatus).toHaveBeenCalledTimes(2)
  })

  it("respects the queueLimit passed through to listQueued", async () => {
    const listQueued = vi.fn(async () => [])
    const deps = makeDeps({ listQueued })

    await pollFeedbackJobsOnce(deps, 7)

    expect(listQueued).toHaveBeenCalledWith(7)
  })

  it("defaults the queue limit to 100 when not passed", async () => {
    const listQueued = vi.fn(async () => [])
    const deps = makeDeps({ listQueued })

    await pollFeedbackJobsOnce(deps)

    expect(listQueued).toHaveBeenCalledWith(100)
  })
})
