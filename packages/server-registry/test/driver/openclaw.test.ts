import { describe, it, expect, vi } from "vitest"
import { OpenClawDriver } from "../../src/driver/openclaw.js"
import type { OpenClawParams } from "../../src/driver/openclaw.js"
import type { RuntimeKind, ExecutionContext } from "../../src/runtime/executor.js"
import type { DriverContext, ResolvedTarget } from "../../src/driver/contract.js"
import { FakeShellExecutor } from "../helpers/fake-executor.js"

const LOCAL_BARE: RuntimeKind = { transport: "local", target: "bareFolder", hostRepoDir: "/repo" }

function makeCtx(
  exe: FakeShellExecutor,
  extraParams: Partial<Omit<OpenClawParams, "unit" | "package" | "_runtime">> = {},
): DriverContext<OpenClawParams> {
  const params: OpenClawParams = {
    unit: "openclaw.service",
    package: "openclaw",
    _runtime: LOCAL_BARE,
    ...extraParams,
  }
  const exec: ExecutionContext = { service: exe }
  return { exec, params, log: vi.fn(), dryRun: false }
}

const NOOP_TARGET: ResolvedTarget = { ref: "1.2.3", previous: "1.2.3", noop: true, revertible: false }
const UPDATE_TARGET: ResolvedTarget = { ref: "1.3.0", previous: "1.2.3", noop: false, revertible: false }

