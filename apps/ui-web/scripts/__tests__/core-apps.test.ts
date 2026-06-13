/**
 * core-apps.test.ts — the CoreAppRegistry contract (widget-system.md Phase 7).
 *
 * Pins the load-bearing security shape of Luna's first MCP-app provider:
 *   - readResource resolves ONLY registered ui:// uris (never a file/URL fetch)
 *   - callTool enforces the spec's SAME-SERVER rule server-side: an app may
 *     only call tools registered on its own entry — even when the tool name
 *     exists on a different app, and even for prototype-chain names
 *   - handler defects collapse to ok:false (internals never reach the wire)
 *   - pulse-snapshot aggregates the EventCounter counter names correctly
 *   - the shipped workspace-pulse app html is a REAL MCP app (handshake +
 *     tools/call, no luna.* bridge usage, no external refs)
 */
import { describe, expect, it, vi } from "vitest"
import {
  MCP_APP_MIME_TYPE,
  STORE_APP_URI_PREFIX,
  artifactIdFromAppUri,
  buildCuratedAppTools,
  buildWorkspacePulseApp,
  composeAppRegistries,
  createCoreAppRegistry,
  createStoreBackedAppRegistry,
  pulseFromSnapshot,
  type CoreApp,
} from "../core-apps.js"

const PULSE_URI = "ui://luna/workspace-pulse"

const twoApps = (): { a: CoreApp; b: CoreApp } => ({
  a: {
    uri: "ui://luna/app-a",
    html: "<p>a</p>",
    tools: { "shared-name": async () => "from-a", "a-only": async () => 1 },
  },
  b: {
    uri: "ui://luna/app-b",
    html: "<p>b</p>",
    tools: { "shared-name": async () => "from-b" },
  },
})

describe("CoreAppRegistry — resources", () => {
  it("serves a registered uri as text/html;profile=mcp-app", async () => {
    const { a, b } = twoApps()
    const reg = createCoreAppRegistry([a, b])
    const res = await reg.readResource("ui://luna/app-a")
    expect(res).toEqual({ ok: true, mimeType: MCP_APP_MIME_TYPE, text: "<p>a</p>" })
  })

  it("rejects unknown uris (the relay is registry-validated, never a fetcher)", async () => {
    const reg = createCoreAppRegistry([twoApps().a])
    for (const uri of ["ui://luna/nope", "file:///etc/passwd", "https://evil.example"]) {
      const res = await reg.readResource(uri)
      expect(res.ok).toBe(false)
      expect(res.text).toBeUndefined()
    }
  })
})

describe("CoreAppRegistry — the same-app tool rule", () => {
  it("an app calls its OWN tool and gets a spec-shaped CallToolResult", async () => {
    const { a, b } = twoApps()
    const reg = createCoreAppRegistry([a, b])
    const res = await reg.callTool("ui://luna/app-a", "shared-name", {})
    expect(res.ok).toBe(true)
    expect(res.result).toEqual({
      content: [{ type: "text", text: JSON.stringify("from-a") }],
      structuredContent: "from-a",
    })
  })

  it("an app may NOT call another app's tool — even an unshared name", async () => {
    const { a, b } = twoApps()
    const reg = createCoreAppRegistry([a, b])
    // b asking for a-only (exists, but on app-a) → refused.
    const cross = await reg.callTool("ui://luna/app-b", "a-only", {})
    expect(cross.ok).toBe(false)
    expect(cross.message).toContain("a-only")
    // unknown app entirely → refused.
    const ghost = await reg.callTool("ui://luna/ghost", "shared-name", {})
    expect(ghost.ok).toBe(false)
  })

  it("prototype-chain names never resolve as tools (hasOwn gate)", async () => {
    const reg = createCoreAppRegistry([twoApps().a])
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      const res = await reg.callTool("ui://luna/app-a", name, {})
      expect(res.ok).toBe(false)
    }
  })

  it("a THROWING handler collapses to ok:false with a generic message", async () => {
    const reg = createCoreAppRegistry([
      {
        uri: "ui://luna/x",
        html: "<p>x</p>",
        tools: {
          boom: () => {
            throw new Error("ENOENT /home/op/secret")
          },
        },
      },
    ])
    const res = await reg.callTool("ui://luna/x", "boom", {})
    expect(res.ok).toBe(false)
    expect(res.message).not.toContain("ENOENT")
    expect(res.message).not.toContain("secret")
  })
})

