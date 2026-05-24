import { homedir } from "node:os"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import type { ServerFrame } from "@luna/ui-ws"
import { parseChatArgs } from "./args.js"
import { loadChatConfig, readLunaDotEnv, redactedConfigSummary } from "./config.js"
import {
  executeLocalCommand,
  makeLocalShellState,
  setLocalShellEnabled,
  type LocalShellState,
} from "./local-shell.js"
import { runRecovery } from "./recovery.js"
import { HELP_TEXT, parseSlashCommand } from "./slash.js"
import { LunaWsClient } from "./ws-client.js"

export type LunaCliIO = {
  stdin: Readable
  stdout: Writable
  stderr: Writable
  env: Record<string, string | undefined>
  cwd: string
  approveLocalCommand?: (command: string) => Promise<boolean>
}

export type LunaCliResult = {
  exitCode: 0 | 1 | 2
}

const DEFAULT_MODEL = "claude-sonnet-4-5"
const DEFAULT_LOCAL_COMMAND_TIMEOUT_MS = 30_000
const MAX_LOCAL_COMMAND_OUTPUT_BYTES = 64 * 1024
const QUIT_DRAIN_MS = 1_000

const USAGE = [
  "Usage: luna chat [options]",
  "",
  "Options:",
  "  --url <ws-url>              UI WebSocket URL",
  "  --token <token>             UI WebSocket bearer token",
  "  --thread <thread-id>        subscribe to an existing thread",
  "  --new                       force creation of a new thread",
  "  --local-shell               enable local shell capability",
  "  --no-local-shell            disable local shell capability",
  "  --start-mode <mode>         recovery mode: local, ssh, or none",
  "  --start-command <command>   recovery command",
  "  --start-ssh <target>        recovery SSH target",
  "  --start-timeout-ms <ms>     recovery timeout",
  "  -h, --help                  show help",
  "",
  HELP_TEXT,
].join("\n")

const write = (stream: Writable, text: string): void => {
  stream.write(text)
}

const writeError = (io: LunaCliIO, message: string): void => {
  write(io.stderr, `error: ${message}\n`)
}

const formatRuntimeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const waitBounded = async (promise: Promise<unknown>, timeoutMs: number): Promise<void> => {
  await Promise.race([promise.then(() => undefined, () => undefined), delay(timeoutMs)])
}

const createThreadWaiter = (): {
  readonly promise: Promise<string>
  readonly resolve: (threadId: string) => void
} => {
  let resolveThread!: (threadId: string) => void
  const promise = new Promise<string>((resolve) => {
    resolveThread = resolve
  })
  return { promise, resolve: resolveThread }
}

const sendLocalShellCapability = (
  client: LunaWsClient,
  threadId: string | null,
  localShell: LocalShellState,
): void => {
  if (threadId === null) return
  client.send({
    type: "local-shell-capability",
    threadId,
    enabled: localShell.enabled,
    clientId: localShell.clientId,
    platform: localShell.platform,
    cwd: localShell.cwd,
  })
}

const connectWithRecovery = async (
  cfg: ReturnType<typeof loadChatConfig>,
  io: LunaCliIO,
): Promise<LunaWsClient> => {
  try {
    return await LunaWsClient.connect({ url: cfg.url, token: cfg.token ?? "" })
  } catch (firstError) {
    if (cfg.startMode === "none") throw firstError

    write(io.stderr, `connection failed; running ${cfg.startMode} recovery\n`)
    const recovery = await runRecovery({
      mode: cfg.startMode,
      command: cfg.startCommand,
      target: cfg.startSsh,
      timeoutMs: cfg.startTimeoutMs,
    })
    if (!recovery.ran || recovery.exitCode !== 0 || recovery.timedOut) {
      const detail = recovery.timedOut
        ? "recovery timed out"
        : `recovery exited ${recovery.exitCode ?? "without status"}`
      throw new Error(detail)
    }

    return await LunaWsClient.connect({ url: cfg.url, token: cfg.token ?? "" })
  }
}

