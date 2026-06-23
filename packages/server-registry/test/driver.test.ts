// test/driver.test.ts — cross-driver tests covering all 5 fixes
import { describe, it, expect, vi } from "vitest"
import { LunaChatServerDriver } from "../src/driver/luna-chat-server.js"
import type { LunaChatServerParams } from "../src/driver/luna-chat-server.js"
import { OpenClawDriver } from "../src/driver/openclaw.js"
import { HermesDriver } from "../src/driver/hermes.js"
import { validateExecutionContext } from "../src/runtime/executor.js"
import type { RuntimeKind, ExecutionContext } from "../src/runtime/executor.js"
import type { DriverContext, ResolvedTarget } from "../src/driver/contract.js"
import { FakeShellExecutor } from "./helpers/fake-executor.js"

const LOCAL_BARE: RuntimeKind = { transport: "local", target: "bareFolder", hostRepoDir: "/repo" }
const LOCAL_INCUS: RuntimeKind = {
  transport: "local",
  target: "incus",
  container: "luna-stable",
  hostRepoDir: "/repo",
  containerRepoDir: "/root/luna",
  lunaHome: "/root/.luna",
}

function makeLcsCtx(
  exe: FakeShellExecutor,
  runtime: RuntimeKind = LOCAL_BARE,
): DriverContext<LunaChatServerParams> {
  const params: LunaChatServerParams = { profile: "stable", _runtime: runtime }
  const exec: ExecutionContext = { service: exe }
  return { exec, params, log: vi.fn(), dryRun: false }
}

// ── FIX 1: rollback() uses --ref, not --rollback-to ──────────────────────────

describe("FIX 1: LunaChatServerDriver.rollback() flag correctness", () => {
  const driver = new LunaChatServerDriver("/usr/local/bin/luna-update-server")

  it("uses --ref <previous>, not --rollback-to", async () => {
    const exe = new FakeShellExecutor()
    exe.setDefault({ code: 0, stdout: "", stderr: "", timedOut: false })
    const ctx = makeLcsCtx(exe)
    await driver.rollback(ctx, "abc123")
    const calls = exe.getCallLog()
    const rollbackCall = calls.find((c) => c.argv[0] === "/usr/local/bin/luna-update-server")
    expect(rollbackCall).toBeDefined()
    expect(rollbackCall!.argv).toContain("--ref")
    expect(rollbackCall!.argv).toContain("abc123")
    expect(rollbackCall!.argv).not.toContain("--rollback-to")
  })

  it("does NOT pass --no-rollback", async () => {
    const exe = new FakeShellExecutor()
    exe.setDefault({ code: 0, stdout: "", stderr: "", timedOut: false })
    const ctx = makeLcsCtx(exe)
    await driver.rollback(ctx, "abc123")
    const calls = exe.getCallLog()
    const rollbackCall = calls.find((c) => c.argv[0] === "/usr/local/bin/luna-update-server")
    expect(rollbackCall!.argv).not.toContain("--no-rollback")
  })

  it("--ref comes before the sha (positional order)", async () => {
    const exe = new FakeShellExecutor()
    exe.setDefault({ code: 0, stdout: "", stderr: "", timedOut: false })
    const ctx = makeLcsCtx(exe)
    await driver.rollback(ctx, "deadbeef")
    const argv = exe.getCallLog()[0]!.argv
    const refIdx = argv.indexOf("--ref")
    expect(refIdx).toBeGreaterThan(-1)
    expect(argv[refIdx + 1]).toBe("deadbeef")
  })
})

// ── FIX 2: apply() exit-1 split on real stderr markers ───────────────────────

