// packages/server-registry/src/driver/luna-chat-server.ts
import type { ServerUpdateDriver, VersionRef, ResolvedTarget, ApplyOutcome, HealthReport, DriverContext } from "./contract.js"
import type { RuntimeKind, ShellExecutor } from "../runtime/executor.js"
import { validateExecutionContext } from "../runtime/executor.js"

// LunaChatServerParams includes _runtime set by validateParams (not from TOML).
// This is the transport mechanism for RuntimeKind through the DriverContext
// without changing the generic contract interface.
export interface LunaChatServerParams {
  readonly profile: string
  readonly ref?: string
  readonly supervisor?: "systemd" | "launchd"
  readonly rollback?: boolean
  readonly restartSettle?: number
  readonly repinClaude?: boolean
  /** Set by validateParams from the runtime argument — never from TOML input. */
  readonly _runtime: RuntimeKind
}

const KNOWN_PARAMS = new Set(["profile", "ref", "supervisor", "rollback", "restartSettle", "repinClaude"])

export class LunaChatServerDriver implements ServerUpdateDriver<LunaChatServerParams> {
  readonly kind = "luna-chat-server" as const
  readonly requires = "shell" as const

  constructor(private readonly pinnedScriptPath: string) {}

  validateParams(raw: unknown, runtime: RuntimeKind): LunaChatServerParams {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("luna-chat-server params must be an object")
    }
    const obj = raw as Record<string, unknown>

    // Reject the known-bad key that caused the P_INCUS="" bug class.
    // --incus is always derived from runtime.target, never from params.
    if ("incusContainer" in obj) {
      throw new Error(
        "luna-chat-server params must not contain 'incusContainer': --incus is derived from runtime.target, never from params",
      )
    }

    // Reject unknown keys (typo protection — P_INCUS="" class)
    for (const key of Object.keys(obj)) {
      if (!KNOWN_PARAMS.has(key)) {
        throw new Error(
          `luna-chat-server params: unknown key '${key}' (known: ${[...KNOWN_PARAMS].join(", ")})`,
        )
      }
    }

    if (typeof obj["profile"] !== "string" || !obj["profile"]) {
      throw new Error("luna-chat-server params: 'profile' is required and must be a non-empty string")
    }

    const profile = obj["profile"]

    if (!/^[A-Za-z0-9_.\-]+$/.test(profile)) {
      throw new Error(
        `luna-chat-server params: 'profile' contains unsafe characters (allowed: A-Za-z0-9_.-): '${profile}'`,
      )
    }

    const optionals = buildOptionals(obj)

