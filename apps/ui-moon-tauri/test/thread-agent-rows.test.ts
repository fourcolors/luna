// @vitest-environment jsdom
/**
 * thread-agent-rows.test.ts — live subagents nested under their thread's row
 * in the sidebar (Mr. Cobb, 2026-08-26).
 *
 * WHAT REPLACED WHAT. A thread's first delegation used to make the SERVER
 * summon a separate "Agents" window (packages/ui-ws/src/server.ts's
 * `widgetSummoner.open("agents", ...)`, now deleted). The same broadcast the
 * panel read is now rendered as nested rows in the thread drawer instead, so
 * nothing opens unbidden.
 *
 * THE TWO ASSERTIONS THAT MATTER MOST, and why:
 *
 *  1. Nested rows must NOT carry the `.thread-row` class and must NOT be
 *     wrapped. Redock (threadDrawer._placeInsertGap) walks
 *     `querySelectorAll('.thread-row')` and `insertIndexForRatio` does index
 *     math over exactly that list. Share the class and every drop index
 *     shifts by however many agents happen to be running; wrap the rows and
 *     the drop gap is inserted into the wrong parent. Both failures are
 *     invisible to a screenshot and only show up as a thread landing in the
 *     wrong place mid-drag.
 *
 *  2. Rows self-clear when nothing is running. The bridge broadcasts the
 *     all-`done` snapshot and THEN clears its tree, so the last frame a
 *     client ever sees for a turn is a full tree of finished agents with
 *     nothing following it to retract them. Without the running-gate, every
 *     completed turn would leave its dead agents pinned under the thread
 *     forever.
 */
import { describe, it, expect } from "vitest"
import { renderThreadStrip, type ThreadStripCtx } from "../frontend-react/src/chat/threadStrip"
import {
  liveAgentsForThread,
  MAX_AGENT_DEPTH,
  MAX_AGENT_ROWS,
  type SubagentNode,
} from "../frontend-react/src/chat/threadList"
import type { ThreadRow } from "../frontend-react/src/chat/threadList"

function node(over: Partial<SubagentNode> & { id: string }): SubagentNode {
  return {
    parentId: null,
    name: "researcher",
    description: "look it up",
    status: "running",
    tool: null,
    toolCount: 0,
    ...over,
  }
}

function mount() {
  document.body.innerHTML =
    '<div id="thread-drawer"><div id="thread-drawer-list"></div><div id="thread-drawer-empty"></div></div>'
  return {
    drawerEl: document.getElementById("thread-drawer"),
    listEl: document.getElementById("thread-drawer-list"),
    emptyEl: document.getElementById("thread-drawer-empty"),
  }
}

function makeCtx(rows: ThreadRow[], over: Partial<ThreadStripCtx> = {}): ThreadStripCtx {
  return {
    ...mount(),
    rows,
    search: "",
    activeThreadId: null,
    preview: null,
    insertAt: -1,
    isBusy: () => false,
    relTime: () => "",
    wireRow: () => {},
    makeInsertGap: () => {
      const gap = document.createElement("div")
      gap.className = "thread-row-insert-gap"
      return gap
    },
    onRowKeyActivate: () => {},
    onPopOut: () => {},
    ...over,
  } as ThreadStripCtx
}

const agentEls = () =>
  Array.from(document.querySelectorAll("#thread-drawer-list .thread-agent-row")) as HTMLElement[]

describe("liveAgentsForThread", () => {
  it("returns the whole team while ANY member is still running", () => {
    const rows = liveAgentsForThread(
      { t1: [node({ id: "a", status: "done" }), node({ id: "b", status: "running" })] },
      "t1",
    )
    expect(rows.map((r) => r.node.id)).toEqual(["a", "b"])
  })

  it("returns nothing once every member has finished — the self-clear", () => {
    // The bridge's last broadcast of a turn is exactly this shape. If this
    // ever returns rows, dead agents accumulate under the thread until the
    // app restarts.
    const done = { t1: [node({ id: "a", status: "done" }), node({ id: "b", status: "error" })] }
    expect(liveAgentsForThread(done, "t1")).toEqual([])
  })

  it("returns nothing for an unknown thread, a null map, or an empty tree", () => {
    expect(liveAgentsForThread({ t1: [node({ id: "a" })] }, "t2")).toEqual([])
    expect(liveAgentsForThread(null, "t1")).toEqual([])
    expect(liveAgentsForThread({ t1: [] }, "t1")).toEqual([])
  })

  it("indents a child under its parent and caps the indent depth", () => {
    const rows = liveAgentsForThread(
      {
        t1: [
          node({ id: "a" }),
          node({ id: "b", parentId: "a" }),
          node({ id: "c", parentId: "b" }),
          node({ id: "d", parentId: "c" }),
        ],
      },
      "t1",
    )
    expect(rows.map((r) => r.depth)).toEqual([0, 1, MAX_AGENT_DEPTH, MAX_AGENT_DEPTH])
  })

  it("survives a cyclic parentId instead of hanging the render", () => {
    // Malformed server data must not be able to spin the drawer's paint.
    const rows = liveAgentsForThread(
      { t1: [node({ id: "a", parentId: "b" }), node({ id: "b", parentId: "a" })] },
      "t1",
    )
    expect(rows).toHaveLength(2)
  })

  it("caps how many agents ONE thread may push into the sidebar", () => {
    const many = Array.from({ length: MAX_AGENT_ROWS + 6 }, (_, i) => node({ id: `a${i}` }))
    expect(liveAgentsForThread({ t1: many }, "t1")).toHaveLength(MAX_AGENT_ROWS)
  })
})

