// packages/server-registry/src/driver/openclaw.ts
import type { ServerUpdateDriver, VersionRef, ResolvedTarget, ApplyOutcome, HealthReport, DriverContext } from "./contract.js"
import type { RuntimeKind, ShellExecutor } from "../runtime/executor.js"

export interface OpenClawParams {
  readonly unit: string
  readonly package: string
  readonly version?: string
  readonly healthPort?: number
  readonly configPath?: string
  readonly qmdFile?: string
  readonly qmdPatchMarker?: string
  readonly qmdPatchCmd?: string[]
  readonly knownGoodConfig?: string
  readonly configReloadSignal?: "SIGUSR1"
  /** Set by validateParams — never from TOML. */
  readonly _runtime: RuntimeKind
}

const KNOWN_PARAMS = new Set([
  "unit",
  "package",
  "version",
  "healthPort",
  "configPath",
  "qmdFile",
  "qmdPatchMarker",
  "qmdPatchCmd",
  "knownGoodConfig",
  "configReloadSignal",
])

export class OpenClawDriver implements ServerUpdateDriver<OpenClawParams> {
  readonly kind = "openclaw" as const
  readonly requires = "shell" as const

  validateParams(raw: unknown, runtime: RuntimeKind): OpenClawParams {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("openclaw params must be an object")
    }
    const obj = raw as Record<string, unknown>

    for (const key of Object.keys(obj)) {
      if (!KNOWN_PARAMS.has(key)) {
        throw new Error(
          `openclaw params: unknown key '${key}' (known: ${[...KNOWN_PARAMS].join(", ")})`,
        )
      }
    }

    if (typeof obj["unit"] !== "string" || !obj["unit"]) {
      throw new Error("openclaw params: 'unit' is required and must be a non-empty string")
    }
    if (typeof obj["package"] !== "string" || !obj["package"]) {
      throw new Error("openclaw params: 'package' is required and must be a non-empty string")
    }

    const params: OpenClawParams = {
      unit: obj["unit"],
      package: obj["package"],
      _runtime: runtime,
    }

    // Charset validation for shell-injected names
    if (!/^[A-Za-z0-9_.\-\/@]+$/.test(obj["unit"] as string)) {
      throw new Error(
        `openclaw params: 'unit' contains unsafe characters (allowed: A-Za-z0-9_.-/@): '${obj["unit"]}'`,
      )
    }
    if (!/^[A-Za-z0-9_.\-\/@]+$/.test(obj["package"] as string)) {
      throw new Error(
        `openclaw params: 'package' contains unsafe characters (allowed: A-Za-z0-9_.-/@): '${obj["package"]}'`,
      )
    }

    type Optionals = {
      version?: string
      healthPort?: number
      configPath?: string
      qmdFile?: string
      qmdPatchMarker?: string
      qmdPatchCmd?: string[]
      knownGoodConfig?: string
      configReloadSignal?: "SIGUSR1"
    }
    const optionals: Optionals = {}
    if (typeof obj["version"] === "string") optionals.version = obj["version"]
    if (typeof obj["healthPort"] === "number") optionals.healthPort = obj["healthPort"]
    if (typeof obj["configPath"] === "string") optionals.configPath = obj["configPath"]
    if (typeof obj["qmdFile"] === "string") {
      if (!/^[A-Za-z0-9_.\-\/@]+$/.test(obj["qmdFile"])) {
        throw new Error(
          `openclaw params: 'qmdFile' contains unsafe characters (allowed: A-Za-z0-9_.-/@): '${obj["qmdFile"]}'`,
        )
      }
      optionals.qmdFile = obj["qmdFile"]
    }
    if (typeof obj["qmdPatchMarker"] === "string") optionals.qmdPatchMarker = obj["qmdPatchMarker"]
    if (obj["qmdPatchCmd"] !== undefined) {
      if (!Array.isArray(obj["qmdPatchCmd"]) || !(obj["qmdPatchCmd"] as unknown[]).every((x) => typeof x === "string")) {
        throw new Error("openclaw params: 'qmdPatchCmd' must be an array of strings (e.g. ['my-cmd', '--flag'])")
      }
      optionals.qmdPatchCmd = obj["qmdPatchCmd"] as string[]
    }
    if (typeof obj["knownGoodConfig"] === "string") optionals.knownGoodConfig = obj["knownGoodConfig"]
    if (obj["configReloadSignal"] === "SIGUSR1") optionals.configReloadSignal = "SIGUSR1"

