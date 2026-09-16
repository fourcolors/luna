import { describe, expect, it } from "vitest"
import { createLocalShellBridge } from "@luna/ui-ws"
import type { LocalShellCapabilityFrame } from "@luna/ui-ws"
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

const cap = (
  extra: Partial<LocalShellCapabilityFrame> = {},
): LocalShellCapabilityFrame => ({
  type: "local-shell-capability",
  enabled: true,
  approvalMode: "auto",
  clientId: "cli_1",
  label: "laptop",
  sandbox: false,
  platform: "darwin",
  cwd: "/work",
  roots: ["/work"],
  fullAccess: false,
  ...extra,
})

const sandboxCap = (extra: Partial<LocalShellCapabilityFrame> = {}) =>
  cap({
    clientId: "server_sandbox",
    label: "stable",
    sandbox: true,
    platform: "linux",
    cwd: "/root/luna",
    roots: ["/root/luna"],
    ...extra,
  })

/** The tools resolve their thread through this. */
const session = (threadTags: ReadonlyArray<string> = []) => () => ({
  threadId: "thr_1",
  threadTags,
})

const requestIdOf = (sent: ReadonlyArray<unknown>, i = 0): string =>
  (sent[i] as { requestId: string }).requestId

describe("local shell tools", () => {
  it("local_shell_run errors when no session is bound", async () => {
    const bridge = createLocalShellBridge()
    const [runTool] = makeLocalShellTools(bridge, () => null)

    const message = parseErrorResult(
      (await runTool.handler(
        { command: "pwd", target: undefined, cwd: undefined, timeout_ms: 100 },
        undefined,
      )) as ToolCallResult,
    )
    expect(message).toContain("local_shell_run.local_shell.run")
  })

  it("local_shell_run returns camelCase fields plus the machine it ran on", async () => {
    const bridge = createLocalShellBridge()
    const sent: unknown[] = []
    bridge.setCapability(cap(), (f) => sent.push(f))

    const [runTool] = makeLocalShellTools(bridge, session())
    const pending = runTool.handler(
      { command: "pwd", target: undefined, cwd: "/tmp", timeout_ms: 500 },
      undefined,
    )

    expect(sent).toHaveLength(1)
    const request = sent[0] as {
      requestId: string
      command: string
      cwd?: string
      timeoutMs?: number
    }
    expect(request.command).toBe("pwd")
    expect(request.cwd).toBe("/tmp")
    expect(request.timeoutMs).toBe(500)

    bridge.acceptResult(
      {
        type: "local-shell-result",
        requestId: request.requestId,
        threadId: "thr_1",
        clientId: "cli_1",
        approved: true,
        exitCode: 0,
        stdout: "/work\n",
        stderr: "",
        durationMs: 4,
        timedOut: false,
      },
      "cli_1",
    )

    expect(
      parseTextResult<Record<string, unknown>>(
        (await pending) as ToolCallResult,
      ),
    ).toEqual({
      approved: true,
      exitCode: 0,
      stdout: "/work\n",
      stderr: "",
      durationMs: 4,
      timedOut: false,
      ranOn: {
        clientId: "cli_1",
        label: "laptop",
        platform: "darwin",
        cwd: "/tmp",
        roots: ["/work"],
        fullAccess: false,
        sandbox: false,
      },
    })
  })

  it("local_shell_run returns a denied result instead of a ToolError", async () => {
    const bridge = createLocalShellBridge()
    const sent: unknown[] = []
    bridge.setCapability(cap(), (f) => sent.push(f))

    const [runTool] = makeLocalShellTools(bridge, session())
    const pending = runTool.handler(
      {
        command: "rm -rf tmp",
        target: undefined,
        cwd: undefined,
        timeout_ms: undefined,
      },
      undefined,
    )

    bridge.acceptResult(
      {
        type: "local-shell-result",
        requestId: requestIdOf(sent),
        threadId: "thr_1",
        clientId: "cli_1",
        approved: false,
        exitCode: null,
        stdout: "",
        stderr: "denied by user",
        durationMs: 2,
        timedOut: false,
      },
      "cli_1",
    )

    const parsed = parseTextResult<{ approved: boolean; stderr: string }>(
      (await pending) as ToolCallResult,
    )
    expect(parsed.approved).toBe(false)
    expect(parsed.stderr).toBe("denied by user")
  })

  it("local_shell_run defaults an omitted timeout_ms to 120000", async () => {
    const bridge = createLocalShellBridge()
    const sent: unknown[] = []
    bridge.setCapability(cap(), (f) => sent.push(f))

    const [runTool] = makeLocalShellTools(bridge, session())
    const pending = runTool.handler(
      { command: "pwd", target: undefined, cwd: undefined, timeout_ms: undefined },
      undefined,
    )
    expect((sent[0] as { timeoutMs?: number }).timeoutMs).toBe(120_000)

    bridge.acceptResult(
      {
        type: "local-shell-result",
        requestId: requestIdOf(sent),
        threadId: "thr_1",
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
    await pending
  })

  it("local_shell_run rejects a timeout above the maximum without dispatching", async () => {
    const bridge = createLocalShellBridge()
    const sent: unknown[] = []
    bridge.setCapability(cap(), (f) => sent.push(f))

    const [runTool] = makeLocalShellTools(bridge, session())
    const message = parseErrorResult(
      (await runTool.handler(
        {
          command: "pwd",
          target: undefined,
          cwd: undefined,
          timeout_ms: 120_001,
        },
        undefined,
      )) as ToolCallResult,
    )
    expect(message).toContain("120000")
    expect(sent).toHaveLength(0)
  })

  it("local_shell_run forwards the chosen target", async () => {
    const bridge = createLocalShellBridge()
    const toLaptop: unknown[] = []
    const toSandbox: unknown[] = []
    bridge.setCapability(cap(), (f) => toLaptop.push(f))
    bridge.setCapability(sandboxCap(), (f) => toSandbox.push(f))

    const [runTool] = makeLocalShellTools(bridge, session())
    const pending = runTool.handler(
      {
        command: "hostname",
        target: "stable",
        cwd: undefined,
        timeout_ms: 500,
      },
      undefined,
    )

    expect(toLaptop).toHaveLength(0)
    expect(toSandbox).toHaveLength(1)
    bridge.acceptResult(
      {
        type: "local-shell-result",
        requestId: requestIdOf(toSandbox),
        threadId: "thr_1",
        clientId: "server_sandbox",
        approved: true,
        exitCode: 0,
        stdout: "luna-stable",
        stderr: "",
        durationMs: 1,
        timedOut: false,
      },
      "server_sandbox",
    )

    const parsed = parseTextResult<{ ranOn: { label: string } }>(
      (await pending) as ToolCallResult,
    )
    expect(parsed.ranOn.label).toBe("stable")
  })

  it("local_shell_run errors, naming both machines, when a target is required and omitted", async () => {
    const bridge = createLocalShellBridge()
    const sent: unknown[] = []
    bridge.setCapability(cap(), (f) => sent.push(f))
    bridge.setCapability(sandboxCap(), (f) => sent.push(f))

    const [runTool] = makeLocalShellTools(bridge, session())
    const message = parseErrorResult(
      (await runTool.handler(
        {
          command: "rm -rf node_modules",
          target: undefined,
          cwd: undefined,
          timeout_ms: 500,
        },
        undefined,
      )) as ToolCallResult,
    )
    expect(message).toContain("laptop")
    expect(message).toContain("stable")
    expect(sent).toHaveLength(0)
  })

  it("local_shell_list_roots reports nothing attached when no client is bound", async () => {
    const bridge = createLocalShellBridge()
    const [, listTool] = makeLocalShellTools(bridge, session())

    expect(
      parseTextResult<{ attached: boolean; targets: unknown[] }>(
        (await listTool.handler({}, undefined)) as ToolCallResult,
      ),
    ).toMatchObject({ attached: false, targets: [], targetRequired: false })
  })

  it("local_shell_list_roots lists one target and does not require a target", async () => {
    const bridge = createLocalShellBridge()
    bridge.setCapability(cap({ roots: ["/a", "/b"], fullAccess: true }), () => undefined)
    const [, listTool] = makeLocalShellTools(bridge, session())

    const parsed = parseTextResult<{
      attached: boolean
      targetRequired: boolean
      targets: ReadonlyArray<Record<string, unknown>>
    }>((await listTool.handler({}, undefined)) as ToolCallResult)

    expect(parsed.attached).toBe(true)
    expect(parsed.targetRequired).toBe(false)
    expect(parsed.targets).toEqual([
      {
        label: "laptop",
        clientId: "cli_1",
        platform: "darwin",
        cwd: "/work",
        roots: ["/a", "/b"],
        fullAccess: true,
        sandbox: false,
      },
    ])
  })

  it("local_shell_list_roots requires a target once two machines are attached", async () => {
    const bridge = createLocalShellBridge()
    bridge.setCapability(cap(), () => undefined)
    bridge.setCapability(sandboxCap(), () => undefined)
    const [, listTool] = makeLocalShellTools(bridge, session())

    const parsed = parseTextResult<{
      targetRequired: boolean
      targets: ReadonlyArray<{ label: string }>
    }>((await listTool.handler({}, undefined)) as ToolCallResult)

    expect(parsed.targetRequired).toBe(true)
    expect(parsed.targets.map((t) => t.label)).toEqual(["laptop", "stable"])
  })

  it("local_shell_list_roots hides personal machines from an unattended thread", async () => {
    const bridge = createLocalShellBridge()
    bridge.setCapability(cap(), () => undefined)
    bridge.setCapability(sandboxCap(), () => undefined)
    const [, listTool] = makeLocalShellTools(
      bridge,
      session(["forked-from-parent"]),
    )

    const parsed = parseTextResult<{
      unattendedThread: boolean
      targetRequired: boolean
      targets: ReadonlyArray<{ label: string; sandbox: boolean }>
    }>((await listTool.handler({}, undefined)) as ToolCallResult)

    expect(parsed.unattendedThread).toBe(true)
    expect(parsed.targets.map((t) => t.label)).toEqual(["stable"])
    expect(parsed.targets.every((t) => t.sandbox)).toBe(true)
    // Only one reachable machine, so no target argument is needed.
    expect(parsed.targetRequired).toBe(false)
  })

  it("the tool descriptions tell the model about targets and ranOn", () => {
    const bridge = createLocalShellBridge()
    const [runTool, listTool] = makeLocalShellTools(bridge, session())

    expect(runTool.description).toContain("target")
    expect(runTool.description).toContain("ranOn")
    expect(listTool.description).toContain("label")
  })
})
