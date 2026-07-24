import { describe, expect, it } from "vitest"
import { attentionMeta, groupWorkflows, relativeTime, scheduleLabel, statusDotClass } from "./model"

const NOW = 1_718_000_000_000

describe("relativeTime", () => {
  it("returns null for a falsy epoch", () => {
    expect(relativeTime(null, NOW)).toBeNull()
    expect(relativeTime(undefined, NOW)).toBeNull()
    expect(relativeTime(0, NOW)).toBeNull()
  })
  it("returns 'just now' under 60s", () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe("just now")
  })
  it("returns minutes under an hour", () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago")
  })
  it("returns hours under a day", () => {
    expect(relativeTime(NOW - 2 * 3600_000, NOW)).toBe("2h ago")
  })
  it("returns days otherwise", () => {
    expect(relativeTime(NOW - 3 * 86400_000, NOW)).toBe("3d ago")
  })
})

describe("scheduleLabel", () => {
  it("joins schedule + next-run relative time", () => {
    // relativeTime() clamps `now - epochMs` at 0 (ported verbatim from the
    // vanilla module) — it has no future-vs-past distinction, so a future
    // nextRunAt always reads as "next just now" rather than a countdown.
    expect(scheduleLabel({ schedule: "0 9 * * 1", nextRunAt: NOW + 2 * 86400_000 }, NOW)).toBe(
      "0 9 * * 1 · next just now",
    )
    // A PAST nextRunAt (an overdue scheduled run) does render a real span.
    expect(scheduleLabel({ schedule: "0 9 * * 1", nextRunAt: NOW - 2 * 3600_000 }, NOW)).toBe(
      "0 9 * * 1 · next 2h ago",
    )
  })
  it("returns null with neither schedule nor nextRunAt", () => {
    expect(scheduleLabel({ schedule: null, nextRunAt: null }, NOW)).toBeNull()
  })
  it("returns just the schedule when there is no nextRunAt", () => {
    expect(scheduleLabel({ schedule: "0 3 * * *", nextRunAt: null }, NOW)).toBe("0 3 * * *")
  })
})

describe("attentionMeta", () => {
  it("waiting: 'Waiting for input' + relative lastRun", () => {
    expect(attentionMeta({ lastStatus: "waiting", lastRun: NOW - 30 * 60_000 }, NOW)).toBe(
      "Waiting for input · 30m ago",
    )
  })
  it("failed: 'Failed' + relative lastRun", () => {
    expect(attentionMeta({ lastStatus: "failed", lastRun: NOW - 3 * 3600_000 }, NOW)).toBe("Failed · 3h ago")
  })
  it("error status also reads as Failed", () => {
    expect(attentionMeta({ lastStatus: "error", lastRun: null }, NOW)).toBe("Failed")
  })
})

describe("statusDotClass", () => {
  it("maps every known status string", () => {
    expect(statusDotClass("waiting")).toBe("waiting")
    expect(statusDotClass("failed")).toBe("failed")
    expect(statusDotClass("error")).toBe("failed")
    expect(statusDotClass("success")).toBe("success")
    expect(statusDotClass("ok")).toBe("success")
    expect(statusDotClass("completed")).toBe("success")
    expect(statusDotClass("running")).toBe("running")
    expect(statusDotClass("started")).toBe("running")
    expect(statusDotClass("cancelled")).toBe("cancelled")
    expect(statusDotClass("queued")).toBe("queued")
    expect(statusDotClass(null)).toBeNull()
    expect(statusDotClass(undefined)).toBeNull()
  })
})

function wf(overrides: Partial<Parameters<typeof groupWorkflows>[0][number]>) {
  return {
    id: "id", label: "Label", kind: "agent", source: null,
    schedule: null, onDemand: true, enabled: true,
    nextRunAt: null, lastRun: null, lastStatus: null, createdAt: NOW,
    ...overrides,
  }
}

describe("groupWorkflows", () => {
  it("groups waiting/failed into attention, success/cancelled into recent (sorted by lastRun desc)", () => {
    const a = wf({ id: "a", lastStatus: "waiting" })
    const b = wf({ id: "b", lastStatus: "failed" })
    const c = wf({ id: "c", lastStatus: "success", lastRun: NOW - 1000 })
    const d = wf({ id: "d", lastStatus: "cancelled", lastRun: NOW - 5000 })
    const { attention, recent } = groupWorkflows([d, c, b, a])
    expect(attention.map((w) => w.id)).toEqual(["b", "a"])
    expect(recent.map((w) => w.id)).toEqual(["c", "d"])
  })

  it("puts any workflow with a schedule into scheduled, sorted by soonest nextRunAt (null last)", () => {
    const soon = wf({ id: "soon", schedule: "s", nextRunAt: NOW + 1000 })
    const later = wf({ id: "later", schedule: "s", nextRunAt: NOW + 5000 })
    const noNext = wf({ id: "no-next", schedule: "s", nextRunAt: null })
    const { scheduled } = groupWorkflows([later, noNext, soon])
    expect(scheduled.map((w) => w.id)).toEqual(["soon", "later", "no-next"])
  })

  it("a workflow can appear in both attention/recent AND scheduled independently", () => {
    const w = wf({ id: "both", lastStatus: "failed", schedule: "0 3 * * *" })
    const { attention, scheduled } = groupWorkflows([w])
    expect(attention.map((x) => x.id)).toEqual(["both"])
    expect(scheduled.map((x) => x.id)).toEqual(["both"])
  })

  it("never mutates the input array", () => {
    const input = [wf({ id: "b", lastStatus: "success", lastRun: 1 }), wf({ id: "a", lastStatus: "success", lastRun: 2 })]
    const copy = [...input]
    groupWorkflows(input)
    expect(input).toEqual(copy)
  })
})
