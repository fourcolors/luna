/**
 * descriptor.test.ts — unit tests for projectLunaDescriptor().
 * Pins: identity.kind, update.revertible, and the "interact" capability.
 */
import { describe, expect, it } from "vitest"
import { projectLunaDescriptor } from "../src/descriptor.js"

describe("projectLunaDescriptor", () => {
  const baseCaps = {
    chat: true,
    localShell: false,
    skills: false,
    connectors: false,
    artifacts: false,
    workflows: false,
    suggestedActions: false,
    vault: false,
    mcpApps: false,
    effortSelection: true,
    subagents: true,
    modelRouting: false,
  }

  it("produces identity.kind === 'luna-chat-server'", () => {
    const d = projectLunaDescriptor({ caps: baseCaps })
    expect(d.identity.kind).toBe("luna-chat-server")
  })

  it("produces update.revertible === true", () => {
    const d = projectLunaDescriptor({ caps: baseCaps })
    expect(d.update?.revertible).toBe(true)
  })

  it("includes an 'interact' capability", () => {
    const d = projectLunaDescriptor({ caps: baseCaps })
    const interact = d.capabilities.find((c) => c.operation === "interact")
    expect(interact).toBeDefined()
    expect(interact?.available).toBe(true)
  })

  it("interact is unavailable when chat=false", () => {
    const d = projectLunaDescriptor({ caps: { ...baseCaps, chat: false } })
    const interact = d.capabilities.find((c) => c.operation === "interact")
    expect(interact?.available).toBe(false)
  })

  it("health.status is 'starting' in setup mode", () => {
    const d = projectLunaDescriptor({ caps: baseCaps, setupMode: true })
    expect(d.health.status).toBe("starting")
  })

  it("health.status is 'normal' in normal mode", () => {
    const d = projectLunaDescriptor({ caps: baseCaps, setupMode: false })
    expect(d.health.status).toBe("normal")
  })

  it("generation increments between calls", () => {
    const d1 = projectLunaDescriptor({ caps: baseCaps })
    const d2 = projectLunaDescriptor({ caps: baseCaps })
    expect(d2.generation).toBeGreaterThan(d1.generation)
  })

  it("descriptorSchema is 1", () => {
    const d = projectLunaDescriptor({ caps: baseCaps })
    expect(d.descriptorSchema).toBe(1)
  })

  it("negotiation.agreed is 2 (protocolVersion)", () => {
    const d = projectLunaDescriptor({ caps: baseCaps })
    expect(d.negotiation.agreed).toBe(2)
  })

  it("uses provided serverName in identity.name", () => {
    const d = projectLunaDescriptor({ caps: baseCaps, serverName: "my-luna" })
    expect(d.identity.name).toBe("my-luna")
  })

  it("defaults identity.name to 'luna'", () => {
    const d = projectLunaDescriptor({ caps: baseCaps })
    expect(d.identity.name).toBe("luna")
  })

  it("emits a stable per-process instanceId (restart anchor)", () => {
    const d1 = projectLunaDescriptor({ caps: baseCaps })
    const d2 = projectLunaDescriptor({ caps: baseCaps })
    expect(typeof d1.identity.instanceId).toBe("string")
    expect(d1.identity.instanceId).toBeTruthy()
    // Same process → same instanceId across connections; only a restart changes it.
    expect(d2.identity.instanceId).toBe(d1.identity.instanceId)
  })

  it("emits health.port when provided", () => {
    const d = projectLunaDescriptor({ caps: baseCaps, port: 4753 })
    expect(d.health.port).toBe(4753)
  })
})
