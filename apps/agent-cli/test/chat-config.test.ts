import { describe, expect, it } from "vitest"
import { parseChatArgs } from "../src/chat/args.js"
import { loadChatConfig, parseDotEnv, redactedConfigSummary } from "../src/chat/config.js"

describe("luna chat config", () => {
  it("parses simple dotenv lines without leaking comments", () => {
    expect(parseDotEnv("A=1\n# ignored\nB = two words\nEMPTY=\n")).toEqual({
      A: "1",
      B: "two words",
      EMPTY: "",
    })
  })

  it("applies precedence flags over env over dotenv over defaults", () => {
    const args = parseChatArgs([
      "chat",
      "--url",
      "ws://flag/ui",
      "--token",
      "flag-token-123456",
      "--local-shell",
      "--start-mode",
      "ssh",
    ])
    const cfg = loadChatConfig({
      args,
      env: {
        LUNA_WS_URL: "ws://env/ui",
        LUNA_UI_WS_TOKEN: "env-token-123456",
        LUNA_START_MODE: "local",
      },
      dotenv: {
        LUNA_WS_URL: "ws://file/ui",
        LUNA_UI_WS_TOKEN: "file-token-123456",
        LUNA_START_TIMEOUT_MS: "45000",
      },
      homeDir: "/tmp/home",
      cwd: "/work",
    })
    expect(cfg.url).toBe("ws://flag/ui")
    expect(cfg.token).toBe("flag-token-123456")
    expect(cfg.startMode).toBe("ssh")
    expect(cfg.startTimeoutMs).toBe(45_000)
    expect(cfg.localShellInitial).toBe(true)
  })

  it("defaults to localhost url, no recovery, and local shell off", () => {
    const cfg = loadChatConfig({
      args: parseChatArgs(["chat"]),
      env: {},
      dotenv: {},
      homeDir: "/tmp/home",
      cwd: "/work",
    })
    expect(cfg.url).toBe("ws://127.0.0.1:4753/ui")
    expect(cfg.startMode).toBe("none")
    expect(cfg.localShellInitial).toBe(false)
    expect(cfg.newThread).toBe(true)
  })

  it("returns a setup error when token is missing", () => {
    const cfg = loadChatConfig({
      args: parseChatArgs(["chat"]),
      env: {},
      dotenv: {},
      homeDir: "/tmp/home",
      cwd: "/work",
    })
    expect(cfg.token).toBeNull()
    expect(cfg.validationErrors).toContain("missing LUNA_UI_WS_TOKEN")
  })

  it("does not print token in diagnostics", () => {
    const cfg = loadChatConfig({
      args: parseChatArgs(["chat", "--token", "secret-token-123456"]),
      env: {},
      dotenv: {},
      homeDir: "/tmp/home",
      cwd: "/work",
    })
    const summary = redactedConfigSummary(cfg)
    expect(summary).toContain("token=present")
    expect(summary).not.toContain("secret-token-123456")
  })
})
