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
  buildWidgetToolsAddendum,
  makeMcpAppTools,
  makeOpenArtifactTool,
  makeSearchArtifactsTool,
  makeWidgetTools,
} from "../src/index.js"
import type { WidgetSummonerPort } from "../src/index.js"

/** A summoner double that records every openArtifact call. */
const makeFakeSummoner = (
  openResult: { ok: boolean; message: string } = { ok: true, message: "opened" },
) => {
  const opened: Array<{ artifactId: string; title: string; kind: string }> = []
  const port: WidgetSummonerPort = {
    directory: () => [],
    open: () => ({ ok: true, message: "ok" }),
    openArtifact: (artifactId, title, kind) => {
      opened.push({ artifactId, title, kind })
      return openResult
    },
  }
  return { port, opened }
}

const parseJson = <T,>(r: { content: Array<{ text: string }> }) =>
  JSON.parse(r.content[0]!.text) as T

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

  it("iterating a widget can change bridge_caps; omitting them leaves caps untouched", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        const [widgetWrite] = makeWidgetTools(store)
        yield* Effect.promise(() =>
          callTool(widgetWrite, {
            widgetId: "w",
            title: "W",
            html: "<p>1</p>",
            bridgeCaps: ["obs:*"],
          }),
        )
        // Iterate WITH narrower caps → caps tighten (review G3).
        yield* Effect.promise(() =>
          callTool(widgetWrite, { widgetId: "w", title: "W", html: "<p>2</p>", bridgeCaps: ["obs:ToolCall"] }),
        )
        const afterNarrow = (yield* store.get("widget:w"))?.bridgeCaps ?? null
        // Iterate WITHOUT caps → caps unchanged (not wiped).
        yield* Effect.promise(() =>
          callTool(widgetWrite, { widgetId: "w", title: "W", html: "<p>3</p>" }),
        )
        const afterOmit = (yield* store.get("widget:w"))?.bridgeCaps ?? null
        return { afterNarrow, afterOmit }
      }).pipe(Effect.provide(ArtifactStore.Memory), Effect.provide(Clock.Default)),
    )
    expect(out.afterNarrow).toEqual(["obs:ToolCall"])
    expect(out.afterOmit).toEqual(["obs:ToolCall"]) // omitted → preserved
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

  it("auto-opens the widget on CREATE, but NOT on iteration (no window churn)", async () => {
    const summoner = makeFakeSummoner()
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        const [widgetWrite] = makeWidgetTools(store, summoner.port)
        const created = parseJson<{ opened: boolean; action: string }>(
          yield* Effect.promise(() =>
            callTool(widgetWrite, { widgetId: "dash", title: "Dash", html: "<h1>1</h1>" }),
          ),
        )
        // Iterate the SAME slug — must not re-open.
        const updated = parseJson<{ opened?: boolean; action: string }>(
          yield* Effect.promise(() =>
            callTool(widgetWrite, { widgetId: "dash", title: "Dash", html: "<h1>2</h1>" }),
          ),
        )
        return { created, updated }
      }).pipe(Effect.provide(ArtifactStore.Memory), Effect.provide(Clock.Default)),
    ).then((out) => {
      expect(out.created).toMatchObject({ action: "created", opened: true })
      expect(out.updated.action).toBe("updated")
      // Exactly one open — the create — with the right id/kind.
      expect(summoner.opened).toEqual([
        { artifactId: "widget:dash", title: "Dash", kind: "widget" },
      ])
    })
  })

  it("widget_write without a summoner pins but reports opened:false (no host)", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        const [widgetWrite] = makeWidgetTools(store) // no summoner
        return parseJson<{ opened: boolean; action: string }>(
          yield* Effect.promise(() =>
            callTool(widgetWrite, { widgetId: "x", title: "X", html: "<p>x</p>" }),
          ),
        )
      }).pipe(Effect.provide(ArtifactStore.Memory), Effect.provide(Clock.Default)),
    )
    expect(out).toMatchObject({ action: "created", opened: false })
  })

  it("search_artifacts filters by title/id substring + kind, returns metadata only", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        yield* store.pin({ id: "widget:pr-99-tracker", kind: "widget", title: "PR #99 Tracker", content: "<h1>big html</h1>" })
        yield* store.pin({ id: "mcp-app:budget", kind: "mcp-app", title: "Budget App", content: "<html>app</html>" })
        yield* store.pin({ id: "doc:notes", kind: "markdown", title: "Meeting notes", content: "# notes" })
        const search = makeSearchArtifactsTool(store)
        const byTitle = parseJson<{ count: number; artifacts: Array<Record<string, unknown>> }>(
          yield* Effect.promise(() => callTool(search, { query: "pr #99" })),
        )
        const byKind = parseJson<{ count: number; artifacts: Array<{ kind: string }> }>(
          yield* Effect.promise(() => callTool(search, { kind: "mcp-app" })),
        )
        const all = parseJson<{ count: number }>(
          yield* Effect.promise(() => callTool(search, {})),
        )
        return { byTitle, byKind, all }
      }).pipe(Effect.provide(ArtifactStore.Memory), Effect.provide(Clock.Default)),
    )
    expect(out.byTitle.count).toBe(1)
    expect(out.byTitle.artifacts[0]).toMatchObject({ id: "widget:pr-99-tracker", kind: "widget" })
    // Metadata only — content must never cross into the model context.
    expect(out.byTitle.artifacts[0]).not.toHaveProperty("content")
    expect(out.byKind.count).toBe(1)
    expect(out.byKind.artifacts[0]!.kind).toBe("mcp-app")
    expect(out.all.count).toBe(3)
  })

  it("open_artifact reopens a known id via the summoner; unknown id fails helpfully", async () => {
    const summoner = makeFakeSummoner()
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        yield* store.pin({ id: "widget:dash", kind: "widget", title: "Dash", content: "<h1>x</h1>" })
        const open = makeOpenArtifactTool(store, summoner.port)
        const known = parseJson<{ ok: boolean }>(
          yield* Effect.promise(() => callTool(open, { artifactId: "widget:dash" })),
        )
        const unknown = parseJson<{ ok: boolean; message: string }>(
          yield* Effect.promise(() => callTool(open, { artifactId: "widget:nope" })),
        )
        return { known, unknown }
      }).pipe(Effect.provide(ArtifactStore.Memory), Effect.provide(Clock.Default)),
    )
    expect(out.known.ok).toBe(true)
    expect(summoner.opened).toEqual([{ artifactId: "widget:dash", title: "Dash", kind: "widget" }])
    expect(out.unknown.ok).toBe(false)
    expect(out.unknown.message).toContain("search_artifacts")
  })

  it("mcp_app_write creates a kind=mcp-app artifact, auto-opens it, iterates without re-opening", async () => {
    const summoner = makeFakeSummoner()
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        const [mcpAppWrite] = makeMcpAppTools(store, summoner.port)
        const c1 = parseJson<{ artifactId: string; version: number; action: string; opened: boolean }>(
          yield* Effect.promise(() =>
            callTool(mcpAppWrite, {
              appId: "dash",
              title: "Dashboard",
              html: "<div>v1</div>",
            }),
          ),
        )
        const c2 = parseJson<{ version: number; action: string }>(
          yield* Effect.promise(() =>
            callTool(mcpAppWrite, { appId: "dash", title: "Dashboard", html: "<div>v2</div>" }),
          ),
        )
        const head = yield* store.get("mcp-app:dash")
        return { c1, c2, head }
      }).pipe(Effect.provide(ArtifactStore.Memory), Effect.provide(Clock.Default)),
    )
    expect(out.c1).toMatchObject({ artifactId: "mcp-app:dash", version: 1, action: "created", opened: true })
    expect(out.c2).toMatchObject({ version: 2, action: "updated" })
    expect(out.head?.kind).toBe("mcp-app")
    // Auto-opened once, on create, with the mcp-app kind.
    expect(summoner.opened).toEqual([
      { artifactId: "mcp-app:dash", title: "Dashboard", kind: "mcp-app" },
    ])
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
    // S3 rubric is wired into the prompt addendum (no longer empty).
    expect(cfg.systemPromptAddendum).toContain("open_widget")
  })
})

describe("buildWidgetToolsAddendum (S3 best-guess rubric)", () => {
  it("names every tool path and omits the directory when no host is connected", () => {
    const a = buildWidgetToolsAddendum(null)
    for (const t of [
      "open_widget",
      "search_artifacts",
      "open_artifact",
      "widget_write",
      "mcp_app_write",
    ]) {
      expect(a).toContain(t)
    }
    expect(a).not.toContain("currently offers")
  })

  it("injects the live panel directory when a host announced one", () => {
    const summoner: WidgetSummonerPort = {
      directory: () => [
        { kind: "settings.voice", title: "Voice", description: "Voice settings" },
      ],
      open: () => ({ ok: true, message: "" }),
      openArtifact: () => ({ ok: true, message: "" }),
    }
    const a = buildWidgetToolsAddendum(summoner)
    expect(a).toContain("settings.voice — Voice settings")
  })
})
