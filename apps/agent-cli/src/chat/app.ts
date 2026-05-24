import type { Readable, Writable } from "node:stream"

export type LunaCliIO = {
  stdin: Readable
  stdout: Writable
  stderr: Writable
  env: NodeJS.ProcessEnv
  cwd: string
}

export async function runLunaCli(
  _argv: readonly string[],
  _io: LunaCliIO,
): Promise<{ exitCode: number }> {
  return { exitCode: 0 }
}
