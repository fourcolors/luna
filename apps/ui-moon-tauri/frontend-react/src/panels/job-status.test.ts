/**
 * job-status.test.ts — locks the shared job-`lastStatus` vocabulary.
 *
 * THE INCIDENT: the backend writes "fired"/"errored" and chat-server.ts forwards
 * the value unnormalized. The Briefing digest carried its own copy of the
 * vocabulary that knew only "failed"/"error"/"success", so a real job matched
 * NEITHER the attention branch nor the recent branch and disappeared from the
 * digest entirely. `dream-luna` failed 90 consecutive times over 30 days without
 * ever showing up there.
 *
 * The table below is the contract. Anything that renders a job status derives
 * from it; nothing re-implements it.
 */
import { describe, expect, it } from "vitest"
import {
  jobStatusClass,
  jobIsSettled,
  jobNeedsAttention,
  type JobStatusClass,
} from "./job-status"

describe("jobStatusClass — the backend's own vocabulary", () => {
  // These four are what the jobs store ACTUALLY writes. They are the reason
  // this module exists, so they are asserted first and explicitly.
  it('"fired" is a success — the real success value, not "success"', () => {
    expect(jobStatusClass("fired")).toBe("success")
  })
  it('"errored" is a failure — the value that was invisible for 30 days', () => {
    expect(jobStatusClass("errored")).toBe("failed")
  })
  it('"running" and "scheduled" classify as running / never', () => {
    expect(jobStatusClass("running")).toBe("running")
    expect(jobStatusClass("scheduled")).toBe("never")
  })
})

describe("jobStatusClass — full table", () => {
  const cases: ReadonlyArray<readonly [unknown, JobStatusClass]> = [
    // success family
    ["fired", "success"],
    ["success", "success"],
    ["ok", "success"],
    ["completed", "success"],
    // failure family
    ["errored", "failed"],
    ["failed", "failed"],
    ["fail", "failed"],
    ["error", "failed"],
    // in-flight
    ["running", "running"],
    ["started", "running"],
    ["waiting", "waiting"],
    // cancelled, both spellings
    ["cancelled", "cancelled"],
    ["canceled", "cancelled"],
    // nothing to report
    ["scheduled", "never"],
    [null, "never"],
    [undefined, "never"],
    ["", "never"],
    // untrusted junk off the wire must be total, never throw
    ["weird-value", "queued"],
    [42, "queued"],
    [{}, "queued"],
  ]
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(jobStatusClass(input)).toBe(expected)
    })
  }

  it("is case-insensitive", () => {
    expect(jobStatusClass("ERRORED")).toBe("failed")
    expect(jobStatusClass("Fired")).toBe("success")
  })
})

describe("jobNeedsAttention / jobIsSettled partition", () => {
  it("an errored job needs attention", () => {
    expect(jobNeedsAttention("errored")).toBe(true)
    expect(jobIsSettled("errored")).toBe(false)
  })
  it("a waiting job needs attention", () => {
    expect(jobNeedsAttention("waiting")).toBe(true)
  })
  it("a fired job is settled, not attention-worthy", () => {
    expect(jobIsSettled("fired")).toBe(true)
    expect(jobNeedsAttention("fired")).toBe(false)
  })
  it("a cancelled job is settled", () => {
    expect(jobIsSettled("cancelled")).toBe(true)
  })
  it("the two sets are disjoint for every known status", () => {
    for (const s of [
      "fired",
      "errored",
      "success",
      "failed",
      "running",
      "waiting",
      "cancelled",
      "scheduled",
      null,
      "junk",
    ]) {
      expect(jobNeedsAttention(s) && jobIsSettled(s)).toBe(false)
    }
  })
  it("a running / scheduled / unknown job is in NEITHER set (it is not news)", () => {
    for (const s of ["running", "scheduled", null, "junk"]) {
      expect(jobNeedsAttention(s)).toBe(false)
      expect(jobIsSettled(s)).toBe(false)
    }
  })
})
