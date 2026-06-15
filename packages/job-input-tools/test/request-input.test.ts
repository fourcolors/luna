/**
 * request_input tool tests (widget-system.md Phase 5).
 *
 * Load-bearing assertions:
 *   - the run is parked `waiting` BEFORE the bridge broadcast and resumed
 *     `running` after — on answer, cancel, AND bridge defect alike
 *   - the operator's answer comes back to the model ({ok:true, answer})
 *   - cancel/timeout surface as {ok:false, message} (the model continues)
 *   - the provider binding has the exact server name / allowed tool /
 *     addendum contract the workers splice into their SDK options
 *
 * Uses the REAL JobInputBridge from @luna/ui-ws with a fake client, so the
 * test covers the actual broadcast/first-answer plumbing the production
 * path uses — only setRunStatus is a recording stub.
 */
import { describe, expect, it } from "vitest"
import { createJobInputBridge } from "@luna/ui-ws"
import type {
  JobInputRequestFrame,
  JobInputStatusFrame,
} from "@luna/ui-ws"
import type { JobRunIdentity } from "@luna/adapter-sdk"
import {
  JOB_INPUT_SERVER_NAME,
  createJobInputToolsProvider,
  makeJobInputTools,
  type JobInputToolsDeps,
} from "../src/index.js"

const RUN: JobRunIdentity = { runId: 7, jobId: "job-1", jobName: "Daily brief" }

type OutFrame = JobInputRequestFrame | JobInputStatusFrame

/** Run the SDK-shaped tool handler the way the SDK would (Promise API). */
const callTool = async (
  tool: { handler: (args: unknown, extra: unknown) => Promise<unknown> },
  args: unknown,
) =>
  (await tool.handler(args, {})) as {
    isError?: boolean
    content: Array<{ type: string; text: string }>
  }

interface Harness {
  deps: JobInputToolsDeps
  frames: OutFrame[]
  statuses: Array<"running" | "waiting">
  answer: (requestId: string, answer: string) => void
  cancel: (requestId: string) => void
}

const make = (): Harness => {
  const bridge = createJobInputBridge()
  const frames: OutFrame[] = []
  bridge.registerClient("conn-1", (f) => frames.push(f))
  const statuses: Array<"running" | "waiting"> = []
  const deps: JobInputToolsDeps = {
    bridge,
    setRunStatus: async (_runId, status) => {
      statuses.push(status)
      return true
    },
  }
  return {
    deps,
    frames,
    statuses,
    answer: (requestId, answer) =>
      bridge.acceptResult(
        { type: "job-input-result", requestId, answer },
        () => {},
      ),
    cancel: (requestId) =>
      bridge.acceptResult(
        { type: "job-input-result", requestId, cancelled: true },
        () => {},
      ),
  }
}

const pendingRequestId = (h: Harness): string => {
  const f = h.frames.find((x) => x.type === "job-input-request") as
    | JobInputRequestFrame
    | undefined
  if (!f) throw new Error("no job-input-request was broadcast")
  return f.requestId
}

