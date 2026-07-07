import { defineCommand } from "citty"
import { addAccount } from "../add.js"
import { listAccounts } from "../list.js"
import { removeAccount } from "../rm.js"

const list = defineCommand({
  meta: { name: "list", description: "list accounts" },
  async run() {
    const r = await Promise.resolve(
      listAccounts({}),
    )
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    process.exit(r.exitCode)
  },
})

const add = defineCommand({
  meta: { name: "add", description: "add an account" },
  args: {
    id: { type: "string", description: "account id", required: true },
    label: { type: "string", description: "account label", required: true },
    kind: { type: "string", description: "account kind (anthropic | tool-<n> | mcp-<n>)", required: true },
    "secret-ref": { type: "string", description: "secret reference (op://, luna-op://, env:, claude-code:login)", required: true },
    "db-path": { type: "string", description: "override default ~/.luna/luna.db" },
  },
  async run({ args }) {
    const r = await Promise.resolve(
      addAccount({
        id: String(args.id),
        label: String(args.label),
        kind: String(args.kind),
        secretRef: String(args["secret-ref"]),
        ...(args["db-path"] !== undefined ? { dbPath: String(args["db-path"]) } : {}),
      }),
    )
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    process.exit(r.exitCode)
  },
})

const rm = defineCommand({
  meta: { name: "rm", description: "remove an account" },
  args: {
    id: { type: "string", description: "account id", required: true },
    "db-path": { type: "string", description: "override default ~/.luna/luna.db" },
  },
  async run({ args }) {
    const r = await Promise.resolve(
      removeAccount({
        id: String(args.id),
        ...(args["db-path"] !== undefined ? { dbPath: String(args["db-path"]) } : {}),
      }),
    )
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    process.exit(r.exitCode)
  },
})

export const accountCommand = defineCommand({
  meta: { name: "account", description: "manage Luna accounts" },
  subCommands: { add, list, rm },
})
