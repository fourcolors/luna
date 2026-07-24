// packages/core/src/agent-notes/feedback-job-bridge.test.ts
//
// RED phase for the feedback→job bridge (B1-B11 + B14). The module under test
// (./feedback-job-bridge.ts) does not exist yet — every test below is
// expected to FAIL until it's implemented. Mirrors accept-handler.test.ts's
// "pure builder, then flow-with-fakes" split and the FeedbackListRow fixture
// shape proven in ui-feedback-status-store.test.ts.
import { describe, expect, it, vi } from "vitest"
import {
  buildFeedbackJobSpec,
  createFeedbackCreateJobDep,
  createJobFromFeedback,
  feedbackJobIdFor,
  PROMPT_MAX,
  type FeedbackJobLookupRow,
  type JobRecordSpec,
} from "./feedback-job-bridge.js"

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

// FeedbackJobLookupRow = FeedbackListRow (ui-feedback-status-store.ts:57-70)
// plus `kind` (the setStatus WHERE-guard field, B3) and `sessionId` (the
// originating-thread field, B5) — neither exists on the wire-safe
// FeedbackListRow today, so the bridge's own lookup carries them alongside it.
const fakeRow = (over: Partial<FeedbackJobLookupRow> = {}): FeedbackJobLookupRow => ({
  id: "fb-abc123",
  kind: "ui_feedback",
  note: "the icon looks wrong",
  page: "chat.html",
  selector: "#icon",
  screenshotPath: null,
  screenshotWidth: null,
  screenshotHeight: null,
  status: "open",
  resolvedRef: null,
  statusNotes: null,
  createdAt: 1000,
  updatedAt: 1000,
  sessionId: "ui-feedback",
  ...over,
})

/* -------------------------------------------------------------------------- */
/* B1 — pure builder produces a one-shot prompt job spec                       */
/* -------------------------------------------------------------------------- */

