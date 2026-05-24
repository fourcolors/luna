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
})

describe("LocalShellToolsService - prompt invariants", () => {
  it("LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM describes local_shell availability and approval", () => {
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain("local_shell")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM).toContain("local_shell_run")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM.toLowerCase()).toContain("approval")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM.toLowerCase()).toContain("unavailable")
    expect(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM.toLowerCase()).toContain("denied")
  })
})
