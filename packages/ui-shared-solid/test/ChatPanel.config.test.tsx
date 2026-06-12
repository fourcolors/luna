// @vitest-environment jsdom
/**
 * ChatPanel model + effort cluster tests (Slice C §3C).
 *
 * Pins:
 *   (a) model control lists all models from props
 *   (b) effort control shows exactly the selected model's efforts
 *   (c) effort control hidden when effortSelection false/absent
 *   (d) effort control hidden when selected model's efforts is missing/empty
 *   (e) selections fire onModelChange / onEffortChange with the active threadId
 */
import { describe, expect, it, vi } from "vitest"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { ChatPanel, type AvailableModel, type ChatPanelProps, type EffortLevel } from "../src/ChatPanel.jsx"
import type { ThreadView } from "@luna/ui-shared/core"
import type { SessionSummary } from "@luna/ui-shared/core"

// ── helpers ──────────────────────────────────────────────────────────────────

const THREAD_ID = "thread-test-001"

const makeSummary = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: THREAD_ID,
  parentId: null,
  title: "Test thread",
  tags: [],
  createdAt: 1000,
  endedAt: null,
  model: "claude-sonnet-4-6",
  status: "active",
  lastMessageAt: null,
  lastMessagePreview: null,
  ...overrides,
})

const makeThread = (overrides: Partial<ThreadView> = {}): ThreadView => ({
  summary: makeSummary(),
  messages: [],
  throughSeq: -1,
  inFlight: null,
  lastError: null,
  artifacts: [],
  ...overrides,
})

const SONNET: AvailableModel = {
  id: "claude-sonnet-4-6",
  label: "Sonnet 4.6 — balanced",
  efforts: ["low", "medium", "high", "max"],
}

const FABLE: AvailableModel = {
  id: "claude-fable-5",
  label: "Fable 5 (1M context)",
  efforts: ["low", "medium", "high", "xhigh", "max"],
}

const HAIKU: AvailableModel = {
  id: "claude-haiku-4-5",
  label: "Haiku 4.5 — fastest",
  efforts: [],
}

interface Rig {
  readonly container: HTMLElement
  readonly modelChangeCalls: Array<{ threadId: string; model: string }>
  readonly effortChangeCalls: Array<{ threadId: string; effort: EffortLevel }>
  readonly setModel: (m: string) => void
  readonly setEffort: (e: EffortLevel | undefined) => void
  readonly setAvailableModels: (ms: ReadonlyArray<AvailableModel> | undefined) => void
  readonly setEffortSelection: (v: boolean | undefined) => void
  readonly dispose: () => void
}

