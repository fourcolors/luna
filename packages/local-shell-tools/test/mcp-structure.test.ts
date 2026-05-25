import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { createLocalShellBridge } from "@luna/ui-ws"
import {
  LocalShellToolsLayer,
  LocalShellToolsService,
  LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM,
  buildLocalShellMcpServer,
} from "../src/layer.js"
import { makeLocalShellTools } from "../src/tools.js"

describe("LocalShellToolsLayer - structural invariants", () => {
  it("builds and provides LocalShellToolsService with correct shape", async () => {
    const bridge = createLocalShellBridge()

    const config = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* LocalShellToolsService
        }),
      ).pipe(Effect.provide(LocalShellToolsLayer({ bridge }))),
    )

    expect(config.serverName).toBe("local_shell")
    expect(config.server).not.toBeNull()
    expect(typeof config.server).toBe("object")
    expect((config.server as { type?: string }).type).toBe("sdk")
    expect((config.server as { name?: string }).name).toBe("local_shell")
    expect(typeof (config.server as { instance?: unknown }).instance).toBe("object")
    expect(config.systemPromptAddendum).toBe(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM)
    expect(typeof config.bindSession).toBe("function")
    expect(typeof config.clearSession).toBe("function")
    expect(typeof config.createSessionBinding).toBe("function")
  })

  it("creates isolated local shell server bindings per chat thread", async () => {
    const bridge = createLocalShellBridge()

    const config = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* LocalShellToolsService
        }),
      ).pipe(Effect.provide(LocalShellToolsLayer({ bridge }))),
    )
    const first = config.createSessionBinding()
    const second = config.createSessionBinding()

    first.bindSession("thr_1")
    second.bindSession("thr_2")

    expect(first.serverName).toBe("local_shell")
    expect(second.serverName).toBe("local_shell")
    expect(first.server).not.toBe(second.server)
    expect(first.systemPromptAddendum).toBe(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM)
    expect(second.systemPromptAddendum).toBe(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM)
  })

  it("does not let one thread binding route commands to another thread", async () => {
    const bridge = createLocalShellBridge()

    const config = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* LocalShellToolsService
        }),
      ).pipe(Effect.provide(LocalShellToolsLayer({ bridge }))),
    )
    const first = config.createSessionBinding()
    const second = config.createSessionBinding()
    first.bindSession("thr_1")
    second.bindSession("thr_2")

    const sentByThread1: unknown[] = []
    const sentByThread2: unknown[] = []
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_1",
        platform: "test",
        cwd: "/one",
      },
      (frame) => sentByThread1.push(frame),
    )
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_2",
        enabled: true,
        clientId: "cli_2",
        platform: "test",
        cwd: "/two",
      },
      (frame) => sentByThread2.push(frame),
    )

    const firstTool = ((first.server as unknown as {
      instance?: {
        _registeredTools?: Record<string, unknown>
      }
    }).instance?._registeredTools?.["local_shell_run"]) as {
      handler: (args: { command: string; cwd?: string; timeout_ms?: number }, extra: unknown) => Promise<unknown>
    }
    const pending = firstTool.handler(
      { command: "pwd", timeout_ms: 100 },
      undefined,
    )

    expect(sentByThread1).toHaveLength(1)
    expect(sentByThread1[0]).toMatchObject({
      type: "local-shell-request",
      threadId: "thr_1",
      command: "pwd",
    })
    expect(sentByThread2).toHaveLength(0)

    const request = sentByThread1[0] as { requestId: string }
    bridge.acceptResult({
      type: "local-shell-result",
      requestId: request.requestId,
      threadId: "thr_1",
      approved: true,
      exitCode: 0,
      stdout: "/one",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    })
    await pending
  })

  it("buildLocalShellMcpServer returns type='sdk' and name='local_shell'", () => {
    const bridge = createLocalShellBridge()
    const tools = makeLocalShellTools(bridge, () => "thr_1")
    const serverConfig = buildLocalShellMcpServer(tools)

    expect(serverConfig).not.toBeNull()
    expect(typeof serverConfig).toBe("object")
    expect((serverConfig as { type?: string }).type).toBe("sdk")
    expect((serverConfig as { name?: string }).name).toBe("local_shell")
    expect(typeof (serverConfig as { instance?: unknown }).instance).toBe("object")
  })

  it("makeLocalShellTools exposes local_shell_run", () => {
    const bridge = createLocalShellBridge()
    const tools = makeLocalShellTools(bridge, () => "thr_1")

    expect(tools).toHaveLength(1)
    expect(tools.map((tool) => (tool as unknown as { name: string }).name)).toEqual([
      "local_shell_run",
    ])
  })

  it("makeLocalShellTools marks local_shell_run as eagerly loaded", () => {
    const bridge = createLocalShellBridge()
    const tools = makeLocalShellTools(bridge, () => "thr_1")
    const meta = (tools[0] as unknown as { _meta?: Record<string, unknown> })._meta

    expect(meta).toMatchObject({ "anthropic/alwaysLoad": true })
    expect(typeof meta?.["anthropic/searchHint"]).toBe("string")
    expect((meta?.["anthropic/searchHint"] as string).length).toBeGreaterThan(0)
  })
})

describe("LocalShellToolsService - prompt invariants", () => {
  it("LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM describes local_shell availability and approval", () => {
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain("local_shell")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain(
      "mcp__local_shell__local_shell_run",
    )
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain("fully qualified")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM.toLowerCase()).toContain("approval")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain("trusted container session")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).not.toContain(
      "Every command requires explicit user approval",
    )
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM.toLowerCase()).toContain("unavailable")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM.toLowerCase()).toContain("denied")
  })
})
