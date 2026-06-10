/**
 * widget-tools tests — describe-to-spawn authoring (PRD W4 §16).
 *
 * Load-bearing assertions:
 *   - widget_write CREATES a kind="widget" artifact at id `widget:<slug>` v1
 *   - writing the SAME slug again ITERATES to v2 (the surgical-diff loop), with
 *     the version ledger preserved for time-travel revert
 *   - bridge_caps are sanitized to obs:* / obs:<Kind> only (fail closed) so a
 *     widget can never request a scope the bridge does not implement
 *   - the server config shape matches what ThreadToolsProvider merges
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { ArtifactStore, Clock } from "@luna/core"
import {
  WidgetToolsLayer,
  WidgetToolsService,
  makeWidgetTools,
} from "../src/index.js"

/** Run the SDK-shaped tool handler the way the SDK would (Promise API). The
 *  tool's handler is typed to its own arg shape; the test drives it via the
 *  generic SDK boundary, so widen to the runtime call signature. */
const callTool = async (
  tool: { handler: (...a: never[]) => Promise<unknown> },
  args: unknown,
) =>
  (await (tool.handler as (a: unknown, e: unknown) => Promise<unknown>)(args, {})) as {
    isError?: boolean
    content: Array<{ type: string; text: string }>
  }

const parse = (r: { content: Array<{ text: string }> }) =>
  JSON.parse(r.content[0]!.text) as {
    artifactId: string
    version: number
    action: "created" | "updated"
  }

describe("widget_write tool", () => {
  it("creates a kind=widget artifact, then iterates the SAME slug to a new version", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        const [widgetWrite] = makeWidgetTools(store)
        const r1 = yield* Effect.promise(() =>
          callTool(widgetWrite, {
            widgetId: "pr-99-tracker",
            title: "PR #99",
            html: "<h1>v1</h1>",
            bridgeCaps: ["obs:ToolCall"],
          }),
        )
        const r2 = yield* Effect.promise(() =>
          callTool(widgetWrite, {
            widgetId: "pr-99-tracker",
            title: "PR #99",
            html: "<h1>v2</h1>",
          }),
        )
        const head = yield* store.get("widget:pr-99-tracker")
        const versions = yield* store.versions("widget:pr-99-tracker")
        return { c1: parse(r1), c2: parse(r2), head, versions }
      }).pipe(Effect.provide(ArtifactStore.Memory), Effect.provide(Clock.Default)),
    )

    expect(out.c1).toMatchObject({
      artifactId: "widget:pr-99-tracker",
      version: 1,
      action: "created",
    })
    expect(out.c2).toMatchObject({ version: 2, action: "updated" })
    expect(out.head?.kind).toBe("widget")
    expect(out.head?.content).toBe("<h1>v2</h1>")
    // The ledger keeps both versions for time-travel revert.
    expect(out.versions.map((v) => v.content)).toEqual(["<h1>v1</h1>", "<h1>v2</h1>"])
    expect(out.versions.every((v) => v.editedBy === "agent")).toBe(true)
  })

  it("sanitizes bridge_caps — drops anything that is not obs:* / obs:<Kind>", async () => {
    const caps = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        const [widgetWrite] = makeWidgetTools(store)
        yield* Effect.promise(() =>
          callTool(widgetWrite, {
            widgetId: "scoped",
            title: "Scoped",
            html: "<p>x</p>",
            bridgeCaps: ["obs:ToolCall", "evil:scope", "obs:*", "fetch", "obs:"],
          }),
        )
        const head = yield* store.get("widget:scoped")
        return head?.bridgeCaps ?? null
      }).pipe(Effect.provide(ArtifactStore.Memory), Effect.provide(Clock.Default)),
    )
    expect(caps).toEqual(["obs:ToolCall", "obs:*"])
  })

  it("a static widget (no bridgeCaps) stores null caps — no live-data door", async () => {
    const caps = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        const [widgetWrite] = makeWidgetTools(store)
        yield* Effect.promise(() =>
          callTool(widgetWrite, { widgetId: "static", title: "S", html: "<p>hi</p>" }),
        )
        const head = yield* store.get("widget:static")
        return head?.bridgeCaps ?? null
      }).pipe(Effect.provide(ArtifactStore.Memory), Effect.provide(Clock.Default)),
    )
    expect(caps).toBeNull()
  })

  it("exposes the widget_tools server config shape (ThreadToolsProvider contract)", async () => {
    const cfg = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* WidgetToolsService
      }).pipe(
        Effect.provide(WidgetToolsLayer()),
        Effect.provide(ArtifactStore.Memory),
        Effect.provide(Clock.Default),
      ),
    )
    expect(cfg.serverName).toBe("widget_tools")
    expect(cfg.server).toBeDefined()
    expect(typeof cfg.createSessionBinding).toBe("function")
  })
})
