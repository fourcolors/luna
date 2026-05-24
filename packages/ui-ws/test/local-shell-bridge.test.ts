import { describe, expect, it } from "vitest"
import { createLocalShellBridge } from "../src/local-shell-bridge.js"

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
      stdout: "/work",
      exitCode: 0,
    })
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