describe("FIX 2: LunaChatServerDriver.apply() exit-1 discrimination", () => {
  const driver = new LunaChatServerDriver("/usr/local/bin/luna-update-server")
  const target: ResolvedTarget = { ref: "deadbeef", previous: "abc123", noop: false, revertible: true }

  it("exit-1 with 'ROLLED BACK to' → rolled-back", async () => {
    const exe = new FakeShellExecutor()
    exe.addResponse(["/usr/local/bin/luna-update-server"], {
      code: 1,
      stdout: "",
      stderr: "warning: update to deadbeef failed — ROLLED BACK to abc123 (luna-chat-server.service healthy)\n",
      timedOut: false,
    })
    const ctx = makeLcsCtx(exe)
    const outcome = await driver.apply(ctx, target)
    expect(outcome.status).toBe("rolled-back")
    if (outcome.status === "rolled-back") {
      expect(outcome.attempted).toBe("deadbeef")
      expect(outcome.recovered).toBe("abc123")
    }
  })

  it("exit-1 with preflight error (no ROLLED BACK marker) → failed", async () => {
    const exe = new FakeShellExecutor()
    exe.addResponse(["/usr/local/bin/luna-update-server"], {
      code: 1,
      stdout: "",
      stderr: "error: /root/luna is not a git clone\n",
      timedOut: false,
    })
    const ctx = makeLcsCtx(exe)
    const outcome = await driver.apply(ctx, target)
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.cause).toContain("not a git clone")
    }
  })

  it("exit-1 with unknown option error (no ROLLED BACK marker) → failed", async () => {
    const exe = new FakeShellExecutor()
    exe.addResponse(["/usr/local/bin/luna-update-server"], {
      code: 1,
      stdout: "",
      stderr: "error: unknown option: --rollback-to\n",
      timedOut: false,
    })
    const ctx = makeLcsCtx(exe)
    const outcome = await driver.apply(ctx, target)
    expect(outcome.status).toBe("failed")
  })

  it("exit-1 with empty stderr (no ROLLED BACK marker) → failed", async () => {
    const exe = new FakeShellExecutor()
    exe.addResponse(["/usr/local/bin/luna-update-server"], {
      code: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
    })
    const ctx = makeLcsCtx(exe)
    const outcome = await driver.apply(ctx, target)
    expect(outcome.status).toBe("failed")
  })

  it("exit-2 (CRITICAL rollback failure) → failed", async () => {
    const exe = new FakeShellExecutor()
    exe.addResponse(["/usr/local/bin/luna-update-server"], {
      code: 2,
      stdout: "",
      stderr: "CRITICAL: update to deadbeef failed AND rollback to abc123 also failed\n",
      timedOut: false,
    })
    const ctx = makeLcsCtx(exe)
    const outcome = await driver.apply(ctx, target)
    expect(outcome.status).toBe("failed")
  })
})

// ── FIX 3: validateExecutionContext invariants ────────────────────────────────

describe("FIX 3: validateExecutionContext", () => {
  it("valid bareFolder context (no host) does not throw", () => {
    const svc = new FakeShellExecutor({ locality: "local" })
    expect(() => validateExecutionContext({ service: svc }, LOCAL_BARE)).not.toThrow()
  })

  it("valid incus context (host present, matching locality) does not throw", () => {
    const svc = new FakeShellExecutor({ locality: "remote" })
    const host = new FakeShellExecutor({ locality: "remote" })
    expect(() => validateExecutionContext({ service: svc, host }, LOCAL_INCUS)).not.toThrow()
  })

  it("host present for bareFolder (non-incus) target throws", () => {
    const svc = new FakeShellExecutor({ locality: "local" })
    const host = new FakeShellExecutor({ locality: "local" })
    expect(() => validateExecutionContext({ service: svc, host }, LOCAL_BARE)).toThrow(/host.*incus/i)
  })

  it("host present for ssh bareFolder (non-incus) target throws", () => {
    const ssh: RuntimeKind = { transport: "ssh", sshHost: "jax-box", target: "bareFolder", hostRepoDir: "/repo" }
    const svc = new FakeShellExecutor({ locality: "remote" })
    const host = new FakeShellExecutor({ locality: "remote" })
    expect(() => validateExecutionContext({ service: svc, host }, ssh)).toThrow(/host.*incus/i)
  })

  it("incus with mismatched locality (local vs remote) throws", () => {
    const svc = new FakeShellExecutor({ locality: "local" })
    const host = new FakeShellExecutor({ locality: "remote" })
    expect(() => validateExecutionContext({ service: svc, host }, LOCAL_INCUS)).toThrow(/locality/i)
  })

  it("apply() calls validateExecutionContext — host on bareFolder throws at apply time", async () => {
    const driver = new LunaChatServerDriver("/usr/local/bin/luna-update-server")
    const svc = new FakeShellExecutor({ locality: "local" })
    const host = new FakeShellExecutor({ locality: "local" })
    // Pass host executor with bareFolder runtime — invariant violation
    const ctx: DriverContext<LunaChatServerParams> = {
      exec: { service: svc, host },
      params: { profile: "stable", _runtime: LOCAL_BARE },
      log: vi.fn(),
      dryRun: false,
    }
    const target: ResolvedTarget = { ref: "abc123", previous: "old", noop: false, revertible: true }
    await expect(driver.apply(ctx, target)).rejects.toThrow(/host.*incus/i)
  })
})

// ── FIX 4: charset validation in validateParams ───────────────────────────────