export async function runLunaCli(
  argv: readonly string[],
  io: LunaCliIO,
): Promise<LunaCliResult> {
  const args = parseChatArgs(argv)
  if (args.command === "help") {
    write(io.stdout, `${USAGE}\n`)
    return { exitCode: 0 }
  }
  if (args.command === "unknown") {
    writeError(io, `unknown command: ${args.unknown.join(" ")}`)
    write(io.stderr, `${USAGE}\n`)
    return { exitCode: 2 }
  }
  if (args.unknown.length > 0) {
    for (const unknown of args.unknown) writeError(io, unknown)
    return { exitCode: 2 }
  }

  const cfg = loadChatConfig({
    args,
    env: io.env,
    dotenv: readLunaDotEnv(homedir()),
    homeDir: homedir(),
    cwd: io.cwd,
  })
  if (cfg.validationErrors.length > 0) {
    for (const error of cfg.validationErrors) writeError(io, error)
    write(io.stderr, `${redactedConfigSummary(cfg)}\n`)
    return { exitCode: 2 }
  }

  let client: LunaWsClient
  try {
    client = await connectWithRecovery(cfg, io)
  } catch (error) {
    writeError(io, formatRuntimeError(error))
    return { exitCode: 1 }
  }

  const lineReader = createInterface({
    input: io.stdin,
    crlfDelay: Infinity,
    terminal: false,
  })

  let currentThreadId: string | null = cfg.threadId
  let threadWaiter = createThreadWaiter()
  if (currentThreadId !== null) threadWaiter.resolve(currentThreadId)
  let localShell = makeLocalShellState({ enabled: cfg.localShellInitial, cwd: cfg.cwd })
  let quitting = false
  let fatalErrorMessage: string | null = null
  let pendingAssistant: Promise<void> | null = null
  let resolvePendingAssistant: (() => void) | null = null
  const assistantTextByTurn = new Map<string, string>()

  const markThread = (threadId: string): void => {
    currentThreadId = threadId
    threadWaiter.resolve(threadId)
  }

  const resetThreadWaiter = (): void => {
    currentThreadId = null
    threadWaiter = createThreadWaiter()
  }

  const startPendingAssistant = (): void => {
    pendingAssistant = new Promise<void>((resolve) => {
      resolvePendingAssistant = resolve
    })
  }

  const finishPendingAssistant = (): void => {
    resolvePendingAssistant?.()
    pendingAssistant = null
    resolvePendingAssistant = null
  }

  const renderFrame = async (frame: ServerFrame): Promise<void> => {
    switch (frame.type) {
      case "hello":
      case "event":
      case "drop":
      case "account-list":
      case "artifacts-extracted":
        return
      case "ping":
        client.send({ type: "pong", ts: frame.ts })
        return
      case "bye":
        fatalErrorMessage = frame.reason
        lineReader.close()
        return
      case "thread-created":
        markThread(frame.thread.id)
        client.send({ type: "subscribe", threadId: frame.thread.id })
        sendLocalShellCapability(client, currentThreadId, localShell)
        return
      case "thread-snapshot":
        markThread(frame.threadId)
        sendLocalShellCapability(client, currentThreadId, localShell)
        for (const message of frame.messages) {
          write(io.stdout, `${message.role}: ${message.text}\n`)
        }
        return
      case "user-accepted":
        markThread(frame.threadId)
        return
      case "assistant-delta": {
        const previous = assistantTextByTurn.get(frame.turnId) ?? ""
        const next = frame.text.startsWith(previous) ? frame.text.slice(previous.length) : frame.text
        assistantTextByTurn.set(frame.turnId, frame.text)
        if (previous.length === 0) write(io.stdout, "Luna: ")
        write(io.stdout, next)
        return
      }
      case "assistant-done":
        assistantTextByTurn.delete(frame.turnId)
        write(io.stdout, "\n")
        finishPendingAssistant()
        return
      case "assistant-error":
        if (frame.turnId !== null) assistantTextByTurn.delete(frame.turnId)
        write(io.stderr, `luna: ${frame.error.kind}: ${frame.error.message}\n`)
        finishPendingAssistant()
        return
      case "thread-list":
        for (const thread of frame.threads) {
          write(io.stdout, `${thread.id}\t${thread.title ?? ""}\t${thread.status}\n`)
        }
        return
      case "local-shell-status":
        write(io.stdout, `local shell: ${frame.message}\n`)
        return
      case "local-shell-request": {
        const result = await executeLocalCommand({
          request: frame,
          cwd: cfg.cwd,
          timeoutMs: DEFAULT_LOCAL_COMMAND_TIMEOUT_MS,
          maxOutputBytes: MAX_LOCAL_COMMAND_OUTPUT_BYTES,
          approve: io.approveLocalCommand ?? (async () => false),
        })
        client.send(result)
        return
      }
    }
  }

  const frameLoop = (async (): Promise<void> => {
    try {
      for (;;) {
        await renderFrame(await client.nextFrame())
      }
    } catch (error) {
      if (!quitting) {
        fatalErrorMessage = formatRuntimeError(error)
        lineReader.close()
      }
    }
  })()

  try {
    if (cfg.newThread) {
      client.send({ type: "new-thread", model: io.env["LUNA_MODEL"] ?? DEFAULT_MODEL })
    } else if (currentThreadId !== null) {
      client.send({ type: "subscribe", threadId: currentThreadId })
      sendLocalShellCapability(client, currentThreadId, localShell)
    }

    for await (const rawLine of lineReader) {
      const line = String(rawLine).trimEnd()
      const command = parseSlashCommand(line)

      switch (command.type) {
        case "help":
          write(io.stdout, `${HELP_TEXT}\n`)
          break
        case "threads":
          client.send({ type: "list-threads", limit: 50 })
          break
        case "new-thread":
          resetThreadWaiter()
          client.send({ type: "new-thread", model: io.env["LUNA_MODEL"] ?? DEFAULT_MODEL })
          break
        case "switch-thread":
          markThread(command.threadId)
          client.send({ type: "subscribe", threadId: command.threadId })
          sendLocalShellCapability(client, currentThreadId, localShell)
          break
        case "interrupt": {
          const threadId = await threadWaiter.promise
          client.send({ type: "interrupt", threadId })
          finishPendingAssistant()
          break
        }
        case "quit":
          quitting = true
          if (pendingAssistant !== null) await waitBounded(pendingAssistant, QUIT_DRAIN_MS)
          lineReader.close()
          break
        case "local-shell":
          localShell = setLocalShellEnabled(localShell, command.action === "on")
          write(io.stdout, `local shell: ${localShell.enabled ? "on" : "off"}\n`)
          sendLocalShellCapability(client, currentThreadId, localShell)
          break
        case "local-shell-status":
          write(io.stdout, `local shell: ${localShell.enabled ? "on" : "off"}\n`)
          sendLocalShellCapability(client, currentThreadId, localShell)
          break
        case "error":
          writeError(io, command.message)
          break
        case "message": {
          if (command.text.trim().length === 0) break
          const threadId = await threadWaiter.promise
          client.send({ type: "user-message", threadId, text: command.text })
          startPendingAssistant()
          break
        }
      }

      if (quitting) break
    }

    if (!quitting && pendingAssistant !== null) await waitBounded(pendingAssistant, QUIT_DRAIN_MS)
    quitting = true
    await client.close()
    await frameLoop

    if (fatalErrorMessage !== null) {
      writeError(io, fatalErrorMessage)
      return { exitCode: 1 }
    }
    return { exitCode: 0 }
  } catch (error) {
    quitting = true
    await client.close().catch(() => undefined)
    await frameLoop.catch(() => undefined)
    writeError(io, formatRuntimeError(error))
    return { exitCode: 1 }
  }
}