const mount = (
  initialProps: Partial<ChatPanelProps> & { thread?: ThreadView | null } = {},
): Rig => {
  const container = document.createElement("div")
  document.body.appendChild(container)

  const modelChangeCalls: Rig["modelChangeCalls"] = []
  const effortChangeCalls: Rig["effortChangeCalls"] = []

  const [model, setModel] = createSignal<string>(
    initialProps.model ?? SONNET.id,
  )
  const [effort, setEffort] = createSignal<EffortLevel | undefined>(
    initialProps.effort,
  )
  const [availableModels, setAvailableModels] = createSignal<
    ReadonlyArray<AvailableModel> | undefined
  >(initialProps.availableModels)
  const [effortSelection, setEffortSelection] = createSignal<
    boolean | undefined
  >(initialProps.effortSelection)

  const thread: ThreadView | null =
    initialProps.thread !== undefined ? initialProps.thread : makeThread()

  const dispose = render(
    () => (
      <ChatPanel
        thread={thread}
        onSend={() => {}}
        onInterrupt={() => {}}
        disabled={false}
        enterToSend={false}
        availableModels={availableModels()}
        effortSelection={effortSelection()}
        model={model()}
        effort={effort()}
        onModelChange={(tid, m) => {
          modelChangeCalls.push({ threadId: tid, model: m })
        }}
        onEffortChange={(tid, e) => {
          effortChangeCalls.push({ threadId: tid, effort: e })
        }}
      />
    ),
    container,
  )

  return {
    container,
    modelChangeCalls,
    effortChangeCalls,
    setModel,
    setEffort,
    setAvailableModels,
    setEffortSelection,
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

const modelSelect = (c: HTMLElement) =>
  c.querySelector("select[aria-label='Model']") as HTMLSelectElement | null

const effortSelect = (c: HTMLElement) =>
  c.querySelector("select[aria-label='Effort']") as HTMLSelectElement | null

const change = (el: HTMLSelectElement, value: string) => {
  el.value = value
  el.dispatchEvent(new Event("change", { bubbles: true }))
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("ChatPanel config cluster — (a) model control lists models from props", () => {
  it("renders one <option> per model", () => {
    const rig = mount({
      availableModels: [SONNET, FABLE, HAIKU],
      effortSelection: true,
      model: SONNET.id,
    })
    try {
      const sel = modelSelect(rig.container)
      expect(sel).not.toBeNull()
      const options = Array.from(sel!.options).map((o) => o.value)
      expect(options).toContain(SONNET.id)
      expect(options).toContain(FABLE.id)
      expect(options).toContain(HAIKU.id)
      expect(options.length).toBe(3)
    } finally {
      rig.dispose()
    }
  })

  it("option text matches label from props", () => {
    const rig = mount({
      availableModels: [SONNET, FABLE],
      model: SONNET.id,
    })
    try {
      const sel = modelSelect(rig.container)
      const texts = Array.from(sel!.options).map((o) => o.text)
      expect(texts).toContain("Sonnet 4.6 — balanced")
      expect(texts).toContain("Fable 5 (1M context)")
    } finally {
      rig.dispose()
    }
  })

  it("cluster is hidden when availableModels prop is absent", () => {
    const rig = mount({ availableModels: undefined })
    try {
      expect(modelSelect(rig.container)).toBeNull()
    } finally {
      rig.dispose()
    }
  })

  it("cluster is hidden when availableModels is empty", () => {
    const rig = mount({ availableModels: [] })
    try {
      expect(modelSelect(rig.container)).toBeNull()
    } finally {
      rig.dispose()
    }
  })
})

describe("ChatPanel config cluster — (b) effort control shows selected model's efforts", () => {
  it("effort options match exactly the selected model's efforts array", () => {
    const rig = mount({
      availableModels: [SONNET, FABLE],
      effortSelection: true,
      model: SONNET.id,
    })
    try {
      const sel = effortSelect(rig.container)
      expect(sel).not.toBeNull()
      const options = Array.from(sel!.options).map((o) => o.value)
      expect(options).toEqual(["low", "medium", "high", "max"])
    } finally {
      rig.dispose()
    }
  })

  it("switching model updates effort options reactively", () => {
    const rig = mount({
      availableModels: [SONNET, FABLE],
      effortSelection: true,
      model: SONNET.id,
    })
    try {
      // Initially Sonnet: 4 effort levels
      expect(Array.from(effortSelect(rig.container)!.options).length).toBe(4)
      // Switch to Fable: 5 effort levels
      rig.setModel(FABLE.id)
      expect(Array.from(effortSelect(rig.container)!.options).length).toBe(5)
      const opts = Array.from(effortSelect(rig.container)!.options).map((o) => o.value)
      expect(opts).toEqual(["low", "medium", "high", "xhigh", "max"])
    } finally {
      rig.dispose()
    }
  })
})

describe("ChatPanel config cluster — (c) effort hidden when effortSelection false/absent", () => {
  it("effort select is absent when effortSelection is false", () => {
    const rig = mount({
      availableModels: [SONNET],
      effortSelection: false,
      model: SONNET.id,
    })
    try {
      expect(effortSelect(rig.container)).toBeNull()
    } finally {
      rig.dispose()
    }
  })

  it("effort select is absent when effortSelection is undefined", () => {
    const rig = mount({
      availableModels: [SONNET],
      effortSelection: undefined,
      model: SONNET.id,
    })
    try {
      expect(effortSelect(rig.container)).toBeNull()
    } finally {
      rig.dispose()
    }
  })
})

describe("ChatPanel config cluster — (d) effort hidden when selected model's efforts missing/empty", () => {
  it("effort select is absent when selected model has no efforts field", () => {
    const noEffortModel: AvailableModel = {
      id: "claude-no-effort",
      label: "No-effort model",
      // efforts field omitted
    }
    const rig = mount({
      availableModels: [noEffortModel],
      effortSelection: true,
      model: noEffortModel.id,
    })
    try {
      expect(effortSelect(rig.container)).toBeNull()
    } finally {
      rig.dispose()
    }
  })

  it("effort select is absent when selected model has empty efforts array (Haiku)", () => {
    const rig = mount({
      availableModels: [HAIKU],
      effortSelection: true,
      model: HAIKU.id,
    })
    try {
      expect(effortSelect(rig.container)).toBeNull()
    } finally {
      rig.dispose()
    }
  })

  it("effort select is present when a non-empty-effort model is selected alongside Haiku", () => {
    const rig = mount({
      availableModels: [HAIKU, SONNET],
      effortSelection: true,
      model: SONNET.id,
    })
    try {
      expect(effortSelect(rig.container)).not.toBeNull()
    } finally {
      rig.dispose()
    }
  })
})

describe("ChatPanel config cluster — (e) selections fire handlers with threadId", () => {
  it("onModelChange is called with the active threadId and selected model id", () => {
    const rig = mount({
      availableModels: [SONNET, FABLE],
      effortSelection: true,
      model: SONNET.id,
    })
    try {
      const sel = modelSelect(rig.container)!
      change(sel, FABLE.id)
      expect(rig.modelChangeCalls.length).toBe(1)
      expect(rig.modelChangeCalls[0]!.threadId).toBe(THREAD_ID)
      expect(rig.modelChangeCalls[0]!.model).toBe(FABLE.id)
    } finally {
      rig.dispose()
    }
  })

  it("onEffortChange is called with the active threadId and selected effort", () => {
    const rig = mount({
      availableModels: [SONNET],
      effortSelection: true,
      model: SONNET.id,
      effort: "low",
    })
    try {
      const sel = effortSelect(rig.container)!
      change(sel, "high")
      expect(rig.effortChangeCalls.length).toBe(1)
      expect(rig.effortChangeCalls[0]!.threadId).toBe(THREAD_ID)
      expect(rig.effortChangeCalls[0]!.effort).toBe("high")
    } finally {
      rig.dispose()
    }
  })

  it("onModelChange is not called when the cluster is hidden (no availableModels)", () => {
    const rig = mount({ availableModels: undefined })
    try {
      // No model select rendered — no interaction possible
      expect(modelSelect(rig.container)).toBeNull()
      expect(rig.modelChangeCalls.length).toBe(0)
    } finally {
      rig.dispose()
    }
  })

  it("onEffortChange is not called when effort is hidden due to empty efforts", () => {
    const rig = mount({
      availableModels: [HAIKU],
      effortSelection: true,
      model: HAIKU.id,
    })
    try {
      expect(effortSelect(rig.container)).toBeNull()
      expect(rig.effortChangeCalls.length).toBe(0)
    } finally {
      rig.dispose()
    }
  })
})
