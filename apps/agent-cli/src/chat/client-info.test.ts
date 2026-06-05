/**
 * client-info.test.ts — buildClientInfo defaults + overrides.
 */
import { describe, expect, it } from "vitest"
import { buildClientInfo, AGENT_CLI_CLIENT_VERSION } from "./client-info.js"

describe("buildClientInfo", () => {
  it("defaults to luna-tui with current platform and pinned version", () => {
    const ci = buildClientInfo()
    expect(ci.name).toBe("luna-tui")
    expect(ci.version).toBe(AGENT_CLI_CLIENT_VERSION)
    expect(typeof ci.platform).toBe("string")
  })

  it("uses luna-cli-readline when legacy=true", () => {
    expect(buildClientInfo({ legacy: true }).name).toBe("luna-cli-readline")
  })

  it("nameOverride wins over legacy flag", () => {
    expect(
      buildClientInfo({ legacy: true, nameOverride: "custom" }).name,
    ).toBe("custom")
  })

  it("explicit version and platform override defaults", () => {
    const ci = buildClientInfo({ version: "9.9.9", platform: "linux" })
    expect(ci.version).toBe("9.9.9")
    expect(ci.platform).toBe("linux")
  })

  it("pinned version matches agent-cli package.json", async () => {
    // Read package.json statically so a version bump that forgets this
    // constant fails the test instead of going unnoticed.
    const pkg = (await import("../../package.json", { with: { type: "json" } })) as {
      default: { version: string }
    }
    expect(AGENT_CLI_CLIENT_VERSION).toBe(pkg.default.version)
  })
})
