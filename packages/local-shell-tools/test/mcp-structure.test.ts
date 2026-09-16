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
      Effect.gen(function* () {
        return yield* LocalShellToolsService
      }).pipe(Effect.provide(LocalShellToolsLayer({ bridge }))),
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
      Effect.gen(function* () {
        return yield* LocalShellToolsService
      }).pipe(Effect.provide(LocalShellToolsLayer({ bridge }))),
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

  it("stamps each command with its own thread, even though one machine serves every thread", async () => {
    // Clients are no longer per thread: one machine serves them all. What must
    // still hold is that a command carries the thread it was issued from, so a
    // result can only ever be matched back to that thread.
    const bridge = createLocalShellBridge()

    const config = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* LocalShellToolsService
      }).pipe(Effect.provide(LocalShellToolsLayer({ bridge }))),
    )
    const first = config.createSessionBinding()
    const second = config.createSessionBinding()
    first.bindSession("thr_1")
    second.bindSession("thr_2")

    const sent: Array<{ requestId: string; threadId: string }> = []
    bridge.setCapability(
      {
        type: "local-shell-capability",
        enabled: true,
        approvalMode: "auto",
        clientId: "cli_1",
        label: "only-machine",
        sandbox: false,
        platform: "test",
        cwd: "/one",
        roots: ["/one"],
        fullAccess: false,
      },
      (frame) => sent.push(frame as { requestId: string; threadId: string }),
    )

    const toolOf = (binding: typeof first) =>
      ((binding.server as unknown as {
        instance?: { _registeredTools?: Record<string, unknown> }
      }).instance?._registeredTools?.["local_shell_run"]) as {
        handler: (
          args: { command: string; target?: string; cwd?: string; timeout_ms?: number },
          extra: unknown,
        ) => Promise<unknown>
      }

    const answer = (i: number) =>
      bridge.acceptResult(
        {
          type: "local-shell-result",
          requestId: sent[i]!.requestId,
          threadId: sent[i]!.threadId,
          clientId: "cli_1",
          approved: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        },
        "cli_1",
      )

    const p1 = toolOf(first).handler({ command: "pwd", timeout_ms: 100 }, undefined)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ threadId: "thr_1", command: "pwd" })
    answer(0)
    await p1

    const p2 = toolOf(second).handler({ command: "pwd", timeout_ms: 100 }, undefined)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ threadId: "thr_2", command: "pwd" })
    answer(1)
    await p2
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

  it("makeLocalShellTools exposes local_shell_run and local_shell_list_roots", () => {
    const bridge = createLocalShellBridge()
    const tools = makeLocalShellTools(bridge, () => "thr_1")

    expect(tools).toHaveLength(2)
    expect(tools.map((tool) => (tool as unknown as { name: string }).name)).toEqual([
      "local_shell_run",
      "local_shell_list_roots",
    ])
  })

  it("marks both local shell tools as eagerly loaded", () => {
    const bridge = createLocalShellBridge()
    const tools = makeLocalShellTools(bridge, () => "thr_1")

    for (const tool of tools) {
      const meta = (tool as unknown as { _meta?: Record<string, unknown> })._meta
      expect(meta).toMatchObject({ "anthropic/alwaysLoad": true })
      expect(typeof meta?.["anthropic/searchHint"]).toBe("string")
      expect((meta?.["anthropic/searchHint"] as string).length).toBeGreaterThan(0)
    }
  })
})

describe("LocalShellToolsService - prompt invariants", () => {
  it("LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM describes local_shell availability and approval", () => {
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain("local_shell")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain(
      "mcp__local_shell__local_shell_run",
    )
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain("fully qualified")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM.toLowerCase()).toContain("approved")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).not.toContain(
      "Every command requires explicit user approval",
    )
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM.toLowerCase()).toContain("attached")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM.toLowerCase()).toContain("denied")
  })

  it("LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM teaches the multi-machine rules", () => {
    // The model cannot use an argument nobody told it about, and it will read a
    // wrong-host result as a missing file unless it is told to check ranOn.
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain("target")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain("targetRequired")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain("ranOn")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain("local_shell_list_roots")
    // The unattended-origin rule is a safety property, not a nicety.
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain("unattendedThread")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM.toLowerCase()).toContain("sandbox")
    // There must be no suggestion of a default machine.
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain("no default")
  })
})