describe("pulseFromSnapshot — the EventCounter aggregation", () => {
  it("sums tag-partitioned counters and derives the four tiles", () => {
    const ts = "2026-06-11T00:00:00.000Z"
    const snap = [
      { name: "luna.obs.tool_calls.total", tags: { tool: "bash", status: "success" }, value: 5, lastUpdatedTs: ts },
      { name: "luna.obs.tool_calls.total", tags: { tool: "edit", status: "error" }, value: 2, lastUpdatedTs: ts },
      { name: "luna.obs.errors.total", tags: { errorTag: "SdkError" }, value: 3, lastUpdatedTs: ts },
      { name: "luna.obs.cost.usd_micros", tags: {}, value: 1_234_500, lastUpdatedTs: ts },
      { name: "luna.obs.sessions.started", tags: { model: "opus" }, value: 4, lastUpdatedTs: ts },
      { name: "luna.obs.sessions.ended", tags: {}, value: 3, lastUpdatedTs: ts },
      { name: "luna.obs.events.total", tags: { kind: "ToolCall", level: "info" }, value: 99, lastUpdatedTs: ts },
    ]
    expect(pulseFromSnapshot(snap)).toEqual({
      toolsCalled: 7,
      errors: 3,
      estimatedUsd: 1.2345,
      activeSessions: 1,
    })
  })

  it("an empty snapshot yields zeros, and activeSessions clamps at 0", () => {
    expect(pulseFromSnapshot([])).toEqual({
      toolsCalled: 0,
      errors: 0,
      estimatedUsd: 0,
      activeSessions: 0,
    })
    const ts = "2026-06-11T00:00:00.000Z"
    expect(
      pulseFromSnapshot([
        { name: "luna.obs.sessions.ended", tags: {}, value: 5, lastUpdatedTs: ts },
      ]).activeSessions,
    ).toBe(0)
  })
})

describe("buildWorkspacePulseApp — the shipped core app", () => {
  it("registers under ui://luna/workspace-pulse and pulse-snapshot returns the injected counters", async () => {
    const getCounters = vi.fn(async () => ({
      toolsCalled: 9,
      errors: 1,
      estimatedUsd: 0.5,
      activeSessions: 2,
    }))
    const reg = createCoreAppRegistry([buildWorkspacePulseApp(getCounters)])
    const res = await reg.callTool(PULSE_URI, "pulse-snapshot", {})
    expect(res.ok).toBe(true)
    expect(
      (res.result as { structuredContent: unknown }).structuredContent,
    ).toEqual({ toolsCalled: 9, errors: 1, estimatedUsd: 0.5, activeSessions: 2 })
    expect(getCounters).toHaveBeenCalledTimes(1)
  })

  it("the app html is a REAL MCP app: handshake + tools/call, no luna.* shim, no external refs", async () => {
    const reg = createCoreAppRegistry([
      buildWorkspacePulseApp(async () => ({
        toolsCalled: 0,
        errors: 0,
        estimatedUsd: 0,
        activeSessions: 0,
      })),
    ])
    const res = await reg.readResource(PULSE_URI)
    expect(res.ok).toBe(true)
    const html = res.text!
    // The probe's look survives: title, 4 tiles, status dot.
    expect(html).toContain("Workspace Pulse")
    expect(html.match(/class="tile"/g)).toHaveLength(4)
    expect(html).toContain('id="status-dot"')
    // Raw MCP Apps JSON-RPC: init handshake + the snapshot tool poll.
    expect(html).toContain("'ui/initialize'")
    expect(html).toContain("'2026-01-26'")
    expect(html).toContain("'ui/notifications/initialized'")
    expect(html).toContain("'tools/call'")
    expect(html).toContain("pulse-snapshot")
    // An MCP app must NOT lean on the luna.* widget bridge…
    expect(html).not.toContain("window.luna")
    expect(html).not.toContain("luna.subscribe")
    // …and must be self-contained (the sandbox CSP forbids network).
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+href=/)
  })
})

describe("artifactIdFromAppUri — store-app uri parsing", () => {
  it("round-trips a percent-encoded artifact id", () => {
    const id = "mcp-app:budget"
    const uri = STORE_APP_URI_PREFIX + encodeURIComponent(id)
    expect(uri).toBe("ui://luna/app/mcp-app%3Abudget")
    expect(artifactIdFromAppUri(uri)).toBe(id)
  })

  it("returns null for any uri that is not a store-app uri", () => {
    for (const uri of [
      "ui://luna/workspace-pulse",
      "ui://luna/app/", // empty id
      "file:///etc/passwd",
      "https://evil.example",
      "",
    ]) {
      expect(artifactIdFromAppUri(uri)).toBeNull()
    }
  })
})

