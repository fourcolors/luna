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
  io: LunaCliIO,
): Promise<{ exitCode: 2 }> {
  io.stderr.write("error: luna chat CLI is not implemented yet\n")
  return { exitCode: 2 }
}
