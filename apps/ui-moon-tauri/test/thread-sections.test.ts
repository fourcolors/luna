// @vitest-environment jsdom
/**
 * thread-sections.test.ts — agent sidebar S5 pins.
 *
 * Layer 1: the PURE grouping (shouldGroupThreads / groupByAgent) — section
 * derivation from threads ∪ roster, orphan handling, recency-only ordering
 * (threadOrder is retired and must never leak in).
 *
 * Layer 2: renderThreadStrip's grouped path against real DOM — the
 * D4-critical invariant that headers are SIBLINGS of rows (rows stay
 * DIRECT children of the list element; redock's flat
 * querySelectorAll('.thread-row') + insertBefore contract breaks on any
 * wrapper), plus collapse, busy-on-header, the per-section "+", and the
 * flat path staying byte-equivalent when `grouped` is absent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  groupByAgent,
  shouldGroupThreads,
  visibleThreads,
  type ThreadRow,
} from "../frontend-react/src/chat/threadList"
import {
  renderThreadStrip,
  type ThreadStripCtx,
} from "../frontend-react/src/chat/threadStrip"

const t = (
  id: string,
  at: number,
  agentName?: string | null,
): ThreadRow => ({
  id,
  title: id,
  lastMessageAt: at,
  ...(agentName !== undefined ? { agentName } : {}),
})

const ROSTER = [
  { name: "advisor", description: "critiques" },
  { name: "dev-agent", description: "ships" },
]

// ── Layer 1: pure grouping ──────────────────────────────────────────────────

describe("shouldGroupThreads", () => {
  it("is OFF by default (PR2 pivot): sections require the explicit opt-in", () => {
    const threads = [t("a", 1, "advisor")]
    // Even with a full roster and filed threads, no flag = flat.
    expect(shouldGroupThreads({ serverSupportsAgents: true, agents: ROSTER, threads })).toBe(false)
    expect(
      shouldGroupThreads({
        serverSupportsAgents: true,
        agents: ROSTER,
        threads,
        sidebarSectionsEnabled: false,
      }),
    ).toBe(false)
  })

  it("opted-in: requires the capability, no active search, and something to group by", () => {
    const on = { sidebarSectionsEnabled: true as const }
    const threads = [t("a", 1, "advisor")]
    expect(shouldGroupThreads({ ...on, serverSupportsAgents: true, agents: ROSTER, threads: [] })).toBe(true)
    expect(shouldGroupThreads({ ...on, serverSupportsAgents: true, agents: [], threads })).toBe(true)
    // Nothing to group by → flat (one lonely General header reads worse).
    expect(shouldGroupThreads({ ...on, serverSupportsAgents: true, agents: [], threads: [t("a", 1)] })).toBe(false)
    // No capability → flat, regardless of data.
    expect(shouldGroupThreads({ ...on, serverSupportsAgents: false, agents: ROSTER, threads })).toBe(false)
    // Search always flattens.
    expect(
      shouldGroupThreads({ ...on, serverSupportsAgents: true, agents: ROSTER, threads, threadSearch: "x" }),
    ).toBe(false)
  })
})

describe("visibleThreads agentFilter (PR2 — the click-an-agent lookup)", () => {
  const inv = (id: string, at: number, involved: string[]): ThreadRow => ({
    id,
    title: id,
    lastMessageAt: at,
    involvedAgents: involved,
  })

  it("matches involvement OR created-under, and null leaves everything untouched", () => {
    const threads = [
      inv("delegated", 30, ["advisor", "auditor"]),
      t("filed", 20, "advisor"),
      inv("other", 10, ["dev-agent"]),
      t("plain", 5),
    ]
    expect(visibleThreads({ threads, agentFilter: "advisor" }).map((r) => r.id)).toEqual([
      "delegated",
      "filed",
    ])
    expect(visibleThreads({ threads, agentFilter: null }).map((r) => r.id)).toEqual([
      "delegated",
      "filed",
      "other",
      "plain",
    ])
  })

  it("composes with search: typing narrows within the agent's threads", () => {
    const threads = [
      { ...inv("alpha-report", 30, ["advisor"]), title: "alpha report" },
      { ...inv("beta-note", 20, ["advisor"]), title: "beta note" },
      { ...inv("alpha-other", 10, ["auditor"]), title: "alpha other" },
    ]
    expect(
      visibleThreads({ threads, agentFilter: "advisor", threadSearch: "alpha" }).map((r) => r.id),
    ).toEqual(["alpha-report"])
  })
})

describe("groupByAgent", () => {
  it("derives sections from threads ∪ roster: filed, empty-roster, orphan, general", () => {
    const rows = [
      t("adv-1", 100, "advisor"),
      t("gone-1", 90, "deleted-agent"), // orphan — roster no longer has it
      t("gen-1", 80, null),
      t("adv-2", 70, "advisor"),
    ]
    const sections = groupByAgent(rows, ROSTER)
    expect(sections.map((s) => s.label)).toEqual([
      "advisor", // most recent row (100)
      "deleted-agent", // 90
      "General", // 80
      "dev-agent", // empty roster section sinks last
    ])
    const orphan = sections.find((s) => s.label === "deleted-agent")!
    expect(orphan.known).toBe(false)
    const devAgent = sections.find((s) => s.label === "dev-agent")!
    expect(devAgent.known).toBe(true)
    expect(devAgent.rows).toEqual([])
    expect(sections.find((s) => s.label === "General")!.agentName).toBeNull()
  })

  it("sorts rows inside a section by recency and IGNORES a legacy threadOrder", () => {
    const state = {
      threads: [t("old", 10, "advisor"), t("new", 200, "advisor"), t("mid", 50, "advisor")],
      // A stale session-local order that would put "old" first — retired.
      threadOrder: ["old", "mid", "new"],
    }
    // visibleThreads still honors the rank branch (its own pins), but
    // groupByAgent re-sorts per section — the retirement seam.
    const sections = groupByAgent(visibleThreads(state), ROSTER)
    expect(sections[0]!.rows.map((r) => r.id)).toEqual(["new", "mid", "old"])
  })

  it("never renders an empty General section", () => {
    const sections = groupByAgent([t("a", 1, "advisor")], ROSTER)
    expect(sections.some((s) => s.agentName === null)).toBe(false)
  })
})

// ── Layer 2: the grouped strip against real DOM ─────────────────────────────

interface RigOpts {
  readonly rows: ReadonlyArray<ThreadRow>
  readonly grouped?: ThreadStripCtx["grouped"]
  readonly tagAgents?: boolean
  readonly search?: string
}

const renderRig = (opts: RigOpts) => {
  document.body.innerHTML =
    '<aside id="drawer"><div id="list"><div id="empty"></div></div></aside>'
  const listEl = document.getElementById("list")!
  const wireRow = vi.fn()
  renderThreadStrip({
    listEl,
    emptyEl: document.getElementById("empty"),
    drawerEl: document.getElementById("drawer"),
    rows: opts.rows,
    search: opts.search ?? "",
    activeThreadId: null,
    preview: null,
    insertAt: -1,
    isBusy: () => false,
    relTime: () => "now",
    wireRow,
    makeInsertGap: () => document.createElement("div"),
    onRowKeyActivate: () => {},
    onPopOut: () => {},
    ...(opts.tagAgents !== undefined ? { tagAgents: opts.tagAgents } : {}),
    ...(opts.grouped !== undefined ? { grouped: opts.grouped } : {}),
  })
  return { listEl, wireRow }
}

const section = (
  agentName: string | null,
  rows: ReadonlyArray<ThreadRow>,
  extra?: Partial<{ collapsed: boolean; busy: boolean; known: boolean }>,
) => ({
  agentName,
  label: agentName ?? "General",
  description: "",
  known: extra?.known ?? true,
  rows,
  collapsed: extra?.collapsed ?? false,
  busy: extra?.busy ?? false,
})

describe("renderThreadStrip (grouped)", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  it("renders headers as SIBLINGS: every .thread-row stays a DIRECT child of the list", () => {
    const rows = [t("a", 2, "advisor"), t("b", 1, null)]
    const { listEl, wireRow } = renderRig({
      rows,
      grouped: {
        sections: [section("advisor", [rows[0]!]), section(null, [rows[1]!])],
        onToggle: () => {},
        onNewThread: () => {},
      },
    })
    const rendered = listEl.querySelectorAll(".thread-row")
    expect(rendered.length).toBe(2)
    // THE redock contract: direct children, no wrappers.
    for (const row of rendered) expect(row.parentElement).toBe(listEl)
    expect(listEl.querySelectorAll(".thread-section-header").length).toBe(2)
    for (const h of listEl.querySelectorAll(".thread-section-header")) {
      expect(h.parentElement).toBe(listEl)
    }
    // Rows still went through the wireRow cycle (drag machinery untouched).
    expect(wireRow).toHaveBeenCalledTimes(2)
    // Grouped rows indent by class, not structure.
    expect(rendered[0]!.classList.contains("grouped")).toBe(true)
  })

  it("collapse hides a section's rows; busy surfaces on the collapsed header dot", () => {
    const rows = [t("a", 2, "advisor")]
    const { listEl } = renderRig({
      rows,
      grouped: {
        sections: [section("advisor", rows, { collapsed: true, busy: true })],
        onToggle: () => {},
        onNewThread: () => {},
      },
    })
    expect(listEl.querySelectorAll(".thread-row").length).toBe(0)
    const header = listEl.querySelector(".thread-section-header")!
    expect(header.getAttribute("aria-expanded")).toBe("false")
    expect(header.querySelector(".thread-section-dot")!.classList.contains("busy")).toBe(true)
  })

  it("the per-section + fires onNewThread without toggling, and only for known agents", () => {
    const onToggle = vi.fn()
    const onNewThread = vi.fn()
    const rows = [t("a", 2, "advisor"), t("o", 1, "gone")]
    const { listEl } = renderRig({
      rows,
      grouped: {
        sections: [
          section("advisor", [rows[0]!]),
          section("gone", [rows[1]!], { known: false }),
          section(null, []),
        ],
        onToggle,
        onNewThread,
      },
    })
    const plus = listEl.querySelectorAll(".thread-section-new")
    expect(plus.length).toBe(1) // advisor only — never orphans, never General
    ;(plus[0] as HTMLElement).click()
    expect(onNewThread).toHaveBeenCalledWith("advisor")
    expect(onToggle).not.toHaveBeenCalled()
    // Header click toggles; empty sections don't (nothing to collapse).
    ;(listEl.querySelectorAll(".thread-section-header")[0] as HTMLElement).click()
    expect(onToggle).toHaveBeenCalledWith("advisor")
  })

  it("flat path unchanged when grouped is absent; search mode tags rows instead", () => {
    const rows = [t("a", 2, "advisor"), t("b", 1)]
    const flat = renderRig({ rows })
    expect(flat.listEl.querySelectorAll(".thread-section-header").length).toBe(0)
    expect(flat.listEl.querySelectorAll(".thread-row-agent-tag").length).toBe(0)

    const searching = renderRig({ rows, tagAgents: true, search: "a" })
    const tags = searching.listEl.querySelectorAll(".thread-row-agent-tag")
    expect(tags.length).toBe(1) // only the filed row wears one
    expect(tags[0]!.textContent).toBe("advisor")
  })
})
