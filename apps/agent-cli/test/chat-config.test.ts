import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseChatArgs } from "../src/chat/args.js"
import {
  loadChatConfig,
  parseDotEnv,
  readLastThread,
  redactedConfigSummary,
  writeLastThread,
} from "../src/chat/config.js"

describe("luna chat config", () => {
  it("parses simple dotenv lines without leaking comments", () => {
    expect(parseDotEnv("A=1\n# ignored\nB = two words\nEMPTY=\n")).toEqual({
      A: "1",
      B: "two words",
      EMPTY: "",
    })
  })

  it("treats chat --help as help", () => {
    expect(parseChatArgs(["chat", "--help"])).toEqual({ command: "help", unknown: [] })
    expect(parseChatArgs(["chat", "-h"])).toEqual({ command: "help", unknown: [] })
  })

  it("parses profile aliases for one luna binary", () => {
    expect(parseChatArgs(["chat", "--dev"])).toMatchObject({
      command: "chat",
      profile: "dev",
      unknown: [],
    })
    expect(parseChatArgs(["chat", "--profile", "stable"])).toMatchObject({
      command: "chat",
      profile: "stable",
      unknown: [],
    })
    expect(parseChatArgs(["chat", "--profile=dev"])).toMatchObject({
      command: "chat",
      profile: "dev",
      unknown: [],
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

  it("loads profile-specific settings before legacy stable settings", () => {
    const cfg = loadChatConfig({
      args: parseChatArgs(["chat", "--dev"]),
      env: {
        LUNA_WS_URL: "ws://stable-env/ui",
        LUNA_UI_WS_TOKEN: "stable-env-token",
        LUNA_START_MODE: "local",
        LUNA_DEV_WS_URL: "ws://dev-env/ui",
        LUNA_DEV_UI_WS_TOKEN: "dev-env-token",
        LUNA_DEV_START_MODE: "ssh",
        LUNA_DEV_START_COMMAND: "systemctl --user restart luna-dev-chat-server.service",
        LUNA_DEV_START_SSH: "root@jax-box",
      },
      dotenv: {
        LUNA_DEV_WS_URL: "ws://dev-file/ui",
        LUNA_DEV_UI_WS_TOKEN: "dev-file-token",
      },
      homeDir: "/tmp/home",
      cwd: "/work",
    })
    expect(cfg.profileName).toBe("dev")
    expect(cfg.url).toBe("ws://dev-env/ui")
    expect(cfg.token).toBe("dev-env-token")
    expect(cfg.startMode).toBe("ssh")
    expect(cfg.startCommand).toBe("systemctl --user restart luna-dev-chat-server.service")
    expect(cfg.startSsh).toBe("root@jax-box")
  })

  it("loads profile fallback URLs and fallback SSH targets", () => {
    const cfg = loadChatConfig({
      args: parseChatArgs(["chat", "--dev"]),
      env: {
        LUNA_DEV_WS_URL: "ws://jax-box/ui",
        LUNA_DEV_FALLBACK_WS_URL: "ws://jax-box.local/ui",
        LUNA_DEV_UI_WS_TOKEN: "dev-env-token",
        LUNA_DEV_START_MODE: "ssh",
        LUNA_DEV_START_COMMAND: "incus exec luna-dev -- systemctl restart luna-dev-chat-server.service",
        LUNA_DEV_START_SSH: "root@jax-box",
        LUNA_DEV_FALLBACK_START_SSH: "root@jax-box.local",
      },
      dotenv: {},
      homeDir: "/tmp/home",
      cwd: "/work",
    })

    expect(cfg.urls).toEqual(["ws://jax-box/ui", "ws://jax-box.local/ui"])
    expect(cfg.startSshTargets).toEqual(["root@jax-box", "root@jax-box.local"])
    expect(redactedConfigSummary(cfg)).toContain("urls=2")
  })

  it("lets explicit fallback flags pair with explicit primary flags", () => {
    const args = parseChatArgs([
      "chat",
      "--url",
      "ws://primary/ui",
      "--fallback-url",
      "ws://fallback/ui",
      "--start-mode",
      "ssh",
      "--start-command",
      "restart luna",
      "--start-ssh",
      "root@primary",
      "--fallback-start-ssh",
      "root@fallback",
    ])
    const cfg = loadChatConfig({
      args,
      env: {
        LUNA_WS_URL: "ws://env/ui",
        LUNA_FALLBACK_WS_URL: "ws://env-fallback/ui",
        LUNA_UI_WS_TOKEN: "env-token",
        LUNA_START_SSH: "root@env",
        LUNA_FALLBACK_START_SSH: "root@env-fallback",
      },
      dotenv: {},
      homeDir: "/tmp/home",
      cwd: "/work",
    })

    expect(args.unknown).toEqual([])
    expect(cfg.urls).toEqual(["ws://primary/ui", "ws://fallback/ui"])
    expect(cfg.startSshTargets).toEqual(["root@primary", "root@fallback"])
  })

  it("lets explicit flags override profile settings", () => {
    const cfg = loadChatConfig({
      args: parseChatArgs(["chat", "--dev", "--url", "ws://flag/ui", "--token", "flag-token"]),
      env: {
        LUNA_DEV_WS_URL: "ws://dev-env/ui",
        LUNA_DEV_UI_WS_TOKEN: "dev-env-token",
      },
      dotenv: {},
      homeDir: "/tmp/home",
      cwd: "/work",
    })
    expect(cfg.profileName).toBe("dev")
    expect(cfg.url).toBe("ws://flag/ui")
    expect(cfg.token).toBe("flag-token")
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
    expect(summary).toContain("profile=stable")
    expect(summary).toContain("token=present")
    expect(summary).not.toContain("secret-token-123456")
  })

  it("returns a validation error for invalid env or dotenv start mode", () => {
    const envCfg = loadChatConfig({
      args: parseChatArgs(["chat"]),
      env: {
        LUNA_UI_WS_TOKEN: "env-token-123456",
        LUNA_START_MODE: "reboot",
      },
      dotenv: {},
      homeDir: "/tmp/home",
      cwd: "/work",
    })
    expect(envCfg.startMode).toBe("none")
    expect(envCfg.validationErrors).toContain(
      "LUNA_START_MODE must be local, ssh, or none",
    )

    const dotenvCfg = loadChatConfig({
      args: parseChatArgs(["chat"]),
      env: {},
      dotenv: {
        LUNA_UI_WS_TOKEN: "file-token-123456",
        LUNA_START_MODE: "docker",
      },
      homeDir: "/tmp/home",
      cwd: "/work",
    })
    expect(dotenvCfg.startMode).toBe("none")
    expect(dotenvCfg.validationErrors).toContain(
      "LUNA_START_MODE must be local, ssh, or none",
    )
  })

  it("returns a validation error for invalid timeout strings", () => {
    for (const raw of ["abc", "-5", "100ms", "1.5", "0"]) {
      const cfg = loadChatConfig({
        args: parseChatArgs(["chat"]),
        env: {
          LUNA_UI_WS_TOKEN: "env-token-123456",
          LUNA_START_TIMEOUT_MS: raw,
        },
        dotenv: {},
        homeDir: "/tmp/home",
        cwd: "/work",
      })
      expect(cfg.validationErrors, raw).toContain(
        "LUNA_START_TIMEOUT_MS must be a positive integer",
      )
    }

    const dotenvCfg = loadChatConfig({
      args: parseChatArgs(["chat"]),
      env: {},
      dotenv: {
        LUNA_UI_WS_TOKEN: "file-token-123456",
        LUNA_START_TIMEOUT_MS: "100ms",
      },
      homeDir: "/tmp/home",
      cwd: "/work",
    })
    expect(dotenvCfg.validationErrors).toContain(
      "LUNA_START_TIMEOUT_MS must be a positive integer",
    )
  })

  it("rejects empty inline url and token flag values", () => {
    const args = parseChatArgs(["chat", "--url=", "--token="])
    expect(args.unknown).toContain("--url requires a value")
    expect(args.unknown).toContain("--token requires a value")

    const cfg = loadChatConfig({
      args,
      env: {},
      dotenv: {},
      homeDir: "/tmp/home",
      cwd: "/work",
    })
    expect(cfg.url).toBe("ws://127.0.0.1:4753/ui")
    expect(cfg.token).toBeNull()
    expect(cfg.validationErrors).toContain("missing LUNA_UI_WS_TOKEN")
  })

  it("accepts non-empty inline url flag values", () => {
    const args = parseChatArgs(["chat", "--url=ws://flag/ui"])
    expect(args.unknown).toEqual([])
    expect(args.url).toBe("ws://flag/ui")
  })

  it("parses the dangerous auto-approve flag", () => {
    const args = parseChatArgs(["chat", "--dangerously-auto-approve-local-shell"])
    expect(args.unknown).toEqual([])
    expect(args.dangerouslyAutoApproveLocalShell).toBe(true)
  })

  it("rejects dangerous auto approval outside the Incus container scope", () => {
    const cfg = loadChatConfig({
      args: parseChatArgs(["chat", "--dangerously-auto-approve-local-shell"]),
      env: {
        LUNA_UI_WS_TOKEN: "env-token-123456",
      },
      dotenv: {},
      homeDir: "/tmp/home",
      cwd: "/Users/fourcolors/Projects/1_active/luna",
    })

    expect(cfg.dangerouslyAutoApproveLocalShell).toBe(false)
    expect(cfg.validationErrors).toContain(
      "dangerous local shell auto approval requires LUNA_RUNTIME_SCOPE=incus-container",
    )
    expect(cfg.validationErrors).toContain(
      "dangerous local shell auto approval requires cwd under /root/luna",
    )
  })

  it("rejects dangerous auto approval when the container cwd normalizes outside the approved root", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-dangerous-home-"))
    try {
      mkdirSync(join(home, ".luna"), { recursive: true })
      writeFileSync(join(home, ".luna", "allow-dangerous-local-shell"), "")
      const cfg = loadChatConfig({
        args: parseChatArgs(["chat", "--dangerously-auto-approve-local-shell"]),
        env: {
          LUNA_UI_WS_TOKEN: "env-token-123456",
          LUNA_RUNTIME_SCOPE: "incus-container",
        },
        dotenv: {},
        homeDir: home,
        cwd: "/root/luna/..",
      })

      expect(cfg.dangerouslyAutoApproveLocalShell).toBe(false)
      expect(cfg.validationErrors).toContain(
        "dangerous local shell auto approval requires cwd under /root/luna",
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("auto-resumes the last persisted thread when neither --thread nor --new is passed", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-resume-"))
    try {
      writeLastThread(home, "stable", "thr_resume_abc123")
      const cfg = loadChatConfig({
        args: parseChatArgs(["chat"]),
        env: { LUNA_UI_WS_TOKEN: "env-token-123456" },
        dotenv: {},
        homeDir: home,
        cwd: "/tmp",
      })
      expect(cfg.threadId).toBe("thr_resume_abc123")
      expect(cfg.newThread).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("ignores persisted last thread when --new is explicit", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-resume-"))
    try {
      writeLastThread(home, "stable", "thr_resume_abc123")
      const cfg = loadChatConfig({
        args: parseChatArgs(["chat", "--new"]),
        env: { LUNA_UI_WS_TOKEN: "env-token-123456" },
        dotenv: {},
        homeDir: home,
        cwd: "/tmp",
      })
      expect(cfg.threadId).toBeNull()
      expect(cfg.newThread).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("prefers --thread <id> over persisted last thread", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-resume-"))
    try {
      writeLastThread(home, "stable", "thr_persisted_xyz")
      const cfg = loadChatConfig({
        args: parseChatArgs(["chat", "--thread", "thr_explicit_qwe"]),
        env: { LUNA_UI_WS_TOKEN: "env-token-123456" },
        dotenv: {},
        homeDir: home,
        cwd: "/tmp",
      })
      expect(cfg.threadId).toBe("thr_explicit_qwe")
      expect(cfg.newThread).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("scopes persisted last thread per profile", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-resume-"))
    try {
      writeLastThread(home, "stable", "thr_stable_one")
      writeLastThread(home, "dev", "thr_dev_two")
      expect(readLastThread(home, "stable")).toBe("thr_stable_one")
      expect(readLastThread(home, "dev")).toBe("thr_dev_two")
      const devCfg = loadChatConfig({
        args: parseChatArgs(["chat", "--dev"]),
        env: { LUNA_UI_WS_TOKEN: "env-token-123456" },
        dotenv: {},
        homeDir: home,
        cwd: "/tmp",
      })
      expect(devCfg.profileName).toBe("dev")
      expect(devCfg.threadId).toBe("thr_dev_two")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("flags threadIdAutoResumed when resuming from disk", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-resume-"))
    try {
      writeLastThread(home, "stable", "thr_from_disk_abc")
      const cfg = loadChatConfig({
        args: parseChatArgs(["chat"]),
        env: { LUNA_UI_WS_TOKEN: "env-token-123456" },
        dotenv: {},
        homeDir: home,
        cwd: "/tmp",
      })
      expect(cfg.threadId).toBe("thr_from_disk_abc")
      expect(cfg.threadIdAutoResumed).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("does NOT flag threadIdAutoResumed when --thread is explicit", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-resume-"))
    try {
      writeLastThread(home, "stable", "thr_persisted_xyz")
      const cfg = loadChatConfig({
        args: parseChatArgs(["chat", "--thread", "thr_explicit"]),
        env: { LUNA_UI_WS_TOKEN: "env-token-123456" },
        dotenv: {},
        homeDir: home,
        cwd: "/tmp",
      })
      expect(cfg.threadId).toBe("thr_explicit")
      expect(cfg.threadIdAutoResumed).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("rejects malformed persisted last-thread content", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-resume-"))
    try {
      mkdirSync(join(home, ".luna"), { recursive: true })
      writeFileSync(join(home, ".luna", ".last-thread-stable"), "../escape; rm -rf /")
      expect(readLastThread(home, "stable")).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("accepts dangerous auto approval with runtime marker, marker file, and container cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-dangerous-home-"))
    try {
      mkdirSync(join(home, ".luna"), { recursive: true })
      writeFileSync(join(home, ".luna", "allow-dangerous-local-shell"), "")
      const cfg = loadChatConfig({
        args: parseChatArgs(["chat", "--local-shell"]),
        env: {
          LUNA_STABLE_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL: "1",
          LUNA_UI_WS_TOKEN: "env-token-123456",
        },
        dotenv: {
          LUNA_RUNTIME_SCOPE: "incus-container",
        },
        homeDir: home,
        cwd: "/root/luna",
      })

      expect(cfg.dangerouslyAutoApproveLocalShell).toBe(true)
      expect(cfg.validationErrors).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
