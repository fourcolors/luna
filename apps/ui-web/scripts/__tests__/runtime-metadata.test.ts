import { describe, expect, it } from "vitest"
import { buildSessionMetadata, inferChatServerName } from "../runtime-metadata.js"

describe("runtime metadata", () => {
  it("infers stable and dev chat-server names from the Luna profile", () => {
    expect(inferChatServerName("stable")).toBe("luna-chat-server")
    expect(inferChatServerName("dev")).toBe("luna-dev-chat-server")
  })

  it("describes dev sessions as dev chat-server sessions, not launchd web UI sessions", () => {
    const metadata = buildSessionMetadata({
      env: {
        LUNA_PROFILE: "dev",
        LUNA_RUNTIME_SCOPE: "incus-container",
      },
      startedAt: new Date("2026-05-25T12:00:00.000Z"),
    })

    expect(metadata).toContain("# Session Metadata")
    expect(metadata).toContain("- **Interface:** Luna WebSocket chat")
    expect(metadata).toContain("- **Runtime profile:** dev")
    expect(metadata).toContain("- **Runtime scope:** incus-container")
    expect(metadata).toContain("- **Server:** luna-dev-chat-server")
    expect(metadata).toContain("- **Started:** 2026-05-25T12:00:00.000Z")
    expect(metadata).not.toContain("Luna Web UI")
    expect(metadata).not.toContain("launchd")
  })

  it("respects an explicit chat-server name from install/runtime env", () => {
    const metadata = buildSessionMetadata({
      env: {
        LUNA_PROFILE: "dev",
        LUNA_CHAT_SERVER_NAME: "custom-dev-chat-server",
      },
      startedAt: new Date("2026-05-25T12:00:00.000Z"),
    })

    expect(metadata).toContain("- **Server:** custom-dev-chat-server")
  })
})
