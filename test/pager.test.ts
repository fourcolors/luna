import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

/**
 * scripts/luna-pager — liveness ladder L2 pager.
 * Contract under test: always exits 0, always appends one JSONL alert line,
 * pages only when a token is configured and the cooldown allows, and never
 * stamps the cooldown on a failed send.
 */

const repoRoot = join(__dirname, "..")
const PAGER = join(repoRoot, "scripts", "luna-pager")

const tempDirs: string[] = []
const makeLunaHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "luna-pager-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

interface RunOpts {
  readonly env?: Record<string, string>
}

const runPager = (lunaHome: string, instance: string, opts: RunOpts = {}) =>
  spawnSync("bash", [PAGER, instance], {
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      LUNA_HOME: lunaHome,
      // Canned unit forensics so tests never shell out to systemctl/journalctl.
      LUNA_TEST_PAGER_STATUS: "● unit failed (canned status)",
      LUNA_TEST_PAGER_JOURNAL: "canned journal line",
      ...opts.env,
    },
  })

const readAlerts = (lunaHome: string): ReadonlyArray<Record<string, unknown>> =>
  readFileSync(join(lunaHome, "logs", "alerts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)

describe("luna-pager", () => {
  it("logs no-token and exits 0 when the pager token is not configured", () => {
    const lunaHome = makeLunaHome()
    const result = runPager(lunaHome, "luna-chat-server")

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("logged only")
    const alerts = readAlerts(lunaHome)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({
      unit: "luna-chat-server.service",
      outcome: "no-token",
    })
  })

  it("pages via the test transport, stamps the cooldown, and logs paged", () => {
    const lunaHome = makeLunaHome()
    const result = runPager(lunaHome, "luna-dev-chat-server", {
      env: {
        TELEGRAM_PAGER_TOKEN: "pager-token",
        LUNA_PAGER_CHAT_ID: "12345",
        LUNA_TEST_PAGER_TRANSPORT: "echo",
        LUNA_TEST_NOW_EPOCH: "1000000",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("WOULD-PAGE chat_id=12345")
    expect(result.stdout).toContain("luna-dev-chat-server.service")
    expect(result.stdout).toContain("canned status")
    expect(result.stdout).toContain("canned journal line")
    expect(readAlerts(lunaHome)[0]).toMatchObject({ outcome: "paged" })
    const cooldown = readFileSync(
      join(lunaHome, "run", "pager-cooldown-luna-dev-chat-server"),
      "utf8",
    )
    expect(cooldown).toBe("1000000")
  })

  it("suppresses a page inside the cooldown window and logs cooldown", () => {
    const lunaHome = makeLunaHome()
    const env = {
      TELEGRAM_PAGER_TOKEN: "pager-token",
      LUNA_PAGER_CHAT_ID: "12345",
      LUNA_TEST_PAGER_TRANSPORT: "echo",
    }
    // First page at t=1000000.
    runPager(lunaHome, "luna-chat-server", {
      env: { ...env, LUNA_TEST_NOW_EPOCH: "1000000" },
    })
    // Second failure 10 minutes later — inside the default 900s window.
    const second = runPager(lunaHome, "luna-chat-server", {
      env: { ...env, LUNA_TEST_NOW_EPOCH: "1000600" },
    })

    expect(second.status).toBe(0)
    expect(second.stdout).not.toContain("WOULD-PAGE")
    const alerts = readAlerts(lunaHome)
    expect(alerts).toHaveLength(2)
    expect(alerts[1]).toMatchObject({ outcome: "cooldown" })
  })

  it("pages again once the cooldown has elapsed", () => {
    const lunaHome = makeLunaHome()
    const env = {
      TELEGRAM_PAGER_TOKEN: "pager-token",
      LUNA_PAGER_CHAT_ID: "12345",
      LUNA_TEST_PAGER_TRANSPORT: "echo",
    }
    runPager(lunaHome, "luna-chat-server", {
      env: { ...env, LUNA_TEST_NOW_EPOCH: "1000000" },
    })
    const second = runPager(lunaHome, "luna-chat-server", {
      env: { ...env, LUNA_TEST_NOW_EPOCH: "1000901" },
    })

    expect(second.stdout).toContain("WOULD-PAGE")
    expect(readAlerts(lunaHome)[1]).toMatchObject({ outcome: "paged" })
  })

  it("honors LUNA_PAGER_COOLDOWN_SEC overrides", () => {
    const lunaHome = makeLunaHome()
    const env = {
      TELEGRAM_PAGER_TOKEN: "pager-token",
      LUNA_PAGER_CHAT_ID: "12345",
      LUNA_TEST_PAGER_TRANSPORT: "echo",
      LUNA_PAGER_COOLDOWN_SEC: "60",
    }
    runPager(lunaHome, "luna-chat-server", {
      env: { ...env, LUNA_TEST_NOW_EPOCH: "1000000" },
    })
    const second = runPager(lunaHome, "luna-chat-server", {
      env: { ...env, LUNA_TEST_NOW_EPOCH: "1000061" },
    })

    expect(second.stdout).toContain("WOULD-PAGE")
  })

  it("recovers from a corrupt cooldown file instead of crashing", () => {
    const lunaHome = makeLunaHome()
    runPager(lunaHome, "luna-chat-server") // creates run/ + logs/
    writeFileSync(
      join(lunaHome, "run", "pager-cooldown-luna-chat-server"),
      "garbage-not-a-number",
    )
    const result = runPager(lunaHome, "luna-chat-server", {
      env: {
        TELEGRAM_PAGER_TOKEN: "pager-token",
        LUNA_PAGER_CHAT_ID: "12345",
        LUNA_TEST_PAGER_TRANSPORT: "echo",
        LUNA_TEST_NOW_EPOCH: "1000000",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("WOULD-PAGE")
  })

  it("keeps the page under Telegram's 4096-char text cap AND keeps the NEWEST journal lines", () => {
    const lunaHome = makeLunaHome()
    // Chronological journal: 10k of noise, crash line LAST (newest).
    const journal = "x".repeat(10_000) + "\nFATAL: the actual crash line"
    const result = runPager(lunaHome, "luna-chat-server", {
      env: {
        TELEGRAM_PAGER_TOKEN: "pager-token",
        LUNA_PAGER_CHAT_ID: "12345",
        LUNA_TEST_PAGER_TRANSPORT: "echo",
        LUNA_TEST_NOW_EPOCH: "1000000",
        LUNA_TEST_PAGER_JOURNAL: journal,
      },
    })

    expect(result.status).toBe(0)
    const text = result.stdout.split("text:\n")[1] ?? ""
    expect(text.length).toBeLessThanOrEqual(4_000)
    // Truncation must drop the OLD noise, never the newest (crash) lines.
    expect(text).toContain("FATAL: the actual crash line")
    expect(text).toContain("…(truncated)")
    // The status summary always survives.
    expect(text).toContain("canned status")
  })

  it("does NOT stamp the cooldown on a failed send, so the next failure retries", () => {
    const lunaHome = makeLunaHome()
    const env = {
      TELEGRAM_PAGER_TOKEN: "pager-token",
      LUNA_PAGER_CHAT_ID: "12345",
    }
    const failed = runPager(lunaHome, "luna-chat-server", {
      env: { ...env, LUNA_TEST_PAGER_TRANSPORT: "fail", LUNA_TEST_NOW_EPOCH: "1000000" },
    })
    expect(failed.status).toBe(0) // a pager must never crash-loop
    expect(readAlerts(lunaHome)[0]).toMatchObject({ outcome: "send-failed" })
    expect(
      existsSync(join(lunaHome, "run", "pager-cooldown-luna-chat-server")),
    ).toBe(false)

    // Same epoch, transport healthy again → pages immediately (no cooldown).
    const retry = runPager(lunaHome, "luna-chat-server", {
      env: { ...env, LUNA_TEST_PAGER_TRANSPORT: "echo", LUNA_TEST_NOW_EPOCH: "1000000" },
    })
    expect(retry.stdout).toContain("WOULD-PAGE")
    expect(readAlerts(lunaHome)[1]).toMatchObject({ outcome: "paged" })
  })

  it("redacts secrets from status/journal before the page leaves the box", () => {
    const lunaHome = makeLunaHome()
    const result = runPager(lunaHome, "luna-chat-server", {
      env: {
        TELEGRAM_PAGER_TOKEN: "pager-token",
        LUNA_PAGER_CHAT_ID: "12345",
        LUNA_TEST_PAGER_TRANSPORT: "echo",
        LUNA_TEST_NOW_EPOCH: "1000000",
        LUNA_TEST_PAGER_JOURNAL:
          "ws://10.0.0.1:4753/ui?token=super-secret-ws-token\n" +
          "retry bot123456:AAAA-real-telegram-token failed\n" +
          "UI_WS_TOKEN=another-secret-value\n" +
          "Authorization: Bearer eyJhbGciOi-super-secret-jwt",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain("super-secret-ws-token")
    expect(result.stdout).not.toContain("AAAA-real-telegram-token")
    expect(result.stdout).not.toContain("another-secret-value")
    expect(result.stdout).not.toContain("super-secret-jwt")
    expect(result.stdout).toContain("<redacted>")
  })

  it("sanitizes a hostile instance name instead of writing outside run/", () => {
    const lunaHome = makeLunaHome()
    const result = runPager(lunaHome, "../../../etc/cron.d/evil", {
      env: {
        TELEGRAM_PAGER_TOKEN: "pager-token",
        LUNA_PAGER_CHAT_ID: "12345",
        LUNA_TEST_PAGER_TRANSPORT: "echo",
        LUNA_TEST_NOW_EPOCH: "1000000",
      },
    })

    expect(result.status).toBe(0)
    // Slashes flattened to underscores → the cooldown lands INSIDE run/.
    expect(
      existsSync(
        join(lunaHome, "run", "pager-cooldown-.._.._.._etc_cron.d_evil"),
      ),
    ).toBe(true)
  })
})