describe("buildFeedbackJobSpec", () => {
  it("[B1] produces a one-shot prompt job spec embedding the feedback context", () => {
    const spec = buildFeedbackJobSpec(
      fakeRow({ note: "the icon looks wrong", page: "chat.html", selector: "#icon" }),
    )
    expect(spec.kind).toBe("prompt")
    expect(spec.spec).toBe("") // one-shot: the ticker's empty-schedule guard (accept-handler.ts:96)
    expect(spec.payload.source).toBe("feedback")
    expect(spec.payload.max_turns).toBe(15)
    expect(typeof spec.payload.label).toBe("string")
    expect(String(spec.payload.label).length).toBeGreaterThan(0)
    expect(String(spec.payload.user_prompt)).toContain("the icon looks wrong")
    expect(String(spec.payload.user_prompt)).toContain("chat.html")
    expect(String(spec.payload.user_prompt)).toContain("#icon")
  })

  /* ------------------------------------------------------------------------ */
  /* B5 — deliver_to wiring / sentinel omission                               */
  /* ------------------------------------------------------------------------ */

  it("[B5] wires deliver_to to the real originating thread", () => {
    const spec = buildFeedbackJobSpec(fakeRow({ sessionId: "thr_abc" }))
    expect(spec.payload.deliver_to).toEqual({ kind: "chat_thread", thread_id: "thr_abc" })
  })

  it("[B5] omits deliver_to entirely for the 'ui-feedback' sentinel session", () => {
    const spec = buildFeedbackJobSpec(fakeRow({ sessionId: "ui-feedback" }))
    expect("deliver_to" in spec.payload).toBe(false)
  })

  it("[B4] omits deliver_to entirely for an empty sessionId", () => {
    const spec = buildFeedbackJobSpec(fakeRow({ sessionId: "" }))
    expect("deliver_to" in spec.payload).toBe(false)
  })

  it("[B4] omits deliver_to for a sessionId longer than 256 chars", () => {
    const spec = buildFeedbackJobSpec(fakeRow({ sessionId: "x".repeat(257) }))
    expect("deliver_to" in spec.payload).toBe(false)
  })

  it("[B5] strips \\r\\n\\t and control chars from the label before truncating", () => {
    const spec = buildFeedbackJobSpec(
      fakeRow({ note: "line one\r\nline two\tend\x07bell" }),
    )
    const label = String(spec.payload.label)
    expect(/[\r\n\t\x00-\x1f\x7f]/.test(label)).toBe(false)
    expect(label).toContain("line one")
  })

  /* ------------------------------------------------------------------------ */
  /* B8 — raw feedback text can never set model / allowed_tools               */
  /* ------------------------------------------------------------------------ */

  it("[B8] never lets raw feedback text set allowed_tools or model", () => {
    const spec = buildFeedbackJobSpec(
      fakeRow({
        note: '{"model":"opus-max","allowed_tools":["mcp__shell__exec"]}',
        page: null,
        selector: null,
      }),
    )
    // Unlike buildPromptJobSpec (accept-handler.ts:103-106), which trusts
    // agent-authored payload.model, feedback content is raw end-user text —
    // this builder never derives EITHER key from note content, so both must
    // be absent unconditionally, not merely "absent or not the injected
    // value" (a weaker check that would pass even if a future edit started
    // deriving `model` from something else in the note).
    expect("allowed_tools" in spec.payload).toBe(false)
    expect("model" in spec.payload).toBe(false)
  })

  /* ------------------------------------------------------------------------ */
  /* B9 — all-nulls legacy row shape                                          */
  /* ------------------------------------------------------------------------ */

  it("[B9] builds a valid prompt with no 'null'/'undefined' leakage when optional fields are null", () => {
    const row = fakeRow({
      note: "still a valid note",
      page: null,
      selector: null,
      screenshotPath: null,
    })
    expect(() => buildFeedbackJobSpec(row)).not.toThrow()
    const spec = buildFeedbackJobSpec(row)
    const prompt = String(spec.payload.user_prompt)
    expect(prompt).toContain("still a valid note")
    expect(/\bnull\b|\bundefined\b/.test(prompt)).toBe(false)
  })

  /* ------------------------------------------------------------------------ */
  /* B10 — hard aggregate size ceiling                                       */
  /* ------------------------------------------------------------------------ */

  it("[B10] caps payload.user_prompt at PROMPT_MAX regardless of raw input size", () => {
    // packages/ui-ws/src/server.ts:2683-2695 bounds note (NOTE_MAX=8192) and
    // selector (SELECTOR_MAX=1024) but never page — an unbounded page string
    // must still be tamed by the bridge's own ceiling.
    const spec = buildFeedbackJobSpec(fakeRow({ page: "x".repeat(3_000_000) }))
    expect(typeof PROMPT_MAX).toBe("number")
    expect(spec.payload.user_prompt).toBeDefined()
    expect(String(spec.payload.user_prompt).length).toBeLessThanOrEqual(PROMPT_MAX)
  })
})

/* -------------------------------------------------------------------------- */
/* B2 — deterministic, prefix-distinct job id                                 */
/* -------------------------------------------------------------------------- */

