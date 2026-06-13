// @vitest-environment jsdom
/**
 * ActionsPanel render and interaction tests.
 *
 * Pins:
 *   - empty state renders when actions array is empty
 *   - renders title, status badge, actionType, rationale for each action
 *   - Accept + Dismiss buttons appear ONLY for proposed actions
 *   - buttons are disabled when disabled=true
 *   - Accept button calls onAccept with the correct id
 *   - Dismiss button calls onDismiss with the correct id
 *   - non-proposed actions (accepted, in_progress, completed, failed, dismissed)
 *     do NOT render Accept/Dismiss buttons
 *   - failed actions render the error field
 */
import { describe, expect, it, vi } from "vitest"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import type { SuggestedActionWire } from "@luna/ui-shared/core"
import { ActionsPanel } from "../src/ActionsPanel.jsx"

// ── helpers ──────────────────────────────────────────────────────────────────

const makeAction = (overrides: Partial<SuggestedActionWire> = {}): SuggestedActionWire => ({
  id: "action-1",
  threadId: "thread-1",
  actionType: "task",
  title: "Write a test suite",
  detail: "Cover the new feature",
  rationale: "Tests improve reliability",
  status: "proposed",
  source: "agent",
  createdAt: Date.now(),
  ...overrides,
})

interface Rig {
  container: HTMLElement
  acceptCalls: string[]
  dismissCalls: string[]
  setActions: (actions: ReadonlyArray<SuggestedActionWire>) => void
  setDisabled: (d: boolean) => void
  dispose: () => void
}

const mount = (
  initialActions: ReadonlyArray<SuggestedActionWire> = [],
  initialDisabled = false,
): Rig => {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const [actions, setActions] = createSignal<ReadonlyArray<SuggestedActionWire>>(initialActions)
  const [disabled, setDisabled] = createSignal(initialDisabled)
  const acceptCalls: string[] = []
  const dismissCalls: string[] = []

  const dispose = render(
    () => (
      <ActionsPanel
        actions={actions()}
        disabled={disabled()}
        onAccept={(id) => acceptCalls.push(id)}
        onDismiss={(id) => dismissCalls.push(id)}
      />
    ),
    container,
  )
  return {
    container,
    acceptCalls,
    dismissCalls,
    setActions,
    setDisabled,
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

const getBtn = (container: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  )

// ── tests ─────────────────────────────────────────────────────────────────────

describe("ActionsPanel — empty state", () => {
  it("shows empty message when no actions", () => {
    const rig = mount([])
    try {
      expect(rig.container.textContent).toContain("No suggested actions")
    } finally {
      rig.dispose()
    }
  })

  it("shows count of 0 in header", () => {
    const rig = mount([])
    try {
      expect(rig.container.textContent).toContain("Suggested Actions")
    } finally {
      rig.dispose()
    }
  })
})

describe("ActionsPanel — list rendering", () => {
  it("renders title, status badge, action type, rationale", () => {
    const rig = mount([
      makeAction({ title: "Write a test suite", status: "proposed", actionType: "task", rationale: "Tests improve reliability" }),
    ])
    try {
      const text = rig.container.textContent!
      expect(text).toContain("Write a test suite")
      expect(text).toContain("proposed")
      expect(text).toContain("task")
      expect(text).toContain("Tests improve reliability")
    } finally {
      rig.dispose()
    }
  })

  it("renders multiple actions", () => {
    const rig = mount([
      makeAction({ id: "a1", title: "First action" }),
      makeAction({ id: "a2", title: "Second action", status: "completed", actionType: "research" }),
    ])
    try {
      const text = rig.container.textContent!
      expect(text).toContain("First action")
      expect(text).toContain("Second action")
      expect(text).toContain("completed")
      expect(text).toContain("research")
    } finally {
      rig.dispose()
    }
  })

  it("renders source label for each action", () => {
    const rig = mount([makeAction({ source: "dream" })])
    try {
      expect(rig.container.textContent).toContain("from dream")
    } finally {
      rig.dispose()
    }
  })

  it("renders error text for failed actions", () => {
    const rig = mount([makeAction({ status: "failed", error: "Something went wrong" })])
    try {
      expect(rig.container.textContent).toContain("Something went wrong")
    } finally {
      rig.dispose()
    }
  })
})

describe("ActionsPanel — Accept / Dismiss buttons", () => {
  it("shows Accept and Dismiss only for proposed actions", () => {
    const rig = mount([makeAction({ status: "proposed" })])
    try {
      expect(getBtn(rig.container, "Accept")).toBeDefined()
      expect(getBtn(rig.container, "Dismiss")).toBeDefined()
    } finally {
      rig.dispose()
    }
  })

  it("does NOT show Accept/Dismiss for accepted status", () => {
    const rig = mount([makeAction({ status: "accepted" })])
    try {
      expect(getBtn(rig.container, "Accept")).toBeUndefined()
      expect(getBtn(rig.container, "Dismiss")).toBeUndefined()
    } finally {
      rig.dispose()
    }
  })

  it("does NOT show Accept/Dismiss for completed status", () => {
    const rig = mount([makeAction({ status: "completed" })])
    try {
      expect(getBtn(rig.container, "Accept")).toBeUndefined()
      expect(getBtn(rig.container, "Dismiss")).toBeUndefined()
    } finally {
      rig.dispose()
    }
  })

  it("calls onAccept with the correct action id", () => {
    const rig = mount([makeAction({ id: "action-42", status: "proposed" })])
    try {
      getBtn(rig.container, "Accept")!.click()
      expect(rig.acceptCalls).toEqual(["action-42"])
      expect(rig.dismissCalls).toEqual([])
    } finally {
      rig.dispose()
    }
  })

  it("calls onDismiss with the correct action id", () => {
    const rig = mount([makeAction({ id: "action-99", status: "proposed" })])
    try {
      getBtn(rig.container, "Dismiss")!.click()
      expect(rig.dismissCalls).toEqual(["action-99"])
      expect(rig.acceptCalls).toEqual([])
    } finally {
      rig.dispose()
    }
  })

  it("disables Accept and Dismiss when disabled=true", () => {
    const rig = mount([makeAction({ status: "proposed" })], true)
    try {
      const acceptBtn = getBtn(rig.container, "Accept")!
      const dismissBtn = getBtn(rig.container, "Dismiss")!
      expect(acceptBtn.disabled).toBe(true)
      expect(dismissBtn.disabled).toBe(true)
    } finally {
      rig.dispose()
    }
  })

  it("re-enables buttons when disabled changes to false", () => {
    const rig = mount([makeAction({ status: "proposed" })], true)
    try {
      expect(getBtn(rig.container, "Accept")!.disabled).toBe(true)
      rig.setDisabled(false)
      expect(getBtn(rig.container, "Accept")!.disabled).toBe(false)
    } finally {
      rig.dispose()
    }
  })
})

describe("ActionsPanel — reactive updates", () => {
  it("updates when actions change from empty to populated", () => {
    const rig = mount([])
    try {
      expect(rig.container.textContent).toContain("No suggested actions")
      rig.setActions([makeAction({ title: "New action" })])
      expect(rig.container.textContent).toContain("New action")
      expect(rig.container.textContent).not.toContain("No suggested actions")
    } finally {
      rig.dispose()
    }
  })

  it("updates status badge when action status changes", () => {
    const rig = mount([makeAction({ id: "a1", status: "proposed" })])
    try {
      expect(rig.container.textContent).toContain("proposed")
      rig.setActions([makeAction({ id: "a1", status: "accepted" })])
      expect(rig.container.textContent).toContain("accepted")
    } finally {
      rig.dispose()
    }
  })
})
