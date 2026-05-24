import { spawn } from "node:child_process"
import type { StartMode } from "./args.js"

export interface RecoveryCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly shell: boolean
}

export interface BuildRecoveryCommandInput {
  readonly mode: StartMode
  readonly command: string | null
  readonly target?: string | null
}

export interface RunRecoveryInput extends BuildRecoveryCommandInput {
  readonly timeoutMs: number
}

export interface RecoveryResult {
  readonly ran: boolean
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stderr: string
}

export const buildRecoveryCommand = (
  input: BuildRecoveryCommandInput,
): RecoveryCommand | null => {
  if (input.mode === "none") return null
  if (input.command === null || input.command.length === 0) {
    throw new Error("recovery command is required")
  }
  if (input.mode === "local") {
    return { command: input.command, args: [], shell: true }
  }
  if (input.target === null || input.target === undefined || input.target.length === 0) {
    throw new Error("recovery ssh target is required")
  }
  return { command: "ssh", args: [input.target, input.command], shell: false }
}

export const runRecovery = async (input: RunRecoveryInput): Promise<RecoveryResult> => {
  const recovery = buildRecoveryCommand(input)
  if (recovery === null) {
    return { ran: false, exitCode: null, timedOut: false, stderr: "" }
  }

  return await new Promise<RecoveryResult>((resolve, reject) => {
    let stderr = ""
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let killTimeout: ReturnType<typeof setTimeout> | undefined

    const child = spawn(recovery.command, [...recovery.args], {
      shell: recovery.shell,
      stdio: ["ignore", "ignore", "pipe"],
    })

    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout)
        timeout = undefined
      }
      if (killTimeout !== undefined) {
        clearTimeout(killTimeout)
        killTimeout = undefined
      }
    }

    timeout = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      killTimeout = setTimeout(() => child.kill("SIGKILL"), 500)
    }, input.timeoutMs)

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    child.once("error", (error) => {
      cleanup()
      reject(error)
    })

    child.once("close", (code) => {
      cleanup()
      resolve({
        ran: true,
        exitCode: timedOut ? null : code,
        timedOut,
        stderr,
      })
    })
  })
}