    return { ...params, ...optionals }
  }

  async currentVersion(ctx: DriverContext<OpenClawParams>): Promise<VersionRef> {
    const svc = ctx.exec.service as ShellExecutor
    // Query the installed bun package version
    const result = await svc.exec({
      argv: ["bun", "pm", "ls", "--global"],
    })
    // Parse the package name from output; fallback to "unknown"
    const pkg = ctx.params.package
    const line = result.stdout.split("\n").find((l) => l.includes(pkg))
    if (line) {
      const match = /@([\w.\-]+)/.exec(line)
      if (match?.[1]) return match[1]
    }
    return "unknown"
  }

  async resolveTarget(ctx: DriverContext<OpenClawParams>, ref?: VersionRef): Promise<ResolvedTarget> {
    const previous = await this.currentVersion(ctx)
    const targetRef = ref ?? ctx.params.version ?? "latest"
    return {
      ref: targetRef,
      previous,
      noop: targetRef !== "latest" && targetRef === previous,
      revertible: ctx.params.knownGoodConfig !== undefined,
    }
  }

  async plan(ctx: DriverContext<OpenClawParams>, target: ResolvedTarget): Promise<readonly string[]> {
    const lines: string[] = [
      `Driver: ${this.kind}`,
      `Unit: ${ctx.params.unit}`,
      `Package: ${ctx.params.package}`,
      `From: ${target.previous}`,
      `To: ${target.ref}`,
      `Noop: ${target.noop}`,
      `DryRun: ${ctx.dryRun}`,
    ]
    if (ctx.params.configPath) lines.push(`ConfigPath: ${ctx.params.configPath}`)
    if (ctx.params.qmdFile) lines.push(`QmdFile: ${ctx.params.qmdFile}`)
    return lines
  }

  async apply(ctx: DriverContext<OpenClawParams>, target: ResolvedTarget): Promise<ApplyOutcome> {
    if (target.noop) return { status: "noop", at: target.ref }

    // Config-only path: only reload config, no package reinstall
    if (target.meta?.["configOnly"] === true) {
      return this.applyConfigOnly(ctx, target)
    }

    return this.applyFull(ctx, target)
  }

  private async applyConfigOnly(ctx: DriverContext<OpenClawParams>, target: ResolvedTarget): Promise<ApplyOutcome> {
    const svc = ctx.exec.service as ShellExecutor

    // Write new config if configPath is set
    if (ctx.params.configPath && typeof target.meta?.["configContent"] === "string") {
      await svc.writeFile(ctx.params.configPath, target.meta["configContent"])
    }

    // Send SIGUSR1 to reload config (pkill -USR1 -f openclaw)
    const signal = ctx.params.configReloadSignal ?? "SIGUSR1"
    const sigNum = signal === "SIGUSR1" ? "-USR1" : "-USR1"
    await svc.exec({ argv: ["pkill", sigNum, "-f", "openclaw"] })

    // Verify health after reload
    const health = await this.healthCheck(ctx)
    if (!health.healthy) {
      return {
        status: "rolled-back",
        attempted: target.ref,
        recovered: target.previous,
        cause: "health check failed after config reload",
      }
    }

    return { status: "updated", from: target.previous, to: target.ref }
  }

  private async applyFull(ctx: DriverContext<OpenClawParams>, target: ResolvedTarget): Promise<ApplyOutcome> {
    const svc = ctx.exec.service as ShellExecutor

    if (!ctx.dryRun) {
      // Stop unit
      await svc.exec({ argv: ["systemctl", "--user", "stop", ctx.params.unit] })

      // Install package via bun
      const pkgSpec =
        target.ref !== "latest"
          ? `${ctx.params.package}@${target.ref}`
          : ctx.params.package
      const installResult = await svc.exec({ argv: ["bun", "install", "-g", pkgSpec] })
      if (installResult.code !== 0) {
        // Restore and restart before returning failure
        await svc.exec({ argv: ["systemctl", "--user", "start", ctx.params.unit] })
        return {
          status: "failed",
          attempted: target.ref,
          cause: installResult.stderr || `bun install exited ${installResult.code}`,
        }
      }

      // Run QMD patch command if configured
      if (ctx.params.qmdPatchCmd) {
        await svc.exec({ argv: ctx.params.qmdPatchCmd })
      }

      // Verify QMD patch marker in qmdFile
      if (ctx.params.qmdFile && ctx.params.qmdPatchMarker) {
        const grepResult = await svc.exec({
          argv: ["grep", "-q", ctx.params.qmdPatchMarker, ctx.params.qmdFile],
        })
        if (grepResult.code !== 0) {
          // Marker not found — patch failed; rollback
          ctx.log(`QMD patch marker '${ctx.params.qmdPatchMarker}' not found in ${ctx.params.qmdFile} — rolling back`)
          const rbOutcome = await this.rollback(ctx, target.previous)
          return {
            status: "rolled-back",
            attempted: target.ref,
            recovered: target.previous,
            cause: `QMD patch verification failed: ${rbOutcome.status}`,
          }
        }
      }

      // Start unit
      await svc.exec({ argv: ["systemctl", "--user", "start", ctx.params.unit] })
    }

    // Health check
    const health = await this.healthCheck(ctx)
    if (!health.healthy && !ctx.dryRun) {
      const rbOutcome = await this.rollback(ctx, target.previous)
      return {
        status: "rolled-back",
        attempted: target.ref,
        recovered: target.previous,
        cause: `health check failed after start: ${rbOutcome.status}`,
      }
    }

    return { status: "updated", from: target.previous, to: target.ref }
  }

  async rollback(ctx: DriverContext<OpenClawParams>, previous: VersionRef): Promise<ApplyOutcome> {
    const svc = ctx.exec.service as ShellExecutor

    // Stop unit
    await svc.exec({ argv: ["systemctl", "--user", "stop", ctx.params.unit] })

    // Restore known-good config if available
    if (ctx.params.knownGoodConfig && ctx.params.configPath) {
      const goodConfig = await svc.readFile(ctx.params.knownGoodConfig)
      if (goodConfig !== undefined) {
        await svc.writeFile(ctx.params.configPath, goodConfig)
      }
    }

    // Reinstall previous version
    if (previous !== "unknown") {
      const pkgSpec = `${ctx.params.package}@${previous}`
      await svc.exec({ argv: ["bun", "install", "-g", pkgSpec] })
    }

    // Re-run patch and verify marker
    if (ctx.params.qmdPatchCmd) {
      await svc.exec({ argv: ctx.params.qmdPatchCmd })
    }

    if (ctx.params.qmdFile && ctx.params.qmdPatchMarker) {
      const grepResult = await svc.exec({
        argv: ["grep", "-q", ctx.params.qmdPatchMarker, ctx.params.qmdFile],
      })
      if (grepResult.code !== 0) {
        await svc.exec({ argv: ["systemctl", "--user", "start", ctx.params.unit] })
        return {
          status: "failed",
          attempted: previous,
          cause: "QMD patch verification failed during rollback",
        }
      }
    }

    // Start unit
    await svc.exec({ argv: ["systemctl", "--user", "start", ctx.params.unit] })

    const health = await this.healthCheck(ctx)
    return health.healthy
      ? { status: "rolled-back", attempted: previous, recovered: previous, cause: "rollback" }
      : { status: "failed", attempted: previous, cause: "health check failed after rollback" }
  }

  async healthCheck(ctx: DriverContext<OpenClawParams>): Promise<HealthReport> {
    const svc = ctx.exec.service as ShellExecutor

    // systemctl --user is-active check
    // NOTE: XDG_RUNTIME_DIR must be in the executor's environment — driver never hardcodes /run/user/<uid>
    const activeResult = await svc.exec({ argv: ["systemctl", "--user", "is-active", ctx.params.unit] })
    const unitActive = activeResult.code === 0

    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [
      { name: "systemctl/is-active", ok: unitActive },
    ]

    // HTTP health check if healthPort is configured
    if (ctx.params.healthPort !== undefined) {
      const httpResult = await svc.exec({
        argv: ["curl", "-fsS", "-m", "5", `http://127.0.0.1:${ctx.params.healthPort}/health`],
      })
      checks.push({ name: "http/health", ok: httpResult.code === 0 })
    }

    const healthy = checks.every((c) => c.ok)
    return { healthy, checks }
  }
}
