#!/usr/bin/env bun
/**
 * Luna CLI entry point.
 *
 * This coordinates with the chat-server backend (apps/ui-web/scripts/chat-server.ts)
 * to provide a unified agent client interface.
 */
import { defineCommand, runMain } from "citty"
import { createReadStream, createWriteStream, openSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { accountCommand } from "./commands/account/index.js"
import { chatCommand } from "./commands/chat.js"
import { memoryCommand } from "./commands/memory.js"

export const approveLocalCommand = async (command: string): Promise<boolean> => {
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

const root = defineCommand({
  meta: {
    name: "luna",
    description: "Luna agent client",
  },
  subCommands: {
    chat: chatCommand,
    account: accountCommand,
    memory: memoryCommand,
  },
})

if ((import.meta as { main?: boolean }).main === true) {
  runMain(root)
}
