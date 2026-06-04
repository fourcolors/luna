import { describe, expect, it } from "vitest"
import { createLocalShellBridge } from "@luna/ui-ws"
import { makeLocalShellTools } from "../src/tools.js"

interface ToolCallResult {
  readonly content?: ReadonlyArray<{ type: string; text: string }>
  readonly isError?: boolean
}

function parseErrorResult(result: ToolCallResult): string {
  expect(result.isError).toBe(true)
  return result.content?.[0]?.text ?? ""
}

function parseTextResult<T>(result: ToolCallResult): T {
  expect(result.isError).toBeFalsy()
  const first = result.content?.[0]
  expect(first?.type).toBe("text")
  return JSON.parse((first as { text: string }).text) as T
}

describe("local shell tools", () => {
  it("local_shell_run returns a ToolError-shaped MCP error when no client is attached", async () => {
    const bridge = createLocalShellBridge()
    const [runTool] = makeLocalShellTools(bridge, () => "thr_1")

    const result = await runTool.handler(
      {
        command: "pwd",
        cwd: undefined,
        timeout_ms: 100,
      },
      undefined,
    )

    const message = parseErrorResult(result as ToolCallResult)
    expect(message).toContain("local_shell_run.local_shell.run")
  })

  it("local_shell_run returns successful bridge results with camelCase fields", async () => {
    const bridge = createLocalShellBridge()
    const sent: unknown[] = []
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_1",
        platform: "darwin",
        cwd: "/work",
      },
      (frame) => sent.push(frame),
    )

    const [runTool] = makeLocalShellTools(bridge, () => "thr_1")
    const pending = runTool.handler(
      {
        command: "pwd",
        cwd: "/tmp",
        timeout_ms: 500,
      },
      undefined,
    )

    expect(sent).toHaveLength(1)
    const request = sent[0] as {
      readonly requestId: string
      readonly command: string
      readonly cwd?: string
      readonly timeoutMs?: number
    }
    expect(request.command).toBe("pwd")
    expect(request.cwd).toBe("/tmp")
    expect(request.timeoutMs).toBe(500)

    bridge.acceptResult({
      type: "local-shell-result",
      requestId: request.requestId,
      threadId: "thr_1",
      approved: true,
      exitCode: 0,
      stdout: "/work\n",
      stderr: "",
      durationMs: 4,
      timedOut: false,
    })

    const parsed = parseTextResult<{
      approved: boolean
      exitCode: number | null
      stdout: string
      stderr: string
      durationMs: number
      timedOut: boolean
    }>((await pending) as ToolCallResult)
    expect(parsed).toEqual({
      approved: true,
      exitCode: 0,
      stdout: "/work\n",
      stderr: "",
      durationMs: 4,
      timedOut: false,
    })
  })

  it("local_shell_run returns denied bridge results instead of a ToolError", async () => {
    const bridge = createLocalShellBridge()
    const sent: unknown[] = []
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_1",
        platform: "darwin",
        cwd: "/work",
      },
      (frame) => sent.push(frame),
    )

    const [runTool] = makeLocalShellTools(bridge, () => "thr_1")
    const pending = runTool.handler(
      {
        command: "rm -rf tmp",
        cwd: undefined,
        timeout_ms: undefined,
      },
      undefined,
    )

    expect(sent).toHaveLength(1)
    const request = sent[0] as { readonly requestId: string }

    bridge.acceptResult({
      type: "local-shell-result",
      requestId: request.requestId,
      threadId: "thr_1",
      approved: false,
      exitCode: null,
      stdout: "",
      stderr: "denied by user",
      durationMs: 2,
      timedOut: false,
    })

    const parsed = parseTextResult<{
      approved: boolean
      exitCode: number | null
      stdout: string
      stderr: string
      durationMs: number
      timedOut: boolean
    }>((await pending) as ToolCallResult)
    expect(parsed).toEqual({
      approved: false,
      exitCode: null,
      stdout: "",
      stderr: "denied by user",
      durationMs: 2,
      timedOut: false,
    })
  })

  it("local_shell_run defaults omitted timeout_ms to 120000", async () => {
    const bridge = createLocalShellBridge()
    const sent: unknown[] = []
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_1",
        platform: "darwin",
        cwd: "/work",
      },
      (frame) => sent.push(frame),
    )

    const [runTool] = makeLocalShellTools(bridge, () => "thr_1")
    const pending = runTool.handler(
      {
        command: "pwd",
        cwd: undefined,
        timeout_ms: undefined,
      },
      undefined,
    )

    expect(sent).toHaveLength(1)
    const request = sent[0] as {
      readonly requestId: string
      readonly timeoutMs?: number
    }
    expect(request.timeoutMs).toBe(120_000)

    bridge.acceptResult({
      type: "local-shell-result",
      requestId: request.requestId,
      threadId: "thr_1",
      approved: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    })

    await pending
  })

  it("local_shell_run rejects timeout_ms greater than 120000", async () => {
    const bridge = createLocalShellBridge()
    const sent: unknown[] = []
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_1",
        platform: "darwin",
        cwd: "/work",
      },
      (frame) => sent.push(frame),
    )

    const [runTool] = makeLocalShellTools(bridge, () => "thr_1")

    const result = await runTool.handler(
      {
        command: "pwd",
        cwd: undefined,
        timeout_ms: 120_001,
      },
      undefined,
    )

    const message = parseErrorResult(result as ToolCallResult)
    expect(message).toContain("120000")
    expect(sent).toHaveLength(0)
  })

  it("local_shell_run description allows auto-approved attached sessions", () => {
    const bridge = createLocalShellBridge()
    const [runTool] = makeLocalShellTools(bridge, () => "thr_1")

    const description = (runTool as unknown as { description: string }).description
    expect(description).toContain("may ask")
    expect(description).toContain("auto-approved")
    expect(description).not.toContain("asks the user for approval before")
  })

  it("local_shell_list_roots reports not-attached when no client is bound", async () => {
    const bridge = createLocalShellBridge()
    const [, listRootsTool] = makeLocalShellTools(bridge, () => "thr_1")

    const parsed = parseTextResult<{
      attached: boolean
      roots: string[]
      fullAccess: boolean
    }>((await listRootsTool.handler({}, undefined)) as ToolCallResult)
    expect(parsed).toEqual({ attached: false, roots: [], fullAccess: false })
  })

  it("local_shell_list_roots returns attached roots, fullAccess, cwd and platform", async () => {
    const bridge = createLocalShellBridge()
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_1",
        platform: "darwin",
        cwd: "/work/a",
        roots: ["/work/a", "/work/b"],
        fullAccess: false,
      },
      () => undefined,
    )
    const [, listRootsTool] = makeLocalShellTools(bridge, () => "thr_1")

    const parsed = parseTextResult<Record<string, unknown>>(
      (await listRootsTool.handler({}, undefined)) as ToolCallResult,
    )
    expect(parsed).toEqual({
      attached: true,
      roots: ["/work/a", "/work/b"],
      fullAccess: false,
      cwd: "/work/a",
      platform: "darwin",
    })
  })

  it("local_shell_list_roots reads a legacy cwd-only capability as a single root", async () => {
    const bridge = createLocalShellBridge()
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_1",
        platform: "linux",
        cwd: "/legacy",
      },
      () => undefined,
    )
    const [, listRootsTool] = makeLocalShellTools(bridge, () => "thr_1")

    const parsed = parseTextResult<Record<string, unknown>>(
      (await listRootsTool.handler({}, undefined)) as ToolCallResult,
    )
    expect(parsed).toMatchObject({
      attached: true,
      roots: ["/legacy"],
      fullAccess: false,
      cwd: "/legacy",
    })
  })
})
