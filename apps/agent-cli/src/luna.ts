#!/usr/bin/env bun
import { createReadStream, createWriteStream, openSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { runLunaCli } from "./chat/app.js"

const isMain = (import.meta as { main?: boolean }).main === true

const approveLocalCommand = async (command: string): Promise<boolean> => {
  let input: ReturnType<typeof createReadStream> | undefined
  let output: ReturnType<typeof createWriteStream> | undefined
  try {
    input = createReadStream("", { fd: openSync("/dev/tty", "r"), autoClose: true })
    output = createWriteStream("", { fd: openSync("/dev/tty", "w"), autoClose: true })
    const rl = createInterface({ input, output })
    try {
      const answer = await rl.question(`Allow local shell command?\n${command}\n[y/N] `)
      const normalized = answer.trim().toLowerCase()
      return normalized === "y" || normalized === "yes"
    } finally {
      rl.close()
    }
  } catch {
    return false
  } finally {
    input?.destroy()
    output?.end()
  }
}

if (isMain) {
  const result = await runLunaCli(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    approveLocalCommand,
  })
  process.exit(result.exitCode)
}
