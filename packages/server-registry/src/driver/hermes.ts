// packages/server-registry/src/driver/hermes.ts
import type { ServerUpdateDriver, VersionRef, ResolvedTarget, ApplyOutcome, HealthReport, DriverContext } from "./contract.js"
import type { RuntimeKind, ShellExecutor } from "../runtime/executor.js"

export interface HermesParams {
  readonly apiBaseUrl: string
  /** Resolved token value (registry layer resolves tokenRef→token before passing to driver). */
  readonly apiKeyRef: string
  readonly updateCmd?: string[]
  // "agentic" is explicitly rejected by validateParams — only "cli" is accepted
  readonly applyMode?: "cli"
  /** Set by validateParams — never from TOML. */
  readonly _runtime: RuntimeKind
}

const KNOWN_PARAMS = new Set(["apiBaseUrl", "apiKeyRef", "updateCmd", "applyMode"])

export class HermesDriver implements ServerUpdateDriver<HermesParams> {
  readonly kind = "hermes" as const
  readonly requires = "shell" as const

  validateParams(raw: unknown, runtime: RuntimeKind): HermesParams {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("hermes params must be an object")
    }
    const obj = raw as Record<string, unknown>

    for (const key of Object.keys(obj)) {
      if (!KNOWN_PARAMS.has(key)) {
        throw new Error(
          `hermes params: unknown key '${key}' (known: ${[...KNOWN_PARAMS].join(", ")})`,
        )
      }
    }

    if (typeof obj["apiBaseUrl"] !== "string" || !obj["apiBaseUrl"]) {
      throw new Error("hermes params: 'apiBaseUrl' is required and must be a non-empty string")
    }
    if (typeof obj["apiKeyRef"] !== "string" || !obj["apiKeyRef"]) {
      throw new Error("hermes params: 'apiKeyRef' is required and must be a non-empty string")
    }

    // Explicitly reject agentic mode — not supported by this driver
    if (obj["applyMode"] === "agentic") {
      throw new Error(
        "hermes params: applyMode 'agentic' is not supported by this driver. " +
        "Only 'cli' is accepted. Agentic apply mode requires a separate driver implementation.",
      )
    }

    if (obj["applyMode"] !== undefined && obj["applyMode"] !== "cli") {
      throw new Error(`hermes params: applyMode must be 'cli' or omitted, got '${String(obj["applyMode"])}'`)
    }

    const params: HermesParams = {
      apiBaseUrl: obj["apiBaseUrl"],
      apiKeyRef: obj["apiKeyRef"],
      _runtime: runtime,
    }

    type Optionals = { updateCmd?: string[]; applyMode?: "cli" }
    const optionals: Optionals = {}
    if (obj["updateCmd"] !== undefined) {
      if (!Array.isArray(obj["updateCmd"]) || !(obj["updateCmd"] as unknown[]).every((x) => typeof x === "string")) {
        throw new Error("hermes params: 'updateCmd' must be an array of strings (e.g. ['hermes', 'update'])")
      }
      optionals.updateCmd = obj["updateCmd"] as string[]
    }
    if (obj["applyMode"] === "cli") optionals.applyMode = "cli"