describe("OpenClawDriver", () => {
  const driver = new OpenClawDriver()

  // ── validateParams ────────────────────────────────────────────────────────

  describe("validateParams", () => {
    it("accepts valid minimal params", () => {
      const p = driver.validateParams({ unit: "openclaw.service", package: "openclaw" }, LOCAL_BARE)
      expect(p.unit).toBe("openclaw.service")
      expect(p.package).toBe("openclaw")
      expect(p._runtime).toBe(LOCAL_BARE)
    })

    it("accepts all known optional fields", () => {
      const p = driver.validateParams(
        {
          unit: "openclaw.service",
          package: "openclaw",
          version: "1.2.3",
          healthPort: 8080,
          configPath: "/etc/openclaw/config.toml",
          qmdFile: "/etc/openclaw/query.qmd",
          qmdPatchMarker: "# LUNA_PATCH",
          qmdPatchCmd: ["patch", "-p1", "openclaw.patch"],
          knownGoodConfig: "/etc/openclaw/config.good.toml",
          configReloadSignal: "SIGUSR1",
        },
        LOCAL_BARE,
      )
      expect(p.version).toBe("1.2.3")
      expect(p.healthPort).toBe(8080)
      expect(p.configReloadSignal).toBe("SIGUSR1")
    })

    it("rejects unknown keys", () => {
      expect(() =>
        driver.validateParams({ unit: "openclaw.service", package: "openclaw", typo: "oops" }, LOCAL_BARE),
      ).toThrow("unknown key 'typo'")
    })

    it("rejects missing unit", () => {
      expect(() => driver.validateParams({ package: "openclaw" }, LOCAL_BARE)).toThrow("'unit' is required")
    })

    it("rejects missing package", () => {
      expect(() => driver.validateParams({ unit: "openclaw.service" }, LOCAL_BARE)).toThrow("'package' is required")
    })

    it("rejects non-object input", () => {
      expect(() => driver.validateParams(42, LOCAL_BARE)).toThrow("must be an object")
    })
  })

  // ── apply: noop ───────────────────────────────────────────────────────────

  it("returns noop when target.noop is true", async () => {
    const exe = new FakeShellExecutor()
    const ctx = makeCtx(exe)
    const outcome = await driver.apply(ctx, NOOP_TARGET)
    expect(outcome.status).toBe("noop")
  })

  // ── apply: config-only path ───────────────────────────────────────────────

  describe("apply config-only (meta.configOnly=true)", () => {
    it("writes config file and sends pkill SIGUSR1", async () => {
      const exe = new FakeShellExecutor()
      // healthz returns healthy
      exe.addResponse(["systemctl", "--user", "is-active"], { code: 0, stdout: "active", stderr: "", timedOut: false })
      const ctx = makeCtx(exe, { configPath: "/etc/openclaw/config.toml" })
      const target: ResolvedTarget = {
        ref: "cfg-v2",
        previous: "cfg-v1",
        noop: false,
        revertible: false,
        meta: { configOnly: true, configContent: "new = true\n" },
      }
      await driver.apply(ctx, target)
      const log = exe.getCallLog()
      // Should have called pkill
      const pkillCall = log.find((c) => c.argv[0] === "pkill")
      expect(pkillCall).toBeDefined()
      expect(pkillCall?.argv).toContain("-f")
      expect(pkillCall?.argv).toContain("openclaw")
      // Should have written config
      const written = exe.getWrittenFiles()
      expect(written.get("/etc/openclaw/config.toml")).toBe("new = true\n")
    })

    it("returns updated when health check passes after reload", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["systemctl", "--user", "is-active", "openclaw.service"], {
        code: 0, stdout: "active", stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe, { configPath: "/etc/openclaw/config.toml" })
      const target: ResolvedTarget = {
        ref: "cfg-v2",
        previous: "cfg-v1",
        noop: false,
        revertible: false,
        meta: { configOnly: true, configContent: "x=1\n" },
      }
      const outcome = await driver.apply(ctx, target)
      expect(outcome.status).toBe("updated")
    })

    it("returns rolled-back when health fails after reload", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["systemctl", "--user", "is-active", "openclaw.service"], {
        code: 1, stdout: "failed", stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe, { configPath: "/etc/openclaw/config.toml" })
      const target: ResolvedTarget = {
        ref: "cfg-v2",
        previous: "cfg-v1",
        noop: false,
        revertible: false,
        meta: { configOnly: true, configContent: "x=1\n" },
      }
      const outcome = await driver.apply(ctx, target)
      expect(outcome.status).toBe("rolled-back")
    })
  })

  // ── apply: full path ──────────────────────────────────────────────────────

  describe("apply full path", () => {
    it("stop → install → start sequence on success", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["bun", "install", "-g", "openclaw@1.3.0"], { code: 0, stdout: "", stderr: "", timedOut: false })
      exe.addResponse(["systemctl", "--user", "is-active", "openclaw.service"], {
        code: 0, stdout: "active", stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe)
      const outcome = await driver.apply(ctx, UPDATE_TARGET)
      const log = exe.getCallLog()
      const stopIdx = log.findIndex((c) => c.argv.includes("stop"))
      const installIdx = log.findIndex((c) => c.argv[0] === "bun")
      const startIdx = log.findIndex((c) => c.argv.includes("start"))
      expect(stopIdx).toBeGreaterThan(-1)
      expect(installIdx).toBeGreaterThan(stopIdx)
      expect(startIdx).toBeGreaterThan(installIdx)
      expect(outcome.status).toBe("updated")
    })

    it("returns failed when bun install fails", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["bun", "install", "-g", "openclaw@1.3.0"], {
        code: 1, stdout: "", stderr: "install failed", timedOut: false,
      })
      const ctx = makeCtx(exe)
      const outcome = await driver.apply(ctx, UPDATE_TARGET)
      expect(outcome.status).toBe("failed")
      if (outcome.status === "failed") expect(outcome.cause).toContain("install failed")
    })

    it("verifies QMD marker — grep exit 0 proceeds", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["bun", "install", "-g", "openclaw@1.3.0"], { code: 0, stdout: "", stderr: "", timedOut: false })
      exe.addResponse(["my-patch", "script"], { code: 0, stdout: "", stderr: "", timedOut: false })
      exe.addResponse(["grep", "-q", "# LUNA_PATCH", "/etc/openclaw/query.qmd"], {
        code: 0, stdout: "", stderr: "", timedOut: false,
      })
      exe.addResponse(["systemctl", "--user", "is-active", "openclaw.service"], {
        code: 0, stdout: "active", stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe, {
        qmdFile: "/etc/openclaw/query.qmd",
        qmdPatchMarker: "# LUNA_PATCH",
        qmdPatchCmd: ["my-patch", "script"],
      })
      const outcome = await driver.apply(ctx, UPDATE_TARGET)
      expect(outcome.status).toBe("updated")
    })

    it("triggers rollback when QMD marker grep fails (exit nonzero)", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["bun", "install", "-g", "openclaw@1.3.0"], { code: 0, stdout: "", stderr: "", timedOut: false })
      exe.addResponse(["grep", "-q", "# LUNA_PATCH", "/etc/openclaw/query.qmd"], {
        code: 1, stdout: "", stderr: "", timedOut: false,
      })
      // rollback calls stop, bun install, start, is-active
      exe.addResponse(["systemctl", "--user", "is-active", "openclaw.service"], {
        code: 0, stdout: "active", stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe, {
        qmdFile: "/etc/openclaw/query.qmd",
        qmdPatchMarker: "# LUNA_PATCH",
      })
      const outcome = await driver.apply(ctx, UPDATE_TARGET)
      expect(outcome.status).toBe("rolled-back")
    })

    it("rolls back when health check fails after start", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["bun", "install", "-g", "openclaw@1.3.0"], { code: 0, stdout: "", stderr: "", timedOut: false })
      // First healthcheck (after apply) fails, second (after rollback) passes
      let healthCallCount = 0
      exe.addResponse(["systemctl", "--user", "is-active", "openclaw.service"], {
        code: 0, stdout: "active", stderr: "", timedOut: false,
      })
      // Override: first is-active = fail, second = pass
      const originalExec = exe.exec.bind(exe)
      ;(exe as unknown as Record<string, unknown>)["exec"] = async (req: { argv: string[] }) => {
        if (req.argv[0] === "systemctl" && req.argv.includes("is-active")) {
          healthCallCount++
          if (healthCallCount === 1) {
            return { code: 1, stdout: "failed", stderr: "", timedOut: false }
          }
          return { code: 0, stdout: "active", stderr: "", timedOut: false }
        }
        return originalExec(req)
      }
      const ctx = makeCtx(exe)
      const outcome = await driver.apply(ctx, UPDATE_TARGET)
      expect(outcome.status).toBe("rolled-back")
    })
  })

  // ── no auth token in argv ─────────────────────────────────────────────────

  it("never puts auth tokens or Bearer in argv", async () => {
    const exe = new FakeShellExecutor()
    exe.addResponse(["systemctl"], { code: 0, stdout: "active", stderr: "", timedOut: false })
    exe.addResponse(["bun"], { code: 0, stdout: "", stderr: "", timedOut: false })
    const ctx = makeCtx(exe)
    await driver.apply(ctx, UPDATE_TARGET)
    const log = exe.getCallLog()
    for (const call of log) {
      for (const arg of call.argv) {
        expect(arg.toLowerCase()).not.toContain("bearer")
        expect(arg.toLowerCase()).not.toContain("authorization")
      }
    }
  })

  // ── healthCheck ───────────────────────────────────────────────────────────

  describe("healthCheck", () => {
    it("reports healthy when systemctl is-active succeeds", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["systemctl", "--user", "is-active", "openclaw.service"], {
        code: 0, stdout: "active", stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe)
      const health = await driver.healthCheck(ctx)
      expect(health.healthy).toBe(true)
    })

    it("reports unhealthy when systemctl is-active fails", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["systemctl", "--user", "is-active", "openclaw.service"], {
        code: 1, stdout: "failed", stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe)
      const health = await driver.healthCheck(ctx)
      expect(health.healthy).toBe(false)
    })

    it("includes HTTP check when healthPort is configured", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["systemctl", "--user", "is-active"], { code: 0, stdout: "active", stderr: "", timedOut: false })
      exe.addResponse(["curl", "-fsS", "-m", "5", "http://127.0.0.1:8080/health"], {
        code: 0, stdout: "ok", stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe, { healthPort: 8080 })
      const health = await driver.healthCheck(ctx)
      expect(health.checks.some((c) => c.name === "http/health")).toBe(true)
    })

    it("XDG_RUNTIME_DIR never hardcoded in argv (systemctl uses --user, no uid path)", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["systemctl", "--user", "is-active", "openclaw.service"], {
        code: 0, stdout: "active", stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe)
      await driver.healthCheck(ctx)
      const log = exe.getCallLog()
      for (const call of log) {
        for (const arg of call.argv) {
          expect(arg).not.toMatch(/\/run\/user\/\d+/)
        }
      }
    })
  })

  it("has kind='openclaw'", () => expect(driver.kind).toBe("openclaw"))
  it("has requires='shell'", () => expect(driver.requires).toBe("shell"))
})