describe("createStoreBackedAppRegistry — generated/user apps", () => {
  const curated = {
    pulse: async () => ({ toolsCalled: 3 }),
    "list-artifacts": async () => [{ id: "x" }],
  }
  const reg = (html: string | null = "<p>app</p>") =>
    createStoreBackedAppRegistry({
      getAppHtml: async () => html,
      curatedTools: curated,
    })

  it("resolves ui://luna/app/<id> to the artifact HTML", async () => {
    const res = await reg().readResource("ui://luna/app/mcp-app%3Adash")
    expect(res).toEqual({ ok: true, mimeType: MCP_APP_MIME_TYPE, text: "<p>app</p>" })
  })

  it("fails closed for unknown app ids and non-app uris", async () => {
    expect((await reg(null).readResource("ui://luna/app/mcp-app%3Agone")).ok).toBe(false)
    expect((await reg().readResource("ui://luna/workspace-pulse")).ok).toBe(false)
  })

  it("callTool runs a curated tool (spec-shaped) and refuses anything else", async () => {
    const ok = await reg().callTool("ui://luna/app/mcp-app%3Adash", "pulse", {})
    expect(ok.ok).toBe(true)
    expect((ok.result as { structuredContent: unknown }).structuredContent).toEqual({ toolsCalled: 3 })

    const notCurated = await reg().callTool("ui://luna/app/mcp-app%3Adash", "delete-everything", {})
    expect(notCurated.ok).toBe(false)
    expect(notCurated.message).toContain("not available")

    // A non-store appUri never resolves here (the composer routes it elsewhere).
    const notStore = await reg().callTool("ui://luna/workspace-pulse", "pulse", {})
    expect(notStore.ok).toBe(false)
  })

  it("prototype-chain tool names never resolve (hasOwn gate)", async () => {
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect((await reg().callTool("ui://luna/app/mcp-app%3Ax", name, {})).ok).toBe(false)
    }
  })

  it("a throwing curated tool collapses to ok:false with a generic message", async () => {
    const r = createStoreBackedAppRegistry({
      getAppHtml: async () => "<p>x</p>",
      curatedTools: { boom: () => { throw new Error("ENOENT /home/op/secret") } },
    })
    const res = await r.callTool("ui://luna/app/mcp-app%3Ax", "boom", {})
    expect(res.ok).toBe(false)
    expect(res.message).not.toContain("secret")
  })
})

describe("composeAppRegistries — namespace isolation", () => {
  const core = createCoreAppRegistry([
    { uri: "ui://luna/workspace-pulse", html: "<p>core</p>", tools: { "pulse-snapshot": async () => 1 } },
  ])
  const store = createStoreBackedAppRegistry({
    getAppHtml: async () => "<p>store</p>",
    curatedTools: { pulse: async () => 2 },
  })
  const composed = composeAppRegistries(core, store)

  it("routes a core uri to the core registry and a store uri to the store registry", async () => {
    expect((await composed.readResource("ui://luna/workspace-pulse")).text).toBe("<p>core</p>")
    expect((await composed.readResource("ui://luna/app/mcp-app%3Ad")).text).toBe("<p>store</p>")
  })

  it("a STORE app cannot reach a CORE app's per-app tool, and vice-versa", async () => {
    // store appUri asking for the core 'pulse-snapshot' → not curated → refused.
    expect((await composed.callTool("ui://luna/app/mcp-app%3Ad", "pulse-snapshot", {})).ok).toBe(false)
    // core appUri asking for the curated 'pulse' → not its tool → refused.
    expect((await composed.callTool("ui://luna/workspace-pulse", "pulse", {})).ok).toBe(false)
    // each reaches ITS OWN tool fine.
    expect((await composed.callTool("ui://luna/workspace-pulse", "pulse-snapshot", {})).ok).toBe(true)
    expect((await composed.callTool("ui://luna/app/mcp-app%3Ad", "pulse", {})).ok).toBe(true)
  })
})

describe("buildCuratedAppTools — the read-only allowlist", () => {
  it("exposes exactly pulse + list-artifacts, wired to the injected getters", async () => {
    const getPulse = vi.fn(async () => ({ toolsCalled: 1, errors: 0, estimatedUsd: 0, activeSessions: 0 }))
    const listArtifacts = vi.fn(async () => [
      { id: "widget:a", title: "A", kind: "widget", version: 1, updatedAt: 0 },
    ])
    const tools = buildCuratedAppTools({ getPulse, listArtifacts })
    expect(Object.keys(tools).sort()).toEqual(["list-artifacts", "pulse"])
    await tools.pulse!({})
    await tools["list-artifacts"]!({})
    expect(getPulse).toHaveBeenCalledTimes(1)
    expect(listArtifacts).toHaveBeenCalledTimes(1)
  })
})
