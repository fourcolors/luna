// packages/server-registry/src/runtime/executor.ts
// §6a — RuntimeExecutor capability-typed split

export type ExecutorCapability = "shell" | "ipc"

export interface ExecRequest {
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly stdin?: string
}

export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export interface ExecutionContext {
  readonly service: RuntimeExecutor
  readonly host?: ShellExecutor
  // invariant: host present ONLY when target=incus; host.locality === service.locality
}

export interface ShellExecutor {
  readonly capability: "shell"
  readonly describe: string
  readonly locality: "local" | "remote"
  exec(req: ExecRequest): Promise<ExecResult>   // never throws on nonzero
  run(req: ExecRequest): Promise<ExecResult>    // throws on nonzero
  pathExists(path: string): Promise<boolean>
  writeFile(path: string, contents: string, opts?: { mode?: number }): Promise<void>
  readFile(path: string): Promise<string | undefined>
}

export interface IpcExecutor {
  readonly capability: "ipc"
  readonly describe: string
  invoke(cmd: string, args?: unknown): Promise<unknown>
}

export type RuntimeExecutor = ShellExecutor | IpcExecutor

/**
 * Invariant: host executor present ONLY when runtime target is "incus";
 * and when present, host.locality === service.locality.
 * Throws on violation so callers catch contract bugs at construction time.
 */
export function validateExecutionContext(ctx: ExecutionContext, runtime: RuntimeKind): void {
  const isIncus = runtime.target === "incus"
  if (ctx.host !== undefined && !isIncus) {
    throw new Error(
      `ExecutionContext invariant violated: 'host' executor is present but runtime target is '${runtime.target}' (host is only valid for incus targets)`,
    )
  }
  if (ctx.host !== undefined && isIncus) {
    const svc = ctx.service as ShellExecutor
    const host = ctx.host as ShellExecutor
    if ("locality" in svc && "locality" in host && svc.locality !== host.locality) {
      throw new Error(
        `ExecutionContext invariant violated: service.locality ('${svc.locality}') !== host.locality ('${host.locality}')`,
      )
    }
  }
}

// RuntimeKind discriminated union — what the loader/factory resolves from registry
export type RuntimeKind =
  | { readonly transport: "local"; readonly target: "bareFolder"; readonly hostRepoDir: string }
  | { readonly transport: "local"; readonly target: "incus"; readonly container: string; readonly hostRepoDir: string; readonly containerRepoDir: string; readonly lunaHome: string }
  | { readonly transport: "ssh"; readonly sshHost: string; readonly target: "bareFolder"; readonly hostRepoDir: string }
  | { readonly transport: "ssh"; readonly sshHost: string; readonly target: "incus"; readonly container: string; readonly hostRepoDir: string; readonly containerRepoDir: string; readonly lunaHome: string }
  | { readonly transport: "local"; readonly target: "userSystemd"; readonly unit: string; readonly uid: number }
