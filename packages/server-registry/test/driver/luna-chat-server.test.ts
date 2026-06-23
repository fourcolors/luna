import { describe, it, expect, vi } from "vitest"
import { LunaChatServerDriver } from "../../src/driver/luna-chat-server.js"
import type { LunaChatServerParams } from "../../src/driver/luna-chat-server.js"
import type { RuntimeKind, ExecutionContext } from "../../src/runtime/executor.js"
import type { DriverContext, ResolvedTarget } from "../../src/driver/contract.js"
import { FakeShellExecutor } from "../helpers/fake-executor.js"

const LOCAL_BARE: RuntimeKind = { transport: "local", target: "bareFolder", hostRepoDir: "/repo" }
const LOCAL_INCUS: RuntimeKind = {
  transport: "local",
  target: "incus",
  container: "luna-stable",
  hostRepoDir: "/repo",
  containerRepoDir: "/root/luna",
  lunaHome: "/root/.luna",
}

function makeCtx(
  exe: FakeShellExecutor,
  extraParams: Partial<Omit<LunaChatServerParams, "profile" | "_runtime">> = {},
  runtime: RuntimeKind = LOCAL_BARE,
): DriverContext<LunaChatServerParams> {
  const params: LunaChatServerParams = {
    profile: "stable",
    _runtime: runtime,
    ...extraParams,
  }
  const exec: ExecutionContext = { service: exe }
  return { exec, params, log: vi.fn(), dryRun: false }
}

function makeCtxWithHost(
  hostExe: FakeShellExecutor,
  serviceExe: FakeShellExecutor,
  runtime: RuntimeKind = LOCAL_INCUS,
): DriverContext<LunaChatServerParams> {
  const params: LunaChatServerParams = { profile: "stable", _runtime: runtime }
  const exec: ExecutionContext = { service: serviceExe, host: hostExe }
  return { exec, params, log: vi.fn(), dryRun: false }
}