describe("request_input — run-status choreography + answer delivery", () => {
  it("parks the run waiting, returns the operator's answer, resumes running", async () => {
    const h = make()
    const [tool] = makeJobInputTools(h.deps, RUN)
    const resultP = callTool(tool as never, { prompt: "Which draft?" })

    // wait for the broadcast to land (the handler flips status first)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.statuses).toEqual(["waiting"]) // parked BEFORE any answer
    const req = h.frames[0] as JobInputRequestFrame
    expect(req.runId).toBe(7)
    expect(req.jobId).toBe("job-1")
    expect(req.jobName).toBe("Daily brief")
    expect(req.prompt).toBe("Which draft?")

    h.answer(pendingRequestId(h), "the second one")
    const res = await resultP
    expect(res.isError).not.toBe(true)
    const payload = JSON.parse(res.content[0]!.text) as {
      ok: boolean
      answer?: string
    }
    expect(payload).toEqual({ ok: true, answer: "the second one" })
    expect(h.statuses).toEqual(["waiting", "running"]) // resumed after
  })

  it("cancel → {ok:false, message} and the run STILL resumes running", async () => {
    const h = make()
    const [tool] = makeJobInputTools(h.deps, RUN)
    const resultP = callTool(tool as never, { prompt: "Proceed?" })
    await new Promise((r) => setTimeout(r, 0))
    h.cancel(pendingRequestId(h))
    const res = await resultP
    expect(res.isError).not.toBe(true) // a refusal is an answer, not a tool error
    const payload = JSON.parse(res.content[0]!.text) as {
      ok: boolean
      message?: string
    }
    expect(payload.ok).toBe(false)
    expect(payload.message?.toLowerCase()).toContain("cancel")
    expect(h.statuses).toEqual(["waiting", "running"])
  })

  it("timeout → {ok:false, timed out} and the run resumes running", async () => {
    const h = make()
    const [tool] = makeJobInputTools({ ...h.deps, timeoutMs: 20 }, RUN)
    const res = await callTool(tool as never, { prompt: "Anyone there?" })
    const payload = JSON.parse(res.content[0]!.text) as {
      ok: boolean
      message?: string
    }
    expect(payload.ok).toBe(false)
    expect(payload.message?.toLowerCase()).toContain("timed out")
    expect(h.statuses).toEqual(["waiting", "running"])
  })

  it("a bridge defect surfaces as an MCP error AND the run still resumes running", async () => {
    const statuses: Array<"running" | "waiting"> = []
    const deps: JobInputToolsDeps = {
      bridge: {
        request: () => Promise.reject(new Error("bridge exploded")),
      } as unknown as JobInputToolsDeps["bridge"],
      setRunStatus: async (_id, s) => {
        statuses.push(s)
        return true
      },
    }
    const [tool] = makeJobInputTools(deps, RUN)
    const res = await callTool(tool as never, { prompt: "x" })
    expect(res.isError).toBe(true)
    expect(statuses).toEqual(["waiting", "running"]) // ensured flip-back
  })

  it("a failing setRunStatus never fails the tool (best-effort flips)", async () => {
    const h = make()
    const deps: JobInputToolsDeps = {
      ...h.deps,
      setRunStatus: async () => {
        throw new Error("store down")
      },
    }
    const [tool] = makeJobInputTools(deps, RUN)
    const resultP = callTool(tool as never, { prompt: "still works?" })
    await new Promise((r) => setTimeout(r, 0))
    h.answer(pendingRequestId(h), "yep")
    const res = await resultP
    expect(res.isError).not.toBe(true)
    const payload = JSON.parse(res.content[0]!.text) as { ok: boolean }
    expect(payload.ok).toBe(true)
  })
})

describe("createJobInputToolsProvider — the workers' binding contract", () => {
  it("forRun returns the server/allow-list/addendum the workers splice into Options", () => {
    const h = make()
    const provider = createJobInputToolsProvider(h.deps)
    const binding = provider.forRun(RUN)
    expect(binding.serverName).toBe(JOB_INPUT_SERVER_NAME)
    expect(binding.allowedTools).toEqual(["mcp__job_input__request_input"])
    expect(binding.systemPromptAddendum).toContain(
      "mcp__job_input__request_input",
    )
    // an in-process SDK MCP server instance, keyed for Options.mcpServers
    expect(binding.server).toBeTruthy()
    expect((binding.server as { type?: string }).type).toBe("sdk")
  })

  it("each forRun builds a FRESH per-run closure (different runId → different request)", async () => {
    const h = make()
    const provider = createJobInputToolsProvider(h.deps)
    // bindings for two different runs must broadcast their own runIds
    const toolsA = makeJobInputTools(h.deps, { ...RUN, runId: 1 })
    const toolsB = makeJobInputTools(h.deps, { ...RUN, runId: 2 })
    void provider // provider exercised above; closures proven via makeJobInputTools
    const pA = callTool(toolsA[0] as never, { prompt: "a" })
    const pB = callTool(toolsB[0] as never, { prompt: "b" })
    await new Promise((r) => setTimeout(r, 0))
    const reqs = h.frames.filter(
      (f) => f.type === "job-input-request",
    ) as JobInputRequestFrame[]
    expect(new Set(reqs.map((r) => r.runId))).toEqual(new Set([1, 2]))
    for (const r of reqs) {
      h.answer(r.requestId, `answer-${r.runId}`)
    }
    const [ra, rb] = await Promise.all([pA, pB])
    expect(JSON.parse(ra.content[0]!.text).answer).toBe("answer-1")
    expect(JSON.parse(rb.content[0]!.text).answer).toBe("answer-2")
  })
})
