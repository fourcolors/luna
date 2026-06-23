// test/helpers/fake-executor.ts
import type { ShellExecutor, ExecRequest, ExecResult } from "../../src/runtime/executor.js"

export interface FakeExecEntry {
  argv: string[]
  result: ExecResult
}

export class FakeShellExecutor implements ShellExecutor {
  readonly capability = "shell" as const
  readonly describe: string
  readonly locality: "local" | "remote"

  private responses: FakeExecEntry[] = []
  private callLog: Array<{ argv: string[]; stdin?: string }> = []
  private files: Map<string, string> = new Map()
  private existingPaths: Set<string> = new Set()
  private defaultResult: ExecResult = { code: 0, stdout: "", stderr: "", timedOut: false }

  constructor(opts?: { describe?: string; locality?: "local" | "remote" }) {
    this.describe = opts?.describe ?? "fake-shell"
    this.locality = opts?.locality ?? "local"
  }

  /** Configure a response for a specific argv prefix match (last-registered wins). */
  addResponse(argv: string[], result: ExecResult): this {
    this.responses.push({ argv, result })
    return this
  }

  setDefault(result: ExecResult): this {
    this.defaultResult = result
    return this
  }

  addFile(path: string, contents: string): this {
    this.files.set(path, contents)
    return this
  }

  addExistingPath(path: string): this {
    this.existingPaths.add(path)
    return this
  }

  getCallLog(): ReadonlyArray<{ argv: string[]; stdin?: string }> {
    return this.callLog
  }

  getWrittenFiles(): ReadonlyMap<string, string> {
    return this.files
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    this.callLog.push({
      argv: [...req.argv],
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
    })
    // Reverse so the last-registered matching entry wins
    for (const entry of [...this.responses].reverse()) {
      if (entry.argv.every((arg, i) => req.argv[i] === arg)) {
        return entry.result
      }
    }
    return this.defaultResult
  }

  async run(req: ExecRequest): Promise<ExecResult> {
    const result = await this.exec(req)
    if (result.code !== 0) {
      throw new Error(
        `Command failed (exit ${result.code}): ${req.argv.join(" ")}\nstderr: ${result.stderr}`,
      )
    }
    return result
  }

  async pathExists(path: string): Promise<boolean> {
    return this.existingPaths.has(path)
  }

  async writeFile(path: string, contents: string, _opts?: { mode?: number }): Promise<void> {
    this.files.set(path, contents)
  }

  async readFile(path: string): Promise<string | undefined> {
    return this.files.get(path)
  }
}
