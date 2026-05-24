#!/usr/bin/env bun
import { runLunaCli } from "./chat/app.js"

const isMain = (import.meta as { main?: boolean }).main === true

if (isMain) {
  const result = await runLunaCli(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
  })
  process.exit(result.exitCode)
}
