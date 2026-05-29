/**
 * store.test.ts — unit tests for TuiStore derived predicates.
 *
 * Phase 3 D3 fix: verifies the `chatInputActive` gate that prevents the chat
 * Input from being mounted while a survey modal owns exclusive key focus.
 *
 * Pure signal logic — no terminal, no JSX required.
 */
import { describe, expect, it } from "vitest"
import { createTuiStore } from "./store.js"
import type { PendingSurvey } from "@luna/core"

const FAKE_SURVEY: PendingSurvey = {
  issuedAt: 9000,
  items: [
    { id: "sq-9000", kind: "task_quality", prompt: "How aligned?", ref: "task_quality" },
  ],
}

describe("chatInputActive gate (Phase 3 D3 exclusive-focus fix)", () => {
  it("is true when no survey is active (null)", () => {
    const store = createTuiStore()
    // Initial state: no survey pending.
    expect(store.survey()).toBeNull()
    expect(store.chatInputActive()).toBe(true)
  })

  it("is false when a survey is set (modal owns key focus)", () => {
    const store = createTuiStore()
    store.setSurvey(FAKE_SURVEY)
    expect(store.chatInputActive()).toBe(false)
  })

  it("returns to true when the survey is cleared (chat input resumes)", () => {
    const store = createTuiStore()
    store.setSurvey(FAKE_SURVEY)
    expect(store.chatInputActive()).toBe(false)

    store.setSurvey(null)
    expect(store.chatInputActive()).toBe(true)
  })
})
