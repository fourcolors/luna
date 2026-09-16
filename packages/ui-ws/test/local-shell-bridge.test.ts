import { describe, expect, it } from "vitest"
import {
  capabilityRoots,
  createLocalShellBridge,
} from "../src/local-shell-bridge.js"
import type { LocalShellCapabilityFrame } from "../src/protocol.js"

const baseCapability = (
  extra: Partial<LocalShellCapabilityFrame>,
): LocalShellCapabilityFrame => ({
  type: "local-shell-capability",
  threadId: "thr_1",
  enabled: true,
  clientId: "cli_1",
  platform: "darwin",
  cwd: "/work",
  ...extra,
})

describe("capabilityRoots", () => {
  it("reads a LEGACY (roots-absent) frame as a single-root [cwd] attachment", () => {
    expect(capabilityRoots(baseCapability({ cwd: "/legacy" }))).toEqual({
      roots: ["/legacy"],
      fullAccess: false,
    })
  })

  it("preserves an EMPTY roots list from a new client (opt-in auto-approval)", () => {
    expect(capabilityRoots(baseCapability({ roots: [], cwd: "/launch" }))).toEqual({
      roots: [],
      fullAccess: false,
    })
  })

  it("passes through attached roots and the fullAccess flag", () => {
    expect(
      capabilityRoots(
        baseCapability({ roots: ["/a", "/b"], fullAccess: true, cwd: "/a" }),
      ),
    ).toEqual({ roots: ["/a", "/b"], fullAccess: true })
  })
})

