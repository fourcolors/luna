import { describe, expect, it } from "vitest"
import { buildSessionMetadata, inferChatServerName } from "../runtime-metadata.js"
import { resolveRuntimePaths } from "../runtime-paths.js"

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

  it("resolves portable runtime paths from LUNA_HOME", () => {
    const paths = resolveRuntimePaths({
      env: { LUNA_HOME: "/opt/luna-state" },
      homeDir: "/home/luna",
    })

    expect(paths.lunaHome).toBe("/opt/luna-state")
    expect(paths.lunaDbPath).toBe("/opt/luna-state/luna.db")
    expect(paths.memoryDbPath).toBe("/opt/luna-state/memory.db")
    expect(paths.analyticsDbPath).toBe("/opt/luna-state/analytics.duckdb")
    expect(paths.eventsJsonlPath).toBe("/opt/luna-state/events.jsonl")
    expect(paths.envFilePath).toBe("/opt/luna-state/.env")
  })

  it("lets explicit DB and log path overrides win over LUNA_HOME defaults", () => {
    const paths = resolveRuntimePaths({
      env: {
        LUNA_HOME: "/opt/luna-state",
        LUNA_DB_PATH: "/var/lib/luna/runtime.db",
        LUNA_MEMORY_DB: "/var/lib/luna/memory.db",
        LUNA_ANALYTICS_DB_PATH: "/var/lib/luna/analytics.duckdb",
        LUNA_EVENTS_JSONL_PATH: "/var/log/luna/events.jsonl",
      },
      homeDir: "/home/luna",
    })

    expect(paths.lunaDbPath).toBe("/var/lib/luna/runtime.db")
    expect(paths.memoryDbPath).toBe("/var/lib/luna/memory.db")
    expect(paths.analyticsDbPath).toBe("/var/lib/luna/analytics.duckdb")
    expect(paths.eventsJsonlPath).toBe("/var/log/luna/events.jsonl")
  })

  it("renders Telegram interface and user lines when channelContext is provided", () => {
    const metadata = buildSessionMetadata({
      channelContext: {
        interface: "Telegram",
        chatId: "123",
        userId: "456",
        username: "alice",
      },
      env: {},
      startedAt: new Date("2026-07-05T10:00:00.000Z"),
    })

    expect(metadata).toContain("- **Interface:** Telegram")
    expect(metadata).toContain("- **User:** @alice (id: 456)")
    expect(metadata).toContain("- **Telegram chat id:** 123")
    expect(metadata).not.toContain("Luna WebSocket chat")
    expect(metadata).not.toContain("local operator")
  })

  it("renders 'unknown' user when channelContext has no username or userId", () => {
    const metadata = buildSessionMetadata({
      channelContext: {
        interface: "Telegram",
      },
      env: {},
      startedAt: new Date("2026-07-05T10:00:00.000Z"),
    })

    expect(metadata).toContain("- **Interface:** Telegram")
    expect(metadata).toContain("- **User:** unknown")
    expect(metadata).not.toContain("chat id:")
  })

  it("renders username-only when userId is absent", () => {
    const metadata = buildSessionMetadata({
      channelContext: {
        interface: "Telegram",
        username: "bob",
      },
      env: {},
    })

    expect(metadata).toContain("- **User:** @bob")
    expect(metadata).not.toContain("(id:")
  })

  it("renders userId-only when username is absent", () => {
    const metadata = buildSessionMetadata({
      channelContext: {
        interface: "Telegram",
        userId: "789",
      },
      env: {},
    })

    expect(metadata).toContain("- **User:** id: 789")
    expect(metadata).not.toContain("@")
  })
})
