#!/usr/bin/env bun
import { defineCommand, runMain } from "citty"
import { createReadStream, createWriteStream, openSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { accountCommand } from "./commands/account/index.js"
import { accountsCommand } from "./commands/accounts.js"
import { chatCommand } from "./commands/chat.js"
import { doctorCommand } from "./commands/doctor.js"
import { memoryCommand } from "./commands/memory.js"
import { pairCommand } from "./commands/pair.js"
import { updateCommand } from "./commands/update.js"

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
    accounts: accountsCommand,
    memory: memoryCommand,
    doctor: doctorCommand,
    pair: pairCommand,
    update: updateCommand,
  },
})

if ((import.meta as { main?: boolean }).main === true) {
  runMain(root)
}