describe("FIX 4: charset validation", () => {
  describe("LunaChatServerDriver.validateParams", () => {
    const driver = new LunaChatServerDriver("/usr/local/bin/luna-update-server")

    it("accepts safe profile names", () => {
      expect(() => driver.validateParams({ profile: "stable" }, LOCAL_BARE)).not.toThrow()
      expect(() => driver.validateParams({ profile: "dev-2.0" }, LOCAL_BARE)).not.toThrow()
      expect(() => driver.validateParams({ profile: "profile_123" }, LOCAL_BARE)).not.toThrow()
    })

    it("rejects profile with shell injection characters", () => {
      expect(() =>
        driver.validateParams({ profile: "stable; rm -rf /" }, LOCAL_BARE),
      ).toThrow(/unsafe characters/)
    })

    it("rejects profile with single quote", () => {
      expect(() =>
        driver.validateParams({ profile: "stab'le" }, LOCAL_BARE),
      ).toThrow(/unsafe characters/)
    })

    it("rejects profile with space", () => {
      expect(() =>
        driver.validateParams({ profile: "stable dev" }, LOCAL_BARE),
      ).toThrow(/unsafe characters/)
    })
  })

  describe("OpenClawDriver.validateParams", () => {
    const driver = new OpenClawDriver()

    it("accepts safe unit and package names", () => {
      expect(() =>
        driver.validateParams({ unit: "openclaw.service", package: "@scope/pkg" }, LOCAL_BARE),
      ).not.toThrow()
    })

    it("rejects unit with unsafe chars", () => {
      expect(() =>
        driver.validateParams({ unit: "my-unit; evil", package: "safe-pkg" }, LOCAL_BARE),
      ).toThrow(/unsafe characters/)
    })

    it("rejects package with unsafe chars", () => {
      expect(() =>
        driver.validateParams({ unit: "openclaw.service", package: "pkg$(id)" }, LOCAL_BARE),
      ).toThrow(/unsafe characters/)
    })

    it("rejects qmdFile with unsafe chars (space)", () => {
      expect(() =>
        driver.validateParams({ unit: "openclaw.service", package: "openclaw", qmdFile: "/path/with spaces/file.qmd" }, LOCAL_BARE),
      ).toThrow(/unsafe characters/)
    })

    it("accepts safe qmdFile path", () => {
      expect(() =>
        driver.validateParams({ unit: "openclaw.service", package: "openclaw", qmdFile: "/etc/openclaw/query.qmd" }, LOCAL_BARE),
      ).not.toThrow()
    })
  })
})

// ── FIX 5: qmdPatchCmd and updateCmd as string arrays ────────────────────────

