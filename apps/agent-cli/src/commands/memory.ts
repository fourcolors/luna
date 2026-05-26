import { defineCommand } from "citty"
import { runMemoryCommand } from "../memory.js"

export const memoryCommand = defineCommand({
  meta: { name: "memory", description: "manage Luna memory store" },
  args: {
    _: { type: "positional", description: "memory subcommand and args", required: false },
  },
  async run({ rawArgs }) {
    const result = await runMemoryCommand(rawArgs, { env: process.env })
    if (result.stdout.length > 0) process.stdout.write(result.stdout)
    if (result.stderr.length > 0) process.stderr.write(result.stderr)
    process.exit(result.exitCode)
  },
})