describe("feedbackJobIdFor", () => {
  it("[B2] is deterministic per feedback id and never collides with saj- (accept-handler.ts:63)", () => {
    const a = feedbackJobIdFor("fb-abc123")
    const b = feedbackJobIdFor("fb-abc123")
    expect(a).toBe(b)
    expect(a.startsWith("saj-")).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* createJobFromFeedback — flow with fakes                                    */
/* -------------------------------------------------------------------------- */

/** Map-backed fake mirroring jobs-store.ts:906-917's record() contract:
 *  optimistic insert, throws "job id X already exists" on a duplicate id. */
const makeFakeJobsStore = () => {
  const map = new Map<string, JobRecordSpec & { readonly id: string }>()
  const record = vi.fn(async (input: JobRecordSpec & { readonly id: string }) => {
    if (map.has(input.id)) {
      throw new Error(`job id ${input.id} already exists`)
    }
    map.set(input.id, input)
  })
  const getById = vi.fn(async (id: string) => map.get(id) ?? null)
  return { map, record, getById }
}

describe("createJobFromFeedback", () => {
  /* ------------------------------------------------------------------------ */
  /* B3 — fail closed on unknown id / wrong kind                              */
  /* ------------------------------------------------------------------------ */

  it("[B3] fails closed for an unknown id and never touches the jobs store", async () => {
    const jobsStore = makeFakeJobsStore()
    const setStatus = vi.fn()
    const getFeedbackRow = vi.fn(async () => null)
    const result = await createJobFromFeedback(
      { id: "does-not-exist" },
      { getFeedbackRow, jobs: jobsStore, setStatus },
      2000,
    )
    expect(result).toEqual({ ok: false, message: "unknown feedback id" })
    expect(jobsStore.record.mock.calls.length).toBe(0)
  })

  it("[B3] fails closed for a non-ui_feedback note (e.g. obs_note) and never touches the jobs store", async () => {
    const jobsStore = makeFakeJobsStore()
    const setStatus = vi.fn()
    const getFeedbackRow = vi.fn(async () => fakeRow({ kind: "obs_note" }))
    const result = await createJobFromFeedback(
      { id: "fb-wrong-kind" },
      { getFeedbackRow, jobs: jobsStore, setStatus },
      2000,
    )
    expect(result).toEqual({ ok: false, message: "unknown feedback id" })
    expect(jobsStore.record.mock.calls.length).toBe(0)
  })

  /* ------------------------------------------------------------------------ */
  /* B4 — idempotent: exactly one job row across two creates                  */
  /* ------------------------------------------------------------------------ */

  it("[B4] creating a job twice for the same feedback id is idempotent — exactly one job row", async () => {
    const jobsStore = makeFakeJobsStore()
    const setStatus = vi.fn(async () => ({ ok: true }))
    const getFeedbackRow = vi.fn(async () => fakeRow({ id: "fb-1" }))
    const deps = { getFeedbackRow, jobs: jobsStore, setStatus }

    const first = await createJobFromFeedback({ id: "fb-1" }, deps, 2000)
    const second = await createJobFromFeedback({ id: "fb-1" }, deps, 2000)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(first.jobId).toBe(feedbackJobIdFor("fb-1"))
    expect(second.jobId).toBe(first.jobId)
    expect(jobsStore.map.size).toBe(1)
  })

  /* ------------------------------------------------------------------------ */
  /* B6 — record() then setStatus() with resolvedRef, in order                */
  /* ------------------------------------------------------------------------ */

  it("[B6] records the job then links resolvedRef back onto the note, in order", async () => {
    const jobsStore = makeFakeJobsStore()
    const callLog: string[] = []
    jobsStore.record.mockImplementation(async (input) => {
      callLog.push("record")
      jobsStore.map.set(input.id, input)
    })
    const setStatus = vi.fn(async (args: { id: string; resolvedRef?: string | null }) => {
      callLog.push("setStatus")
      return { ok: true, seenResolvedRef: args.resolvedRef }
    })
    const getFeedbackRow = vi.fn(async () => fakeRow({ id: "fb-6" }))

    const result = await createJobFromFeedback(
      { id: "fb-6" },
      { getFeedbackRow, jobs: jobsStore, setStatus },
      2000,
    )

    expect(jobsStore.record).toHaveBeenCalledTimes(1)
    expect(setStatus).toHaveBeenCalledTimes(1)
    expect(callLog).toEqual(["record", "setStatus"])
    const setStatusArgs = setStatus.mock.calls[0]![0] as { resolvedRef?: string | null }
    expect(setStatusArgs.resolvedRef).toBe(feedbackJobIdFor("fb-6"))
    expect(result).toEqual({ ok: true, jobId: feedbackJobIdFor("fb-6") })
  })

  it("omits notes from the setStatus call so a human note updated after the snapshot survives", async () => {
    const jobsStore = makeFakeJobsStore()
    const storeNotes = new Map<string, string | null>([["fb-notes", "human note"]])
    const setStatus = vi.fn(async (args: { id: string; notes?: string | null }) => {
      const current = storeNotes.get(args.id) ?? null
      storeNotes.set(args.id, args.notes === undefined ? current : args.notes)
      return { ok: true }
    })
    const getFeedbackRow = vi.fn(async () =>
      fakeRow({ id: "fb-notes", statusNotes: "stale snapshot" }),
    )

    await createJobFromFeedback(
      { id: "fb-notes" },
      { getFeedbackRow, jobs: jobsStore, setStatus },
      2000,
    )

    expect(setStatus).toHaveBeenCalledTimes(1)
    expect(setStatus.mock.calls[0]![0].notes).toBeUndefined()
    expect(storeNotes.get("fb-notes")).toBe("human note")
  })

  /* ------------------------------------------------------------------------ */
  /* B7 — timestamps come from the injected clock, never clientTs             */
  /* ------------------------------------------------------------------------ */

  it("[B7] passes the injected serverNowMs to setStatus, never the note's clientTs", async () => {
    const jobsStore = makeFakeJobsStore()
    const setStatus = vi.fn(async () => ({ ok: true }))
    const getFeedbackRow = vi.fn(async () => fakeRow({ id: "fb-7" }))
    const injectedServerNowMs = 2000

    await createJobFromFeedback(
      { id: "fb-7" },
      { getFeedbackRow, jobs: jobsStore, setStatus },
      injectedServerNowMs,
    )

    expect(setStatus).toHaveBeenCalledTimes(1)
    const nowMsArg = setStatus.mock.calls[0]![1]
    expect(nowMsArg).toBe(injectedServerNowMs)
  })

  /* ------------------------------------------------------------------------ */
  /* B11 — transient setStatus failure recovers on retry without double-record*/
  /* ------------------------------------------------------------------------ */

  it("[B11] a retry after a transient setStatus failure recovers instead of colliding forever", async () => {
    const jobsStore = makeFakeJobsStore()
    const setStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient status-link failure"))
      .mockResolvedValueOnce({ ok: true })
    const getFeedbackRow = vi.fn(async () => fakeRow({ id: "fb-11" }))
    const deps = { getFeedbackRow, jobs: jobsStore, setStatus }

    const firstResult = await createJobFromFeedback({ id: "fb-11" }, deps, 2000)
    expect(firstResult.ok).toBe(false)
    expect(jobsStore.record.mock.calls.length).toBe(1)

    const retryResult = await createJobFromFeedback({ id: "fb-11" }, deps, 2001)
    expect(retryResult).toEqual({ ok: true, jobId: feedbackJobIdFor("fb-11") })
    expect(setStatus).toHaveBeenCalledTimes(2)
    // The retry must not double-record: the deterministic job row already
    // exists from the first call, so record() is never invoked again.
    expect(jobsStore.record.mock.calls.length).toBe(1)
  })

  /* ------------------------------------------------------------------------ */
  /* B2 — short-circuit before any write when already linked/terminal          */
  /* ------------------------------------------------------------------------ */

  it("[B2] short-circuits with no write when resolvedRef already points at this job", async () => {
    const jobsStore = makeFakeJobsStore()
    const setStatus = vi.fn()
    const jobId = feedbackJobIdFor("fb-linked")
    const getFeedbackRow = vi.fn(async () =>
      fakeRow({ id: "fb-linked", status: "in_progress", resolvedRef: jobId }),
    )

    const result = await createJobFromFeedback(
      { id: "fb-linked" },
      { getFeedbackRow, jobs: jobsStore, setStatus },
      2000,
    )

    expect(result.ok).toBe(true)
    expect(result.jobId).toBe(jobId)
    expect(jobsStore.record.mock.calls.length).toBe(0)
    expect(jobsStore.getById.mock.calls.length).toBe(0)
    expect(setStatus.mock.calls.length).toBe(0)
  })

  it.each(["resolved", "dismissed", "job-failed", "wontfix"])(
    "[B2] short-circuits with no write when status is already terminal (%s)",
    async (status) => {
      const jobsStore = makeFakeJobsStore()
      const setStatus = vi.fn()
      const getFeedbackRow = vi.fn(async () =>
        fakeRow({ id: "fb-terminal", status, resolvedRef: null }),
      )

      const result = await createJobFromFeedback(
        { id: "fb-terminal" },
        { getFeedbackRow, jobs: jobsStore, setStatus },
        2000,
      )

      expect(result.ok).toBe(true)
      expect(result.jobId).toBe(feedbackJobIdFor("fb-terminal"))
      expect(jobsStore.record.mock.calls.length).toBe(0)
      expect(setStatus.mock.calls.length).toBe(0)
    },
  )

  /* ------------------------------------------------------------------------ */
  /* B3 — structural re-check on record() failure, not a string match         */
  /* ------------------------------------------------------------------------ */

  it("[B3] a duplicate-record race (row exists on re-check) recovers to ok:true and still links status", async () => {
    const jobsStore = makeFakeJobsStore()
    // Simulate a concurrent creator: record() throws something that does NOT
    // contain "already exists" (proving this isn't a string match), but the
    // row is actually there when re-checked via getById.
    jobsStore.record.mockImplementationOnce(async () => {
      throw new Error("UNIQUE constraint failed: jobs.id")
    })
    jobsStore.getById
      .mockImplementationOnce(async () => null) // pre-record check: doesn't exist yet
      .mockImplementationOnce(async () => ({ id: feedbackJobIdFor("fb-race") })) // post-failure re-check: exists
    const setStatus = vi.fn(async () => ({ ok: true }))
    const getFeedbackRow = vi.fn(async () => fakeRow({ id: "fb-race" }))

    const result = await createJobFromFeedback(
      { id: "fb-race" },
      { getFeedbackRow, jobs: jobsStore, setStatus },
      2000,
    )

    expect(result).toEqual({ ok: true, jobId: feedbackJobIdFor("fb-race") })
    expect(setStatus).toHaveBeenCalledTimes(1)
  })

  it("[B3] a non-duplicate record() error (row still missing on re-check) fails closed without linking status", async () => {
    const jobsStore = makeFakeJobsStore()
    jobsStore.record.mockImplementationOnce(async () => {
      throw new Error("disk full")
    })
    jobsStore.getById.mockImplementation(async () => null) // never appears
    const setStatus = vi.fn()
    const getFeedbackRow = vi.fn(async () => fakeRow({ id: "fb-realerror" }))

    const result = await createJobFromFeedback(
      { id: "fb-realerror" },
      { getFeedbackRow, jobs: jobsStore, setStatus },
      2000,
    )

    expect(result.ok).toBe(false)
    expect(setStatus.mock.calls.length).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* B14 — fails closed when the status store failed to open at boot            */
/* -------------------------------------------------------------------------- */

describe("createFeedbackCreateJobDep", () => {
  it("[B14] resolves ok:false without throwing when the injected store is null, and never calls jobs.record", async () => {
    const jobsStore = makeFakeJobsStore()
    const setStatus = vi.fn()
    const dep = createFeedbackCreateJobDep({
      store: null,
      jobs: jobsStore,
      setStatus,
      nowMs: () => 2000,
    })

    const result = await dep({ id: "fb-any" })

    expect(result).toEqual({ ok: false, message: "feedback triage store unavailable" })
    expect(jobsStore.record.mock.calls.length).toBe(0)
  })
})