describe("FIX 5: argv arrays for qmdPatchCmd / updateCmd", () => {
  describe("OpenClawDriver", () => {
    const driver = new OpenClawDriver()

    it("validateParams accepts qmdPatchCmd as string array", () => {
      const params = driver.validateParams(
        { unit: "my.service", package: "my-pkg", qmdPatchCmd: ["patch-cmd", "--flag"] },
        LOCAL_BARE,
      )
      expect(params.qmdPatchCmd).toEqual(["patch-cmd", "--flag"])
    })

    it("validateParams rejects qmdPatchCmd as plain string", () => {
      expect(() =>
        driver.validateParams(
          { unit: "my.service", package: "my-pkg", qmdPatchCmd: "patch-cmd --flag" },
          LOCAL_BARE,
        ),
      ).toThrow(/array of strings/)
    })

    it("validateParams rejects qmdPatchCmd as number", () => {
      expect(() =>
        driver.validateParams(
          { unit: "my.service", package: "my-pkg", qmdPatchCmd: 42 },
          LOCAL_BARE,
        ),
      ).toThrow(/array of strings/)
    })

    it("validateParams rejects qmdPatchCmd as array with non-string elements", () => {
      expect(() =>
        driver.validateParams(
          { unit: "my.service", package: "my-pkg", qmdPatchCmd: ["cmd", 42] },
          LOCAL_BARE,
        ),
      ).toThrow(/array of strings/)
    })

    it("apply() passes qmdPatchCmd array directly to exec (no split)", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["bun", "install", "-g", "my-pkg@1.3.0"], { code: 0, stdout: "", stderr: "", timedOut: false })
      exe.addResponse(["patch-cmd", "--flag", "arg with spaces"], { code: 0, stdout: "", stderr: "", timedOut: false })
      exe.addResponse(["grep"], { code: 0, stdout: "", stderr: "", timedOut: false })
      exe.addResponse(["systemctl", "--user", "is-active"], { code: 0, stdout: "active", stderr: "", timedOut: false })
      const params = driver.validateParams(
        { unit: "my.service", package: "my-pkg", qmdPatchCmd: ["patch-cmd", "--flag", "arg with spaces"] },
        LOCAL_BARE,
      )
      const ctx: DriverContext<typeof params> = { exec: { service: exe }, params, log: vi.fn(), dryRun: false }
      const target: ResolvedTarget = { ref: "1.3.0", previous: "1.2.3", noop: false, revertible: false }
      await driver.apply(ctx, target)
      const log = exe.getCallLog()
      const patchCall = log.find((c) => c.argv[0] === "patch-cmd")
      expect(patchCall).toBeDefined()
      // "arg with spaces" must be a single argv element, not split
      expect(patchCall!.argv).toEqual(["patch-cmd", "--flag", "arg with spaces"])
    })
  })

  describe("HermesDriver", () => {
    const driver = new HermesDriver()

    it("validateParams accepts updateCmd as string array", () => {
      const params = driver.validateParams(
        { apiBaseUrl: "https://api.example.com", apiKeyRef: "token123", updateCmd: ["hermes", "update", "--force"] },
        LOCAL_BARE,
      )
      expect(params.updateCmd).toEqual(["hermes", "update", "--force"])
    })

    it("validateParams rejects updateCmd as plain string", () => {
      expect(() =>
        driver.validateParams(
          { apiBaseUrl: "https://api.example.com", apiKeyRef: "token123", updateCmd: "hermes update" },
          LOCAL_BARE,
        ),
      ).toThrow(/array of strings/)
    })

    it("validateParams rejects updateCmd as array with non-string elements", () => {
      expect(() =>
        driver.validateParams(
          { apiBaseUrl: "https://api.example.com", apiKeyRef: "token123", updateCmd: ["hermes", 42] },
          LOCAL_BARE,
        ),
      ).toThrow(/array of strings/)
    })

    it("apply() uses updateCmd array directly — no split, preserves args with spaces", async () => {
      const exe = new FakeShellExecutor()
      exe.setDefault({ code: 0, stdout: "", stderr: "", timedOut: false })
      exe.addResponse(["hermes", "update", "--channel", "stable"], { code: 0, stdout: "", stderr: "", timedOut: false })
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "https://api.example.com/health"], {
        code: 0, stdout: "ok", stderr: "", timedOut: false,
      })
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "https://api.example.com/v1/capabilities"], {
        code: 0, stdout: '{"version":"2.0.0"}', stderr: "", timedOut: false,
      })
      const params = driver.validateParams(
        { apiBaseUrl: "https://api.example.com", apiKeyRef: "tok", updateCmd: ["hermes", "update", "--channel", "stable"] },
        LOCAL_BARE,
      )
      const ctx: DriverContext<typeof params> = { exec: { service: exe }, params, log: vi.fn(), dryRun: false }
      const target: ResolvedTarget = { ref: "latest", previous: "1.0.0", noop: false, revertible: false }
      await driver.apply(ctx, target)
      const log = exe.getCallLog()
      const updateCall = log[0]
      expect(updateCall?.argv).toEqual(["hermes", "update", "--channel", "stable"])
    })

    it("apply() defaults to ['hermes', 'update'] when updateCmd not set", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["hermes", "update"], { code: 0, stdout: "", stderr: "", timedOut: false })
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "https://api.example.com/health"], {
        code: 0, stdout: "ok", stderr: "", timedOut: false,
      })
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "https://api.example.com/v1/capabilities"], {
        code: 0, stdout: '{"version":"1.1.0"}', stderr: "", timedOut: false,
      })
      const params = driver.validateParams(
        { apiBaseUrl: "https://api.example.com", apiKeyRef: "tok" },
        LOCAL_BARE,
      )
      const ctx: DriverContext<typeof params> = { exec: { service: exe }, params, log: vi.fn(), dryRun: false }
      const target: ResolvedTarget = { ref: "latest", previous: "1.0.0", noop: false, revertible: false }
      const outcome = await driver.apply(ctx, target)
      expect(outcome.status).toBe("updated")
      const log = exe.getCallLog()
      expect(log[0]?.argv).toEqual(["hermes", "update"])
    })

    it("plan() joins updateCmd array for display", async () => {
      const exe = new FakeShellExecutor()
      const params = driver.validateParams(
        { apiBaseUrl: "https://api.example.com", apiKeyRef: "tok", updateCmd: ["hermes", "upgrade", "--force"] },
        LOCAL_BARE,
      )
      const ctx: DriverContext<typeof params> = { exec: { service: exe }, params, log: vi.fn(), dryRun: false }
      const target: ResolvedTarget = { ref: "latest", previous: "1.0.0", noop: false, revertible: false }
      const lines = await driver.plan(ctx, target)
      const updateCmdLine = lines.find((l) => l.startsWith("UpdateCmd:"))
      expect(updateCmdLine).toContain("hermes upgrade --force")
    })
  })
})
