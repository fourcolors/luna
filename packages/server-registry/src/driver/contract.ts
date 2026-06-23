// packages/server-registry/src/driver/contract.ts
// §6b — ServerUpdateDriver contract
import type { ExecutorCapability, ExecutionContext, RuntimeKind } from "../runtime/executor.js"

export type VersionRef = string

export interface ResolvedTarget {
  readonly ref: VersionRef
  readonly previous: VersionRef
  readonly noop: boolean
  readonly revertible: boolean
  readonly previousCompatible?: boolean
  readonly meta?: Readonly<Record<string, unknown>>
}

export interface HealthReport {
  readonly healthy: boolean
  readonly checks: ReadonlyArray<{ name: string; ok: boolean; detail?: string }>
  readonly version?: VersionRef
}

export type ApplyOutcome =
  | { readonly status: "updated"; readonly from: VersionRef; readonly to: VersionRef }
  | { readonly status: "noop"; readonly at: VersionRef }
  | { readonly status: "rolled-back"; readonly attempted: VersionRef; readonly recovered: VersionRef; readonly cause: string }
  | { readonly status: "failed"; readonly attempted: VersionRef; readonly cause: string }

export interface DriverContext<P = unknown> {
  readonly exec: ExecutionContext
  readonly params: P
  readonly log: (line: string) => void
  readonly dryRun: boolean
}

export interface ServerUpdateDriver<P = unknown> {
  readonly kind: string
  readonly requires: ExecutorCapability
  validateParams(raw: unknown, runtime: RuntimeKind): P
  plan(ctx: DriverContext<P>, target: ResolvedTarget): Promise<readonly string[]>
  currentVersion(ctx: DriverContext<P>): Promise<VersionRef>
  resolveTarget(ctx: DriverContext<P>, ref?: VersionRef): Promise<ResolvedTarget>
  apply(ctx: DriverContext<P>, target: ResolvedTarget): Promise<ApplyOutcome>
  healthCheck(ctx: DriverContext<P>): Promise<HealthReport>
  rollback?(ctx: DriverContext<P>, previous: VersionRef): Promise<ApplyOutcome>
  gate?(ctx: DriverContext<P>): Promise<{ proceed: boolean; reason?: string }>
  provision?(ctx: DriverContext<P>): Promise<void>
  deprovision?(ctx: DriverContext<P>): Promise<void>
}
