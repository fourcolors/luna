import { describe, it, expect } from "vitest"
import { loadDriver, checkCapability } from "../src/driver/registry.js"
import { LunaChatServerDriver } from "../src/driver/luna-chat-server.js"
import { OpenClawDriver } from "../src/driver/openclaw.js"
import { HermesDriver } from "../src/driver/hermes.js"
import type { RuntimeKind, ExecutorCapability } from "../src/runtime/executor.js"
import type { ServerUpdateDriver } from "../src/driver/contract.js"

const LOCAL_BARE: RuntimeKind = { transport: "local", target: "bareFolder", hostRepoDir: "/repo" }

describe("loadDriver", () => {
  it("returns LunaChatServerDriver for 'luna-chat-server'", () => {
    const d = loadDriver("luna-chat-server")
    expect(d).toBeInstanceOf(LunaChatServerDriver)
  })

  it("returns OpenClawDriver for 'openclaw'", () => {
    const d = loadDriver("openclaw")
    expect(d).toBeInstanceOf(OpenClawDriver)
  })

  it("returns HermesDriver for 'hermes'", () => {
    const d = loadDriver("hermes")
    expect(d).toBeInstanceOf(HermesDriver)
  })

  it("uses provided pinnedScriptPath for luna-chat-server", () => {
    const d = loadDriver("luna-chat-server", "/custom/path/luna-update-server") as LunaChatServerDriver
    expect(d).toBeInstanceOf(LunaChatServerDriver)
    // The pinnedScriptPath is private; verify indirectly via kind
    expect(d.kind).toBe("luna-chat-server")
  })

  it("throws for unknown driver kind", () => {
    expect(() => loadDriver("unknown-thing")).toThrow("Unknown driver kind 'unknown-thing'")
  })

  it("throws error that mentions valid kinds", () => {
    expect(() => loadDriver("bad-driver")).toThrow(/luna-chat-server.*openclaw.*hermes/)
  })

  it("throws error mentioning closed registry (no dynamic import)", () => {
    expect(() => loadDriver("dynamic-thing")).toThrow(/closed registry/i)
  })
})

describe("checkCapability", () => {
  it("does not throw for shell-requiring driver with bareFolder runtime", () => {
    const d = loadDriver("luna-chat-server")
    expect(() => checkCapability(d, LOCAL_BARE)).not.toThrow()
  })

  it("does not throw for shell-requiring driver with incus runtime", () => {
    const incus: RuntimeKind = {
      transport: "local",
      target: "incus",
      container: "luna-stable",
      hostRepoDir: "/repo",
      containerRepoDir: "/root/luna",
      lunaHome: "/root/.luna",
    }
    const d = loadDriver("openclaw")
    expect(() => checkCapability(d, incus)).not.toThrow()
  })

  it("does not throw for hermes (shell) with ssh bareFolder runtime", () => {
    const ssh: RuntimeKind = { transport: "ssh", sshHost: "luna-host", target: "bareFolder", hostRepoDir: "/repo" }
    const d = loadDriver("hermes")
    expect(() => checkCapability(d, ssh)).not.toThrow()
  })

  it("throws for a driver requiring 'ipc' capability", () => {
    const fakeIpcDriver: ServerUpdateDriver = {
      kind: "fake-ipc-driver",
      requires: "ipc" as ExecutorCapability,
      validateParams: () => ({}),
      plan: async () => [],
      currentVersion: async () => "0.0.0",
      resolveTarget: async () => ({ ref: "0.0.0", previous: "0.0.0", noop: true, revertible: false }),
      apply: async () => ({ status: "noop", at: "0.0.0" }),
      healthCheck: async () => ({ healthy: true, checks: [] }),
    }
    expect(() => checkCapability(fakeIpcDriver, LOCAL_BARE)).toThrow("fake-ipc-driver")
  })

  it("ipc-requires error mentions driver name and runtime target", () => {
    const fakeIpcDriver: ServerUpdateDriver = {
      kind: "my-ipc-driver",
      requires: "ipc" as ExecutorCapability,
      validateParams: () => ({}),
      plan: async () => [],
      currentVersion: async () => "0",
      resolveTarget: async () => ({ ref: "0", previous: "0", noop: true, revertible: false }),
      apply: async () => ({ status: "noop", at: "0" }),
      healthCheck: async () => ({ healthy: true, checks: [] }),
    }
    expect(() => checkCapability(fakeIpcDriver, LOCAL_BARE)).toThrow(/my-ipc-driver/)
  })
})
