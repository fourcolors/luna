import { defineCommand } from "citty"
import { runLunaCli } from "../chat/app.js"

export const chatCommand = defineCommand({
  meta: {
    name: "chat",
    description: "Interactive Luna chat session",
  },
  args: {
    profile: { type: "string", description: "named profile from ~/.luna/.env" },
    dev: { type: "boolean", description: "shortcut for --profile dev" },
    url: { type: "string", description: "UI WebSocket URL" },
    "fallback-url": { type: "string", description: "fallback UI WebSocket URL" },
    token: { type: "string", description: "UI WebSocket bearer token" },
    thread: { type: "string", description: "subscribe to an existing thread" },
    new: { type: "boolean", description: "force creation of a new thread" },
    "local-shell": { type: "boolean", description: "enable local shell capability" },
    "no-local-shell": { type: "boolean", description: "disable local shell capability" },
    "dangerously-auto-approve-local-shell": {
      type: "boolean",
      description: "auto-approve local shell requests inside a marked container",
    },
    "start-mode": { type: "string", description: "recovery mode: local, ssh, or none" },
    "start-command": { type: "string", description: "recovery command" },
    "start-ssh": { type: "string", description: "recovery SSH target" },
    "fallback-start-ssh": { type: "string", description: "fallback recovery SSH target" },
    "start-timeout-ms": { type: "string", description: "recovery timeout (ms)" },
    "no-tui": { type: "boolean", description: "use the legacy readline UI instead of the TUI" },
  },
  async run({ args }) {
    const argv: string[] = []
    if (args.profile !== undefined) argv.push("--profile", args.profile)
    if (args.dev === true) argv.push("--dev")
    if (args.url !== undefined) argv.push("--url", args.url)
    if (args["fallback-url"] !== undefined) argv.push("--fallback-url", args["fallback-url"])
    if (args.token !== undefined) argv.push("--token", args.token)
    if (args.thread !== undefined) argv.push("--thread", args.thread)
    if (args.new === true) argv.push("--new")
    if (args["local-shell"] === true) argv.push("--local-shell")
    if (args["no-local-shell"] === true) argv.push("--no-local-shell")
    if (args["dangerously-auto-approve-local-shell"] === true) {
      argv.push("--dangerously-auto-approve-local-shell")
    }
    if (args["start-mode"] !== undefined) argv.push("--start-mode", args["start-mode"])
    if (args["start-command"] !== undefined) argv.push("--start-command", args["start-command"])
    if (args["start-ssh"] !== undefined) argv.push("--start-ssh", args["start-ssh"])
    if (args["fallback-start-ssh"] !== undefined) {
      argv.push("--fallback-start-ssh", args["fallback-start-ssh"])
    }
    if (args["start-timeout-ms"] !== undefined) {
      argv.push("--start-timeout-ms", args["start-timeout-ms"])
    }

    const useTui = args["no-tui"] !== true && process.stdout.isTTY === true

    if (useTui) {
      const { mountTui } = await import("../tui/mount.js")
      const result = await mountTui(argv)
      process.exit(result.exitCode)
    }

    const { approveLocalCommand } = await import("../luna.js") as {
      approveLocalCommand: (command: string) => Promise<boolean>
    }
    const result = await runLunaCli(argv, {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      cwd: process.cwd(),
      approveLocalCommand,
    })
    process.exit(result.exitCode)
  },
})