describe("LunaChatServerDriver", () => {
  const driver = new LunaChatServerDriver("/usr/local/lib/luna/luna-update-server")

  // ── validateParams ────────────────────────────────────────────────────────

  describe("validateParams", () => {
    it("accepts valid minimal params", () => {
      const p = driver.validateParams({ profile: "stable" }, LOCAL_BARE)
      expect(p.profile).toBe("stable")
      expect(p._runtime).toBe(LOCAL_BARE)
    })

    it("accepts all known optional fields", () => {
      const p = driver.validateParams(
        { profile: "dev", ref: "abc123", supervisor: "systemd", rollback: false, restartSettle: 30, repinClaude: true },
        LOCAL_BARE,
      )
      expect(p.ref).toBe("abc123")
      expect(p.supervisor).toBe("systemd")
      expect(p.rollback).toBe(false)
      expect(p.restartSettle).toBe(30)
      expect(p.repinClaude).toBe(true)
    })

    it("rejects non-object input", () => {
      expect(() => driver.validateParams("string", LOCAL_BARE)).toThrow("must be an object")
    })

    it("rejects null", () => {
      expect(() => driver.validateParams(null, LOCAL_BARE)).toThrow("must be an object")
    })

    it("rejects missing profile", () => {
      expect(() => driver.validateParams({}, LOCAL_BARE)).toThrow("'profile' is required")
    })

    it("rejects empty profile string", () => {
      expect(() => driver.validateParams({ profile: "" }, LOCAL_BARE)).toThrow("'profile' is required")
    })

    it("rejects 'incusContainer' key explicitly", () => {
      expect(() =>
        driver.validateParams({ profile: "stable", incusContainer: "luna-stable" }, LOCAL_BARE),
      ).toThrow("incusContainer")
    })

    it("rejects unknown keys (typo protection)", () => {
      expect(() =>
        driver.validateParams({ profile: "stable", unknownKey: "oops" }, LOCAL_BARE),
      ).toThrow("unknown key 'unknownKey'")
    })

    it("embeds runtime into returned params", () => {
      const p = driver.validateParams({ profile: "stable" }, LOCAL_INCUS)
      expect(p._runtime).toBe(LOCAL_INCUS)
    })
  })

  // ── baseFlags / incus derivation ──────────────────────────────────────────

  describe("incus flag derivation", () => {
    it("does NOT add --incus for bareFolder runtime", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["/usr/local/lib/luna/luna-update-server"], { code: 0, stdout: "", stderr: "", timedOut: false })
      const ctx = makeCtx(exe, {}, LOCAL_BARE)
      const target: ResolvedTarget = { ref: "abc123", previous: "def456", noop: false, revertible: true }
      await driver.apply(ctx, target)
      const call = exe.getCallLog()[0]
      expect(call?.argv).not.toContain("--incus")
    })

    it("adds --incus <container> for incus runtime", async () => {
      const hostExe = new FakeShellExecutor()
      const serviceExe = new FakeShellExecutor()
      hostExe.addResponse(["/usr/local/lib/luna/luna-update-server"], { code: 0, stdout: "", stderr: "", timedOut: false })
      const ctx = makeCtxWithHost(hostExe, serviceExe, LOCAL_INCUS)
      const target: ResolvedTarget = { ref: "abc123", previous: "def456", noop: false, revertible: true }
      await driver.apply(ctx, target)
      const call = hostExe.getCallLog()[0]
      expect(call?.argv).toContain("--incus")
      expect(call?.argv).toContain("luna-stable")
    })

    it("incus container name comes from runtime, not params", async () => {
      const hostExe = new FakeShellExecutor()
      const serviceExe = new FakeShellExecutor()
      hostExe.addResponse(["/usr/local/lib/luna/luna-update-server"], { code: 0, stdout: "", stderr: "", timedOut: false })
      const ctx = makeCtxWithHost(hostExe, serviceExe, LOCAL_INCUS)
      const target: ResolvedTarget = { ref: "abc123", previous: "def456", noop: false, revertible: true }
      await driver.apply(ctx, target)
      const argv = hostExe.getCallLog()[0]?.argv ?? []
      const incusIdx = argv.indexOf("--incus")
      expect(incusIdx).toBeGreaterThan(-1)
      expect(argv[incusIdx + 1]).toBe("luna-stable") // from runtime, not params
    })
  })

  // ── apply ─────────────────────────────────────────────────────────────────

  describe("apply", () => {
    it("returns noop when target.noop is true", async () => {
      const exe = new FakeShellExecutor()
      const ctx = makeCtx(exe)
      const target: ResolvedTarget = { ref: "abc", previous: "abc", noop: true, revertible: true }
      const outcome = await driver.apply(ctx, target)
      expect(outcome.status).toBe("noop")
      if (outcome.status === "noop") expect(outcome.at).toBe("abc")
    })

    it("returns updated on exit code 0", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["/usr/local/lib/luna/luna-update-server"], { code: 0, stdout: "", stderr: "", timedOut: false })
      const ctx = makeCtx(exe)
      const target: ResolvedTarget = { ref: "newsha", previous: "oldsha", noop: false, revertible: true }
      const outcome = await driver.apply(ctx, target)
      expect(outcome.status).toBe("updated")
      if (outcome.status === "updated") {
        expect(outcome.from).toBe("oldsha")
        expect(outcome.to).toBe("newsha")
      }
    })

    it("returns rolled-back on exit code 1 with 'ROLLED BACK to' in stderr", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["/usr/local/lib/luna/luna-update-server"], {
        code: 1,
        stdout: "",
        stderr: "warning: update to newsha failed — ROLLED BACK to oldsha (luna-chat-server.service healthy)\n",
        timedOut: false,
      })
      const ctx = makeCtx(exe)
      const target: ResolvedTarget = { ref: "newsha", previous: "oldsha", noop: false, revertible: true }
      const outcome = await driver.apply(ctx, target)
      expect(outcome.status).toBe("rolled-back")
      if (outcome.status === "rolled-back") {
        expect(outcome.attempted).toBe("newsha")
        expect(outcome.recovered).toBe("oldsha")
      }
    })

    it("returns failed on exit code 1 without 'ROLLED BACK to' marker (preflight/forward failure)", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["/usr/local/lib/luna/luna-update-server"], {
        code: 1,
        stdout: "",
        stderr: "error: /root/luna is not a git clone\n",
        timedOut: false,
      })
      const ctx = makeCtx(exe)
      const target: ResolvedTarget = { ref: "newsha", previous: "oldsha", noop: false, revertible: true }
      const outcome = await driver.apply(ctx, target)
      expect(outcome.status).toBe("failed")
      if (outcome.status === "failed") {
        expect(outcome.cause).toContain("not a git clone")
      }
    })

    it("returns failed on exit code 2", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["/usr/local/lib/luna/luna-update-server"], {
        code: 2,
        stdout: "",
        stderr: "unexpected error",
        timedOut: false,
      })
      const ctx = makeCtx(exe)
      const target: ResolvedTarget = { ref: "newsha", previous: "oldsha", noop: false, revertible: true }
      const outcome = await driver.apply(ctx, target)
      expect(outcome.status).toBe("failed")
    })

    it("appends --dry-run when ctx.dryRun is true", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["/usr/local/lib/luna/luna-update-server"], { code: 0, stdout: "", stderr: "", timedOut: false })
      const params: LunaChatServerParams = { profile: "stable", _runtime: LOCAL_BARE }
      const ctx: DriverContext<LunaChatServerParams> = {
        exec: { service: exe },
        params,
        log: vi.fn(),
        dryRun: true,
      }
      const target: ResolvedTarget = { ref: "newsha", previous: "oldsha", noop: false, revertible: true }
      await driver.apply(ctx, target)
      const argv = exe.getCallLog()[0]?.argv ?? []
      expect(argv).toContain("--dry-run")
    })
  })

  // ── rollback ──────────────────────────────────────────────────────────────

  describe("rollback", () => {
    it("uses --ref <sha>, NOT --rollback-to", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["/usr/local/lib/luna/luna-update-server"], { code: 0, stdout: "", stderr: "", timedOut: false })
      const ctx = makeCtx(exe)
      await driver.rollback(ctx, "oldsha123")
      const argv = exe.getCallLog()[0]?.argv ?? []
      expect(argv).toContain("--ref")
      expect(argv).toContain("oldsha123")
      expect(argv).not.toContain("--rollback-to")
    })

    it("does NOT use --no-rollback", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["/usr/local/lib/luna/luna-update-server"], { code: 0, stdout: "", stderr: "", timedOut: false })
      const ctx = makeCtx(exe)
      await driver.rollback(ctx, "oldsha123")
      const argv = exe.getCallLog()[0]?.argv ?? []
      expect(argv).not.toContain("--no-rollback")
    })

    it("returns rolled-back on exit 0", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["/usr/local/lib/luna/luna-update-server"], { code: 0, stdout: "", stderr: "", timedOut: false })
      const ctx = makeCtx(exe)
      const outcome = await driver.rollback(ctx, "oldsha123")
      expect(outcome.status).toBe("rolled-back")
    })

    it("returns failed on nonzero exit", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["/usr/local/lib/luna/luna-update-server"], { code: 1, stdout: "", stderr: "script failed", timedOut: false })
      const ctx = makeCtx(exe)
      const outcome = await driver.rollback(ctx, "oldsha123")
      expect(outcome.status).toBe("failed")
    })
  })

  // ── plan ──────────────────────────────────────────────────────────────────

  describe("plan", () => {
    it("returns an array of strings describing the plan", async () => {
      const exe = new FakeShellExecutor()
      const ctx = makeCtx(exe)
      const target: ResolvedTarget = { ref: "newsha", previous: "oldsha", noop: false, revertible: true }
      const lines = await driver.plan(ctx, target)
      expect(Array.isArray(lines)).toBe(true)
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.some((l) => l.includes("luna-chat-server"))).toBe(true)
      expect(lines.some((l) => l.includes("stable"))).toBe(true)
    })

    it("includes incus container line for incus runtime", async () => {
      const hostExe = new FakeShellExecutor()
      const serviceExe = new FakeShellExecutor()
      const ctx = makeCtxWithHost(hostExe, serviceExe, LOCAL_INCUS)
      const target: ResolvedTarget = { ref: "newsha", previous: "oldsha", noop: false, revertible: true }
      const lines = await driver.plan(ctx, target)
      expect(lines.some((l) => l.includes("luna-stable"))).toBe(true)
    })

    it("does not include incus line for bareFolder runtime", async () => {
      const exe = new FakeShellExecutor()
      const ctx = makeCtx(exe, {}, LOCAL_BARE)
      const target: ResolvedTarget = { ref: "newsha", previous: "oldsha", noop: false, revertible: true }
      const lines = await driver.plan(ctx, target)
      expect(lines.some((l) => l.toLowerCase().includes("incus"))).toBe(false)
    })
  })

  // ── currentVersion ────────────────────────────────────────────────────────

  describe("currentVersion", () => {
    it("returns trimmed stdout of git rev-parse HEAD on host executor", async () => {
      const hostExe = new FakeShellExecutor()
      const serviceExe = new FakeShellExecutor()
      hostExe.addResponse(["git", "-C", "/repo", "rev-parse", "HEAD"], {
        code: 0,
        stdout: "deadbeef1234\n",
        stderr: "",
        timedOut: false,
      })
      const ctx = makeCtxWithHost(hostExe, serviceExe, LOCAL_INCUS)
      const version = await driver.currentVersion(ctx)
      expect(version).toBe("deadbeef1234")
    })

    it("uses service executor when no host present", async () => {
      const exe = new FakeShellExecutor()
      exe.addResponse(["git", "-C", "/repo", "rev-parse", "HEAD"], {
        code: 0,
        stdout: "cafebabe\n",
        stderr: "",
        timedOut: false,
      })
      const ctx = makeCtx(exe, {}, LOCAL_BARE)
      const version = await driver.currentVersion(ctx)
      expect(version).toBe("cafebabe")
    })
  })

  // ── kind / requires ───────────────────────────────────────────────────────

  it("has kind='luna-chat-server'", () => {
    expect(driver.kind).toBe("luna-chat-server")
  })

  it("has requires='shell'", () => {
    expect(driver.requires).toBe("shell")
  })
})