    return { ...params, ...optionals }
  }

  async currentVersion(ctx: DriverContext<HermesParams>): Promise<VersionRef> {
    const svc = ctx.exec.service as ShellExecutor
    // ⚠️ ASSUMPTION (LUNA_LIVE_HERMES to confirm): /v1/capabilities endpoint exists
    // ⚠️ ASSUMPTION (LUNA_LIVE_HERMES to confirm): the version field is named "version" in the response
    // Token sent via stdin (-H @-), NEVER in argv
    const result = await svc.exec({
      argv: ["curl", "-fsS", "-m", "10", "-H", "@-", `${ctx.params.apiBaseUrl}/v1/capabilities`],
      stdin: `Authorization: Bearer ${ctx.params.apiKeyRef}\n`,
    })
    if (result.code !== 0) return "unknown"
    try {
      // ⚠️ ASSUMPTION (LUNA_LIVE_HERMES to confirm): response JSON shape { version: string, ... }
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>
      const version = parsed["version"]
      if (typeof version === "string") return version
    } catch {
      // parse failure → unknown
    }
    return "unknown"
  }

  async resolveTarget(ctx: DriverContext<HermesParams>, ref?: VersionRef): Promise<ResolvedTarget> {
    const previous = await this.currentVersion(ctx)
    // ⚠️ ASSUMPTION (LUNA_LIVE_HERMES to confirm): hermes update is not safely reversible
    // Conservative default: revertible=false, noop=false (we can't know without live Hermes)
    return {
      ref: ref ?? "latest",
      previous,
      noop: false,
      revertible: false, // ⚠️ ASSUMPTION (LUNA_LIVE_HERMES to confirm): config migrations may not be reversible
    }
  }

  async plan(ctx: DriverContext<HermesParams>, target: ResolvedTarget): Promise<readonly string[]> {
    const updateCmd = ctx.params.updateCmd?.join(" ") ?? "hermes update"
    return [
      `Driver: ${this.kind}`,
      `ApiBaseUrl: ${ctx.params.apiBaseUrl}`,
      `UpdateCmd: ${updateCmd}`,
      // ⚠️ ASSUMPTION (LUNA_LIVE_HERMES to confirm): whether hermes update accepts a target version
      `From: ${target.previous}`,
      `To: ${target.ref} (ASSUMPTION: may not be honored if hermes update ignores version arg)`,
      `Noop: ${target.noop}`,
      `DryRun: ${ctx.dryRun}`,
      `Revertible: ${target.revertible} (ASSUMPTION: conservative default — confirm with live Hermes)`,
    ]
  }

  async apply(ctx: DriverContext<HermesParams>, target: ResolvedTarget): Promise<ApplyOutcome> {
    if (target.noop) return { status: "noop", at: target.ref }

    const svc = ctx.exec.service as ShellExecutor
    // ⚠️ ASSUMPTION (LUNA_LIVE_HERMES to confirm): `hermes update` (or updateCmd) performs the update
    // Token NEVER in argv — only via environment or stdin if the update cmd needs it
    const updateArgv = ctx.params.updateCmd ?? ["hermes", "update"]

    const result = await svc.exec({ argv: updateArgv })

    if (result.code !== 0) {
      return {
        status: "failed",
        attempted: target.ref,
        cause: result.stderr || `exit code ${result.code}`,
      }
    }

    // Verify via health check
    const health = await this.healthCheck(ctx)
    if (!health.healthy) {
      // No rollback — revertible=false
      return {
        status: "failed",
        attempted: target.ref,
        cause: "health check failed after hermes update",
      }
    }

    // Re-read version to get actual deployed ref
    const actual = await this.currentVersion(ctx)
    return { status: "updated", from: target.previous, to: actual }
  }

  async healthCheck(ctx: DriverContext<HermesParams>): Promise<HealthReport> {
    const svc = ctx.exec.service as ShellExecutor
    // Token sent via stdin (-H @-), NEVER in argv
    // ⚠️ ASSUMPTION (LUNA_LIVE_HERMES to confirm): /health endpoint exists and returns 2xx when healthy
    const result = await svc.exec({
      argv: ["curl", "-fsS", "-m", "10", "-H", "@-", `${ctx.params.apiBaseUrl}/health`],
      stdin: `Authorization: Bearer ${ctx.params.apiKeyRef}\n`,
    })
    return {
      healthy: result.code === 0,
      checks: [{ name: "http/health", ok: result.code === 0 }],
    }
  }

  // No rollback method — revertible is false per conservative default
  // ⚠️ ASSUMPTION (LUNA_LIVE_HERMES to confirm): hermes update is irreversible (config migrations)
}
