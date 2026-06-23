import { describe, it, expect, vi } from "vitest"
import { HermesDriver } from "../../src/driver/hermes.js"
import type { HermesParams } from "../../src/driver/hermes.js"
import type { RuntimeKind, ExecutionContext } from "../../src/runtime/executor.js"
import type { DriverContext, ResolvedTarget } from "../../src/driver/contract.js"
import { FakeShellExecutor } from "../helpers/fake-executor.js"

const LOCAL_BARE: RuntimeKind = { transport: "local", target: "bareFolder", hostRepoDir: "/repo" }

function makeCtx(
  exe: FakeShellExecutor,
  extraParams: Partial<Omit<HermesParams, "apiBaseUrl" | "apiKeyRef" | "_runtime">> = {},
): DriverContext<HermesParams> {
  const params: HermesParams = {
    apiBaseUrl: "http://localhost:9000",
    apiKeyRef: "test-token-secret",
    _runtime: LOCAL_BARE,
    ...extraParams,
  }
  const exec: ExecutionContext = { service: exe }
  return { exec, params, log: vi.fn(), dryRun: false }
}

describe("HermesDriver", () => {
  const driver = new HermesDriver()

  // ── validateParams ────────────────────────────────────────────────────────

  describe("validateParams", () => {
    it("accepts valid minimal params", () => {
      const p = driver.validateParams(
        { apiBaseUrl: "http://localhost:9000", apiKeyRef: "tok" },
        LOCAL_BARE,
      )
      expect(p.apiBaseUrl).toBe("http://localhost:9000")
      expect(p.apiKeyRef).toBe("tok")
      expect(p._runtime).toBe(LOCAL_BARE)
    })

    it("accepts applyMode='cli'", () => {
      const p = driver.validateParams(
        { apiBaseUrl: "http://localhost:9000", apiKeyRef: "tok", applyMode: "cli" },
        LOCAL_BARE,
      )
      expect(p.applyMode).toBe("cli")
    })

    it("explicitly rejects applyMode='agentic' with clear message", () => {
      expect(() =>
        driver.validateParams(
          { apiBaseUrl: "http://localhost:9000", apiKeyRef: "tok", applyMode: "agentic" },
          LOCAL_BARE,
        ),
      ).toThrow(/agentic.*not supported/i)
    })

    it("rejects unknown keys", () => {
      expect(() =>
        driver.validateParams(
          { apiBaseUrl: "http://localhost:9000", apiKeyRef: "tok", unknownField: true },
          LOCAL_BARE,
        ),
      ).toThrow("unknown key 'unknownField'")
    })

    it("rejects missing apiBaseUrl", () => {
      expect(() =>
        driver.validateParams({ apiKeyRef: "tok" }, LOCAL_BARE),
      ).toThrow("'apiBaseUrl' is required")
    })

    it("rejects missing apiKeyRef", () => {
      expect(() =>
        driver.validateParams({ apiBaseUrl: "http://localhost:9000" }, LOCAL_BARE),
      ).toThrow("'apiKeyRef' is required")
    })

    it("rejects non-object", () => {
      expect(() => driver.validateParams("string", LOCAL_BARE)).toThrow("must be an object")
    })
  })

  // ── resolveTarget ─────────────────────────────────────────────────────────

  describe("resolveTarget", () => {
    it("always returns revertible=false (conservative default)", async () => {
      const exe = new FakeShellExecutor()
      // currentVersion calls /v1/capabilities
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "http://localhost:9000/v1/capabilities"], {
        code: 0, stdout: '{"version":"1.0.0"}', stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe)
      const target = await driver.resolveTarget(ctx)
      expect(target.revertible).toBe(false)
    })

    it("always returns noop=false (conservative default)", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "http://localhost:9000/v1/capabilities"], {
        code: 0, stdout: '{"version":"1.0.0"}', stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe)
      const target = await driver.resolveTarget(ctx)
      expect(target.noop).toBe(false)
    })
  })

  // ── apply ─────────────────────────────────────────────────────────────────

  describe("apply", () => {
    it("token is sent via stdin (-H @-), NOT in argv", async () => {
      const exe = new FakeShellExecutor()
      // update cmd success
      exe.addResponse(["hermes", "update"], { code: 0, stdout: "", stderr: "", timedOut: false })
      // health check
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "http://localhost:9000/health"], {
        code: 0, stdout: "ok", stderr: "", timedOut: false,
      })
      // currentVersion after apply
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "http://localhost:9000/v1/capabilities"], {
        code: 0, stdout: '{"version":"1.1.0"}', stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe)
      const target: ResolvedTarget = { ref: "latest", previous: "1.0.0", noop: false, revertible: false }
      await driver.apply(ctx, target)
      // Verify token NEVER in argv
      const log = exe.getCallLog()
      for (const call of log) {
        for (const arg of call.argv) {
          expect(arg).not.toContain("test-token-secret")
          expect(arg.toLowerCase()).not.toContain("bearer")
        }
      }
      // Verify token IS in stdin for curl calls
      const curlCalls = log.filter((c) => c.argv[0] === "curl")
      expect(curlCalls.length).toBeGreaterThan(0)
      for (const call of curlCalls) {
        expect(call.stdin).toContain("test-token-secret")
      }
    })

    it("returns updated on exit 0 + healthy", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["hermes", "update"], { code: 0, stdout: "", stderr: "", timedOut: false })
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "http://localhost:9000/health"], {
        code: 0, stdout: "ok", stderr: "", timedOut: false,
      })
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "http://localhost:9000/v1/capabilities"], {
        code: 0, stdout: '{"version":"1.1.0"}', stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe)
      const target: ResolvedTarget = { ref: "latest", previous: "1.0.0", noop: false, revertible: false }
      const outcome = await driver.apply(ctx, target)
      expect(outcome.status).toBe("updated")
    })

    it("returns failed on nonzero exit", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["hermes", "update"], { code: 1, stdout: "", stderr: "update failed", timedOut: false })
      const ctx = makeCtx(exe)
      const target: ResolvedTarget = { ref: "latest", previous: "1.0.0", noop: false, revertible: false }
      const outcome = await driver.apply(ctx, target)
      expect(outcome.status).toBe("failed")
      if (outcome.status === "failed") expect(outcome.cause).toContain("update failed")
    })

    it("returns failed (not rolled-back) when health check fails after update", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["hermes", "update"], { code: 0, stdout: "", stderr: "", timedOut: false })
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "http://localhost:9000/health"], {
        code: 1, stdout: "", stderr: "connection refused", timedOut: false,
      })
      const ctx = makeCtx(exe)
      const target: ResolvedTarget = { ref: "latest", previous: "1.0.0", noop: false, revertible: false }
      const outcome = await driver.apply(ctx, target)
      // revertible=false means failed, not rolled-back
      expect(outcome.status).toBe("failed")
    })

    it("uses custom updateCmd when provided", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["hermes", "upgrade", "--channel", "stable"], { code: 0, stdout: "", stderr: "", timedOut: false })
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "http://localhost:9000/health"], {
        code: 0, stdout: "ok", stderr: "", timedOut: false,
      })
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "http://localhost:9000/v1/capabilities"], {
        code: 0, stdout: '{"version":"1.1.0"}', stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe, { updateCmd: ["hermes", "upgrade", "--channel", "stable"] })
      const target: ResolvedTarget = { ref: "latest", previous: "1.0.0", noop: false, revertible: false }
      await driver.apply(ctx, target)
      const log = exe.getCallLog()
      const updateCall = log[0]
      expect(updateCall?.argv).toEqual(["hermes", "upgrade", "--channel", "stable"])
    })

    it("returns noop when target.noop is true", async () => {
      const exe = new FakeShellExecutor()
      const ctx = makeCtx(exe)
      const target: ResolvedTarget = { ref: "1.0.0", previous: "1.0.0", noop: true, revertible: false }
      const outcome = await driver.apply(ctx, target)
      expect(outcome.status).toBe("noop")
    })
  })

  // ── healthCheck ───────────────────────────────────────────────────────────

  describe("healthCheck", () => {
    it("token sent via stdin, not argv", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "http://localhost:9000/health"], {
        code: 0, stdout: "ok", stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe)
      await driver.healthCheck(ctx)
      const log = exe.getCallLog()
      const curlCall = log.find((c) => c.argv[0] === "curl")
      expect(curlCall).toBeDefined()
      // token NOT in argv
      for (const arg of curlCall?.argv ?? []) {
        expect(arg).not.toContain("test-token-secret")
      }
      // token IS in stdin
      expect(curlCall?.stdin).toContain("test-token-secret")
    })

    it("reports healthy on curl exit 0", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["curl"], { code: 0, stdout: "ok", stderr: "", timedOut: false })
      const ctx = makeCtx(exe)
      const health = await driver.healthCheck(ctx)
      expect(health.healthy).toBe(true)
    })

    it("reports unhealthy on curl nonzero", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["curl"], { code: 1, stdout: "", stderr: "refused", timedOut: false })
      const ctx = makeCtx(exe)
      const health = await driver.healthCheck(ctx)
      expect(health.healthy).toBe(false)
    })
  })

  // ── currentVersion ────────────────────────────────────────────────────────

  describe("currentVersion", () => {
    it("token sent via stdin, not argv", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "http://localhost:9000/v1/capabilities"], {
        code: 0, stdout: '{"version":"2.0.0"}', stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe)
      await driver.currentVersion(ctx)
      const log = exe.getCallLog()
      const curlCall = log.find((c) => c.argv[0] === "curl")
      expect(curlCall).toBeDefined()
      for (const arg of curlCall?.argv ?? []) {
        expect(arg).not.toContain("test-token-secret")
      }
      expect(curlCall?.stdin).toContain("test-token-secret")
    })

    it("returns version string from response", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["curl", "-fsS", "-m", "10", "-H", "@-", "http://localhost:9000/v1/capabilities"], {
        code: 0, stdout: '{"version":"2.0.0"}', stderr: "", timedOut: false,
      })
      const ctx = makeCtx(exe)
      const v = await driver.currentVersion(ctx)
      expect(v).toBe("2.0.0")
    })

    it("returns 'unknown' on curl failure", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["curl"], { code: 1, stdout: "", stderr: "refused", timedOut: false })
      const ctx = makeCtx(exe)
      const v = await driver.currentVersion(ctx)
      expect(v).toBe("unknown")
    })

    it("returns 'unknown' on JSON parse failure", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["curl"], { code: 0, stdout: "not-json", stderr: "", timedOut: false })
      const ctx = makeCtx(exe)
      const v = await driver.currentVersion(ctx)
      expect(v).toBe("unknown")
    })
  })

  // ── no rollback method ────────────────────────────────────────────────────

  it("does not have a rollback method on the instance", () => {
    expect((driver as unknown as Record<string, unknown>)["rollback"]).toBeUndefined()
  })

  it("has kind='hermes'", () => expect(driver.kind).toBe("hermes"))
  it("has requires='shell'", () => expect(driver.requires).toBe("shell"))
})