describe("renderThreadStrip — nested agent rows", () => {
  it("paints agents directly after their OWN thread's row", () => {
    renderThreadStrip(
      makeCtx([{ id: "t1" }, { id: "t2" }], {
        agentRowsFor: (id) =>
          id === "t2" ? liveAgentsForThread({ t2: [node({ id: "x" })] }, "t2") : [],
      }),
    )
    const painted = Array.from(document.querySelectorAll("#thread-drawer-list > *")).map((el) =>
      (el as HTMLElement).className.split(" ")[0],
    )
    expect(painted).toEqual(["thread-row", "thread-row", "thread-agent-row"])
  })

  it("keeps agent rows OUT of the .thread-row list redock indexes", () => {
    // The invariant that protects drag-to-redock. See this file's header.
    renderThreadStrip(
      makeCtx([{ id: "t1" }, { id: "t2" }], {
        agentRowsFor: () => liveAgentsForThread({ t: [node({ id: "x" }), node({ id: "y" })] }, "t"),
      }),
    )
    const list = document.getElementById("thread-drawer-list")!
    expect(list.querySelectorAll(".thread-row")).toHaveLength(2)
    expect(list.querySelectorAll(".thread-agent-row")).toHaveLength(4)
    // Siblings, not descendants: a wrapper would misparent the drop gap.
    for (const el of agentEls()) expect(el.parentElement).toBe(list)
    for (const el of agentEls()) expect(el.classList.contains("thread-row")).toBe(false)
  })

  it("clears stale agent rows on the next paint", () => {
    const ctx = makeCtx([{ id: "t1" }], {
      agentRowsFor: () => liveAgentsForThread({ t: [node({ id: "x" })] }, "t"),
    })
    renderThreadStrip(ctx)
    expect(agentEls()).toHaveLength(1)
    // The turn ends: everything is done, so the gate returns nothing.
    renderThreadStrip({
      ...ctx,
      agentRowsFor: () => liveAgentsForThread({ t: [node({ id: "x", status: "done" })] }, "t"),
    } as ThreadStripCtx)
    expect(agentEls()).toHaveLength(0)
  })

  it("renders agent names as TEXT, never as markup", () => {
    renderThreadStrip(
      makeCtx([{ id: "t1" }], {
        agentRowsFor: () =>
          liveAgentsForThread(
            { t: [node({ id: "x", name: "<img src=x onerror=1>", tool: "<b>Read</b>" })] },
            "t",
          ),
      }),
    )
    const el = agentEls()[0]!
    expect(el.querySelector(".thread-agent-name")!.textContent).toBe("<img src=x onerror=1>")
    expect(el.querySelector("img"), "a server-provided name must never become an element").toBeNull()
    expect(el.querySelector(".thread-agent-tool b")).toBeNull()
  })

  it("shows the running agent's current tool, and the outcome once it stops", () => {
    const paint = (over: Partial<SubagentNode>) =>
      renderThreadStrip(
        makeCtx([{ id: "t1" }], {
          agentRowsFor: () =>
            liveAgentsForThread(
              { t: [node({ id: "x", ...over }), node({ id: "keepalive" })] },
              "t",
            ),
        }),
      )
    paint({ tool: "Grep", toolCount: 3 })
    expect(agentEls()[0]!.querySelector(".thread-agent-tool")!.textContent).toBe("Grep · 3 tools")
    paint({ status: "error" })
    expect(agentEls()[0]!.querySelector(".thread-agent-tool")!.textContent).toBe("failed")
  })

  it("paints nothing extra when the caller supplies no agentRowsFor", () => {
    // The pre-existing behavior stays byte-identical for any caller that has
    // not opted in.
    renderThreadStrip(makeCtx([{ id: "t1" }, { id: "t2" }]))
    expect(agentEls()).toHaveLength(0)
  })

  it("never lets a throwing agent source take the thread list down", () => {
    renderThreadStrip(
      makeCtx([{ id: "t1" }], {
        agentRowsFor: () => {
          throw new Error("boom")
        },
      }),
    )
    expect(document.querySelectorAll(".thread-row")).toHaveLength(1)
  })
})
