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
 *
 * Review fix-round pins (07-review-opus.md, dim 6):
 *   (F5)  buildNewThreadFrame — the new-thread frame App.tsx sends carries
 *         `effort` for a capable model and omits it for an effort-less model
 *         (clamped against the SERVER matrix, never computed client-side)
 *   (F11) clampEffortToModel — a model switch clears a now-invalid persisted
 *         effort (moon `_selectModel` parity) and the effort control hides
 */
import { describe, expect, it, vi } from "vitest"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import {
  ChatPanel,
  buildNewThreadFrame,
  clampEffortToModel,
  type AvailableModel,
  type ChatPanelProps,
  type EffortLevel,
} from "../src/ChatPanel.jsx"
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

// ── Review F5 — new-thread frame carries effort only when the model supports it ──
//
// buildNewThreadFrame is the exact function both App.tsx new-thread sites
// (newThread + the /restart slash command) pass to send(). These tests assert
// the FRAME, not a re-implementation of the spread.

describe("buildNewThreadFrame — review F5: new-thread effort include/omit", () => {
  const MODELS = [SONNET, FABLE, HAIKU]

  it("carries effort for a capable model (fable + max)", () => {
    const frame = buildNewThreadFrame({
      model: FABLE.id,
      effort: "max",
      accountId: null,
      availableModels: MODELS,
    })
    expect(frame.type).toBe("new-thread")
    expect(frame.model).toBe(FABLE.id)
    expect(frame.effort).toBe("max")
  })

  it("omits effort for an effort-less model (haiku, efforts=[])", () => {
    const frame = buildNewThreadFrame({
      model: HAIKU.id,
      effort: "max",
      accountId: null,
      availableModels: MODELS,
    })
    expect(frame.model).toBe(HAIKU.id)
    expect("effort" in frame).toBe(false)
  })

  it("omits effort the selected model's list does not contain (sonnet + xhigh)", () => {
    // SONNET's server matrix is ["low","medium","high","max"] — no xhigh.
    const frame = buildNewThreadFrame({
      model: SONNET.id,
      effort: "xhigh",
      accountId: null,
      availableModels: MODELS,
    })
    expect("effort" in frame).toBe(false)
  })

  it("omits effort when availableModels is null (old server — fail closed)", () => {
    const frame = buildNewThreadFrame({
      model: FABLE.id,
      effort: "max",
      accountId: null,
      availableModels: null,
    })
    expect("effort" in frame).toBe(false)
  })

  it("omits effort when no effort is persisted", () => {
    const frame = buildNewThreadFrame({
      model: FABLE.id,
      effort: undefined,
      accountId: null,
      availableModels: MODELS,
    })
    expect("effort" in frame).toBe(false)
  })

  it("includes accountId when non-null, omits when null (pre-existing behavior preserved)", () => {
    const withAccount = buildNewThreadFrame({
      model: SONNET.id,
      accountId: "acct-1",
      availableModels: MODELS,
    })
    expect(withAccount.accountId).toBe("acct-1")
    const without = buildNewThreadFrame({
      model: SONNET.id,
      accountId: null,
      availableModels: MODELS,
    })
    expect("accountId" in without).toBe(false)
  })
})

// ── Review F11 — model switch clears a now-invalid persisted effort ──────────
//
// clampEffortToModel is the exact function App.tsx handleModelChange applies
// to cfg().effort on every model switch (undefined result → the key is
// dropped by JSON.stringify on save, mirroring moon's localStorage.removeItem).

describe("clampEffortToModel — review F11: stale-effort clamp", () => {
  const MODELS = [SONNET, FABLE, HAIKU]

  it("keeps an effort the new model supports (fable + max)", () => {
    expect(clampEffortToModel(MODELS, FABLE.id, "max")).toBe("max")
  })

  it("clears effort when the new model's efforts is empty (haiku + max)", () => {
    expect(clampEffortToModel(MODELS, HAIKU.id, "max")).toBeUndefined()
  })

  it("clears effort when the new model's efforts list lacks it (sonnet + xhigh)", () => {
    expect(clampEffortToModel(MODELS, SONNET.id, "xhigh")).toBeUndefined()
  })

  it("clears effort when the model has no efforts field at all", () => {
    const bare: AvailableModel = { id: "claude-bare", label: "Bare" }
    expect(clampEffortToModel([bare], bare.id, "high")).toBeUndefined()
  })

  it("clears effort for an unknown model id", () => {
    expect(clampEffortToModel(MODELS, "claude-unknown", "high")).toBeUndefined()
  })

  it("clears effort when there is no server list (null / undefined)", () => {
    expect(clampEffortToModel(null, FABLE.id, "max")).toBeUndefined()
    expect(clampEffortToModel(undefined, FABLE.id, "max")).toBeUndefined()
  })

  it("passes undefined through", () => {
    expect(clampEffortToModel(MODELS, FABLE.id, undefined)).toBeUndefined()
  })
})

describe("ChatPanel + clamp — review F11: effort=max persisted, switch to efforts=[] model", () => {
  it("effort is cleared from the config shape and the effort control hides", () => {
    const rig = mount({
      availableModels: [FABLE, HAIKU],
      effortSelection: true,
      model: FABLE.id,
      effort: "max",
    })
    try {
      // Visible while fable (supports max) is selected.
      expect(effortSelect(rig.container)).not.toBeNull()
      expect(effortSelect(rig.container)!.value).toBe("max")

      // The user switches to haiku. App.tsx handleModelChange applies this
      // exact clamp to cfg().effort:
      const cleared = clampEffortToModel([FABLE, HAIKU], HAIKU.id, "max")
      expect(cleared).toBeUndefined()
      // …and the persisted localStorage form drops the key entirely
      // (JSON.stringify elides undefined values):
      expect(
        JSON.stringify({ model: HAIKU.id, effort: cleared }),
      ).not.toContain("effort")

      // Reflect the post-switch props (model=haiku, effort=undefined) the
      // way App.tsx re-renders the panel — the effort control must hide.
      rig.setModel(HAIKU.id)
      rig.setEffort(cleared)
      expect(effortSelect(rig.container)).toBeNull()
      // Model control stays.
      expect(modelSelect(rig.container)).not.toBeNull()
    } finally {
      rig.dispose()
    }
  })
})