describe("local shell bridge", () => {
  it("registers one client per thread", () => {
    const bridge = createLocalShellBridge()
    const first = bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_1",
        platform: "darwin",
        cwd: "/work",
      },
      () => undefined,
    )
    const second = bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_2",
        platform: "linux",
        cwd: "/work",
      },
      () => undefined,
    )

    expect(first.accepted).toBe(true)
    expect(second.accepted).toBe(false)
    expect(second.message).toContain("already attached")
  })

  it("preserves approval mode on accepted capability", () => {
    const bridge = createLocalShellBridge()
    const accepted = bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thread-1",
        enabled: true,
        clientId: "client-1",
        platform: "linux",
        cwd: "/root/luna",
        approvalMode: "auto",
      },
      () => undefined,
    )

    expect(accepted.accepted).toBe(true)
    expect(bridge.getCapability("thread-1")?.approvalMode).toBe("auto")
  })

  it("allows an explicit client to replace a replaceable sandbox binding", () => {
    const bridge = createLocalShellBridge()
    const sandbox = bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "server_sandbox_thr_1",
        platform: "linux",
        cwd: "/root/luna",
        approvalMode: "auto",
        replaceable: true,
      },
      () => undefined,
    )
    const client = bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_1",
        platform: "darwin",
        cwd: "/home/user/luna",
        approvalMode: "prompt",
      },
      () => undefined,
    )

    expect(sandbox.accepted).toBe(true)
    expect(client.accepted).toBe(true)
    expect(bridge.getCapability("thr_1")?.clientId).toBe("cli_1")
  })

  it("removes a client when capability is disabled", () => {
    const bridge = createLocalShellBridge()
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_1",
        platform: "darwin",
        cwd: "/work",
      },
      () => undefined,
    )
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: false,
        clientId: "cli_1",
        platform: "darwin",
        cwd: "/work",
      },
      () => undefined,
    )

    expect(bridge.getCapability("thr_1")).toBeNull()
  })

  it("resolves request when result arrives", async () => {
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

    const pending = bridge.request({
      threadId: "thr_1",
      command: "pwd",
      timeoutMs: 2_000,
    })
    expect(sent).toHaveLength(1)
    const req = sent[0] as { requestId: string }
    bridge.acceptResult({
      type: "local-shell-result",
      requestId: req.requestId,
      threadId: "thr_1",
      approved: true,
      exitCode: 0,
      stdout: "/work",
      stderr: "",
      durationMs: 3,
      timedOut: false,
    })

    await expect(pending).resolves.toMatchObject({
      result: { stdout: "/work", exitCode: 0 },
    })
  })

  it("reports the identity of the client that served the request", async () => {
    const bridge = createLocalShellBridge()
    const sent: unknown[] = []
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_mac",
        platform: "darwin",
        cwd: "/work",
        roots: ["/work", "/tmp"],
        fullAccess: false,
      },
      (frame) => sent.push(frame),
    )

    const pending = bridge.request({
      threadId: "thr_1",
      command: "pwd",
      timeoutMs: 2_000,
    })
    const req = sent[0] as { requestId: string }
    bridge.acceptResult({
      type: "local-shell-result",
      requestId: req.requestId,
      threadId: "thr_1",
      approved: true,
      exitCode: 0,
      stdout: "/work",
      stderr: "",
      durationMs: 3,
      timedOut: false,
    })

    const outcome = await pending
    expect(outcome.dispatchedTo).toEqual({
      clientId: "cli_mac",
      platform: "darwin",
      cwd: "/work",
      roots: ["/work", "/tmp"],
      fullAccess: false,
    })
  })

  it("reports the request's own cwd as the effective cwd", async () => {
    const bridge = createLocalShellBridge()
    const sent: unknown[] = []
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_1",
        platform: "linux",
        cwd: "/root/luna",
        fullAccess: true,
      },
      (frame) => sent.push(frame),
    )

    const pending = bridge.request({
      threadId: "thr_1",
      command: "pwd",
      cwd: "/root/luna/worktrees/x",
      timeoutMs: 2_000,
    })
    const req = sent[0] as { requestId: string }
    bridge.acceptResult({
      type: "local-shell-result",
      requestId: req.requestId,
      threadId: "thr_1",
      approved: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    })

    const outcome = await pending
    expect(outcome.dispatchedTo.cwd).toBe("/root/luna/worktrees/x")
    expect(outcome.dispatchedTo.platform).toBe("linux")
  })

  it("snapshots dispatch identity so a mid-flight rebind cannot rewrite it", async () => {
    // The whole point of the field: the binding can be replaced while a
    // command is in flight. The result must name the client it was SENT to,
    // not whoever happens to hold the slot when the result lands.
    const bridge = createLocalShellBridge()
    const sent: unknown[] = []
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "server_sandbox_thr_1",
        platform: "linux",
        cwd: "/root/luna",
        replaceable: true,
      },
      (frame) => sent.push(frame),
    )

    const pending = bridge.request({
      threadId: "thr_1",
      command: "hostname",
      timeoutMs: 2_000,
    })
    const req = sent[0] as { requestId: string }

    // A second client takes the slot before the result comes back.
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_mac",
        platform: "darwin",
        cwd: "/Users/sterling",
      },
      () => {},
    )
    expect(bridge.getCapability("thr_1")?.clientId).toBe("cli_mac")

    bridge.acceptResult({
      type: "local-shell-result",
      requestId: req.requestId,
      threadId: "thr_1",
      approved: true,
      exitCode: 0,
      stdout: "luna-stable",
      stderr: "",
      durationMs: 2,
      timedOut: false,
    })

    const outcome = await pending
    expect(outcome.dispatchedTo.clientId).toBe("server_sandbox_thr_1")
    expect(outcome.dispatchedTo.platform).toBe("linux")
  })

  it("rejects request when no client is enabled", async () => {
    const bridge = createLocalShellBridge()

    await expect(
      bridge.request({ threadId: "thr_1", command: "pwd", timeoutMs: 10 }),
    ).rejects.toThrow("local shell unavailable")
  })

  it("rejects pending request when client is removed", async () => {
    const bridge = createLocalShellBridge()
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_1",
        platform: "darwin",
        cwd: "/work",
      },
      () => undefined,
    )

    const pending = bridge.request({
      threadId: "thr_1",
      command: "pwd",
      timeoutMs: 2_000,
    })
    bridge.removeClient("cli_1")

    await expect(pending).rejects.toThrow("local shell client removed")
  })

  it("rejects pending request when capability is disabled", async () => {
    const bridge = createLocalShellBridge()
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: true,
        clientId: "cli_1",
        platform: "darwin",
        cwd: "/work",
      },
      () => undefined,
    )

    const pending = bridge.request({
      threadId: "thr_1",
      command: "pwd",
      timeoutMs: 2_000,
    })
    bridge.setCapability(
      {
        type: "local-shell-capability",
        threadId: "thr_1",
        enabled: false,
        clientId: "cli_1",
        platform: "darwin",
        cwd: "/work",
      },
      () => undefined,
    )

    await expect(pending).rejects.toThrow("local shell disabled")
  })
})