    return { profile, ...optionals, _runtime: runtime }
  }

  private baseFlags(params: LunaChatServerParams, runtime: RuntimeKind): string[] {
    if (runtime.target === "userSystemd") {
      throw new Error("luna-chat-server driver does not support userSystemd runtime")
    }

    const hostRepoDir = runtime.hostRepoDir
    const flags: string[] = ["--profile", params.profile, "--repo-dir", hostRepoDir]

    // --incus derived from runtime ONLY — NEVER from params (§11 D-orth)
    if (runtime.target === "incus") {
      flags.push("--incus", runtime.container)
    }

    if (params.supervisor !== undefined) flags.push("--supervisor", params.supervisor)
    if (params.restartSettle !== undefined) flags.push("--restart-settle", String(params.restartSettle))
    if (params.rollback === false) flags.push("--no-rollback")
    if (params.repinClaude === true) flags.push("--repin-claude")

    return flags
  }

  async currentVersion(ctx: DriverContext<LunaChatServerParams>): Promise<VersionRef> {
    const runtime = ctx.params._runtime
    if (runtime.target === "userSystemd") {
      throw new Error("luna-chat-server driver does not support userSystemd runtime")
    }
    const hostExec = (ctx.exec.host ?? ctx.exec.service) as ShellExecutor
    const result = await hostExec.run({
      argv: ["git", "-C", runtime.hostRepoDir, "rev-parse", "HEAD"],
    })
    return result.stdout.trim()
  }

  async resolveTarget(ctx: DriverContext<LunaChatServerParams>, ref?: VersionRef): Promise<ResolvedTarget> {
    const runtime = ctx.params._runtime
    if (runtime.target === "userSystemd") {
      throw new Error("luna-chat-server driver does not support userSystemd runtime")
    }
    const hostExec = (ctx.exec.host ?? ctx.exec.service) as ShellExecutor
    const hostRepoDir = runtime.hostRepoDir

    const previous = await this.currentVersion(ctx)
    const branch = ref ?? ctx.params.ref ?? "origin/master"

    await hostExec.run({ argv: ["git", "-C", hostRepoDir, "fetch", "origin"] })
    const targetResult = await hostExec.run({ argv: ["git", "-C", hostRepoDir, "rev-parse", branch] })
    const targetRef = targetResult.stdout.trim()

    return {
      ref: targetRef,
      previous,
      noop: targetRef === previous,
      revertible: true,
      previousCompatible: true,
    }
  }

  async plan(ctx: DriverContext<LunaChatServerParams>, target: ResolvedTarget): Promise<readonly string[]> {
    const runtime = ctx.params._runtime
    const lines: string[] = [
      `Driver: ${this.kind}`,
      `Profile: ${ctx.params.profile}`,
      `Script: ${this.pinnedScriptPath}`,
      `From: ${target.previous}`,
      `To: ${target.ref}`,
      `Noop: ${target.noop}`,
      `DryRun: ${ctx.dryRun}`,
    ]
    if (runtime.target === "incus") {
      lines.push(`Incus container: ${runtime.container} (derived from runtime)`)
    }
    const flags = this.baseFlags(ctx.params, runtime)
    lines.push(`Flags: ${flags.join(" ")}`)
    return lines
  }

  async apply(ctx: DriverContext<LunaChatServerParams>, target: ResolvedTarget): Promise<ApplyOutcome> {
    if (target.noop) return { status: "noop", at: target.ref }

    const runtime = ctx.params._runtime
    validateExecutionContext(ctx.exec, runtime)
    const hostExec = (ctx.exec.host ?? ctx.exec.service) as ShellExecutor
    const flags = [...this.baseFlags(ctx.params, runtime), "--ref", target.ref]
    if (ctx.dryRun) flags.push("--dry-run")

    const result = await hostExec.exec({
      argv: [this.pinnedScriptPath, ...flags],
    })

    switch (result.code) {
      case 0:
        return { status: "updated", from: target.previous, to: target.ref }
      case 1: {
        // F1 split: distinguish engine auto-rollback from preflight/forward failure.
        // The engine emits "ROLLED BACK to <sha>" (via luna_warn) on successful rollback.
        // Preflight errors start with "error: " (via luna_die) and contain no rollback marker.
        if (result.stderr.includes("ROLLED BACK to")) {
          return {
            status: "rolled-back",
            attempted: target.ref,
            recovered: target.previous,
            cause: "readiness failed; script auto-recovered",
          }
        }
        return {
          status: "failed",
          attempted: target.ref,
          cause: result.stderr.slice(0, 500) || `exit ${result.code}`,
        }
      }
      default:
        return {
          status: "failed",
          attempted: target.ref,
          cause: result.stderr || `exit code ${result.code}`,
        }
    }
  }

  async healthCheck(ctx: DriverContext<LunaChatServerParams>): Promise<HealthReport> {
    const svc = ctx.exec.service as ShellExecutor
    const hz = await svc.exec({ argv: ["curl", "-fsS", "-m", "5", "http://127.0.0.1:4753/healthz"] })
    const rz = await svc.exec({ argv: ["curl", "-fsS", "-m", "5", "http://127.0.0.1:4753/readyz"] })
    const ready = rz.code === 0 && rz.stdout.includes('"mode":"normal"')
    return {
      healthy: hz.code === 0 && (ready || rz.code !== 0),
      checks: [
        { name: "healthz", ok: hz.code === 0 },
        {
          name: "readyz/mode:normal",
          ok: ready,
          ...(rz.code !== 0 ? { detail: "absent (pre-/readyz build)" } : {}),
        },
      ],
    }
  }

  async rollback(ctx: DriverContext<LunaChatServerParams>, previous: VersionRef): Promise<ApplyOutcome> {
    const runtime = ctx.params._runtime
    const hostExec = (ctx.exec.host ?? ctx.exec.service) as ShellExecutor
    // Rollback = forward-apply to the previous sha via --ref <previous>.
    // The engine's own readiness+auto-rollback is the safety net — do NOT pass
    // --no-rollback. Edge case: if `previous` itself is unhealthy, the engine
    // auto-rolls back to the now-current sha.
    const flags = [...this.baseFlags({ ...ctx.params, rollback: true }, runtime), "--ref", previous]
    const result = await hostExec.exec({ argv: [this.pinnedScriptPath, ...flags] })
    return result.code === 0
      ? { status: "rolled-back", attempted: previous, recovered: previous, cause: "manual rollback" }
      : { status: "failed", attempted: previous, cause: result.stderr || `exit code ${result.code}` }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

type OptionalParams = {
  ref?: string
  supervisor?: "systemd" | "launchd"
  rollback?: boolean
  restartSettle?: number
  repinClaude?: boolean
}

function buildOptionals(obj: Record<string, unknown>): OptionalParams {
  const result: OptionalParams = {}
  if (typeof obj["ref"] === "string") result.ref = obj["ref"]
  if (obj["supervisor"] === "systemd" || obj["supervisor"] === "launchd") result.supervisor = obj["supervisor"]
  if (typeof obj["rollback"] === "boolean") result.rollback = obj["rollback"]
  if (typeof obj["restartSettle"] === "number") result.restartSettle = obj["restartSettle"]
  if (typeof obj["repinClaude"] === "boolean") result.repinClaude = obj["repinClaude"]
  return result
}
