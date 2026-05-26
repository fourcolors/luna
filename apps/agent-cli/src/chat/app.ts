import { homedir } from "node:os"
import { posix as pathPosix } from "node:path"
import type { Readable, Writable } from "node:stream"
import type { ServerFrame } from "@luna/ui-ws"
import { createLineReader, writeError, writeOut as write, writeErr } from "../views/readline.js"
import { parseChatArgs } from "./args.js"
import {
  clearLastThread,
  loadChatConfig,
  readLunaDotEnv,
  redactedConfigSummary,
  writeLastThread,
} from "./config.js"
import {
  executeLocalCommand,
  makeLocalShellState,
  sanitizeLocalCommandEnv,
  setLocalShellEnabled,
  type LocalCommandResult,
  type LocalShellState,
} from "./local-shell.js"
import { runRecovery } from "./recovery.js"
import { HELP_TEXT, parseSlashCommand } from "./slash.js"
import { LunaWsClient } from "./ws-client.js"
import { runMemoryCommand } from "../memory.js"
import { LunaHeadlessSession } from "./headless.js"

export type LunaCliIO = {
  stdin: Readable
  stdout: Writable
  stderr: Writable
  env: Record<string, string | undefined>
  homeDir?: string
  cwd: string
  dangerousLocalShellRoot?: string
  approveLocalCommand?: (command: string) => Promise<boolean>
}

export type LunaCliResult = {
  exitCode: 0 | 1 | 2
}

const DEFAULT_MODEL = "claude-sonnet-4-5"
const DEFAULT_LOCAL_COMMAND_TIMEOUT_MS = 30_000
const MAX_LOCAL_COMMAND_OUTPUT_BYTES = 64 * 1024
const QUIT_DRAIN_MS = 1_000
const THREAD_CREATE_DRAIN_MS = 100
const DEFAULT_AUTO_APPROVED_LOCAL_SHELL_ROOT = "/root/luna"

const USAGE = [
  "Usage: luna chat [options]",
  "",
  "Options:",
  "  --profile <name>           use a named profile from ~/.luna/.env",
  "  --dev                      shortcut for --profile dev",
  "  --url <ws-url>              UI WebSocket URL",
  "  --fallback-url <ws-url>     fallback UI WebSocket URL",
  "  --token <token>             UI WebSocket bearer token",
  "  --thread <thread-id>        subscribe to an existing thread",
  "  --new                       force creation of a new thread",
  "  --local-shell               enable local shell capability",
  "  --no-local-shell            disable local shell capability",
  "  --dangerously-auto-approve-local-shell",
  "                              auto-approve local shell requests in a marked container",
  "  --start-mode <mode>         recovery mode: local, ssh, or none",
  "  --start-command <command>   recovery command",
  "  --start-ssh <target>        recovery SSH target",
  "  --fallback-start-ssh <target> fallback recovery SSH target",
  "  --start-timeout-ms <ms>     recovery timeout",
  "  -h, --help                  show help",
  "",
  HELP_TEXT,
].join("\n")

const formatRuntimeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const waitBounded = async (promise: Promise<unknown>, timeoutMs: number): Promise<void> => {
  await Promise.race([promise.then(() => undefined, () => undefined), delay(timeoutMs)])
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
    approvalMode: localShell.approvalMode,
    clientId: localShell.clientId,
    platform: localShell.platform,
    cwd: localShell.cwd,
  })
}

const deniedLocalShellResult = (
  frame: Extract<ServerFrame, { type: "local-shell-request" }>,
  stderr: string,
): LocalCommandResult => ({
  type: "local-shell-result",
  requestId: frame.requestId,
  threadId: frame.threadId,
  approved: false,
  exitCode: null,
  stdout: "",
  stderr,
  durationMs: 0,
  timedOut: false,
})

export const isAutoApprovedLocalShellCwd = (
  cwd: string | undefined,
  root = DEFAULT_AUTO_APPROVED_LOCAL_SHELL_ROOT,
): boolean => {
  if (cwd === undefined) return true
  if (!cwd.startsWith("/") || !root.startsWith("/")) return false

  const normalizedRoot = pathPosix.normalize(root)
  const normalized = pathPosix.normalize(cwd)
  return normalized === normalizedRoot
    || normalized.startsWith(`${normalizedRoot}/`)
}

const connectWithRecovery = async (
  cfg: ReturnType<typeof loadChatConfig>,
  io: LunaCliIO,
): Promise<LunaWsClient> => {
  const connectToConfiguredUrl = async (): Promise<LunaWsClient> => {
    let lastError: unknown
    for (const url of cfg.urls) {
      try {
        return await LunaWsClient.connect({ url, token: cfg.token ?? "" })
      } catch (error) {
        lastError = error
        if (cfg.urls.length > 1) {
          writeErr(io, `connection failed for ${url}: ${formatRuntimeError(error)}\n`)
        }
      }
    }
    throw lastError ?? new Error("WebSocket connection failed")
  }

  try {
    return await connectToConfiguredUrl()
  } catch (firstError) {
    if (cfg.startMode === "none") throw firstError

    const recoveryTargets = cfg.startMode === "ssh"
      ? cfg.startSshTargets
      : [cfg.startSsh]
    let lastRecoveryError: string | null = null
    for (const target of recoveryTargets) {
      const targetLabel = cfg.startMode === "ssh" && target !== null
        ? ` via ${target}`
        : ""
      writeErr(io, `connection failed; running ${cfg.startMode} recovery${targetLabel}\n`)
      const recovery = await runRecovery({
        mode: cfg.startMode,
        command: cfg.startCommand,
        target,
        timeoutMs: cfg.startTimeoutMs,
      })
      if (!recovery.ran || recovery.exitCode !== 0 || recovery.timedOut) {
        lastRecoveryError = recovery.timedOut
          ? "recovery timed out"
          : `recovery exited ${recovery.exitCode ?? "without status"}`
        continue
      }

      try {
        return await connectToConfiguredUrl()
      } catch (error) {
        lastRecoveryError = formatRuntimeError(error)
      }
    }

    throw new Error(lastRecoveryError ?? formatRuntimeError(firstError))
  }
}

export async function runLunaCli(
  argv: readonly string[],
  io: LunaCliIO,
): Promise<LunaCliResult> {
  if (argv[0] === "memory") {
    const result = await runMemoryCommand(argv.slice(1), { env: io.env })
    if (result.stdout.length > 0) write(io, result.stdout)
    if (result.stderr.length > 0) writeErr(io, result.stderr)
    return { exitCode: result.exitCode }
  }

  const args = parseChatArgs(argv)
  if (args.command === "help") {
    write(io, `${USAGE}\n`)
    return { exitCode: 0 }
  }
  if (args.command === "unknown") {
    writeError(io, `unknown command: ${args.unknown.join(" ")}`)
    writeErr(io, `${USAGE}\n`)
    return { exitCode: 2 }
  }
  if (args.unknown.length > 0) {
    for (const unknown of args.unknown) writeError(io, unknown)
    return { exitCode: 2 }
  }

  const homeDir = io.homeDir ?? homedir()
  const cfg = loadChatConfig({
    args,
    env: io.env,
    dotenv: readLunaDotEnv(homeDir),
    homeDir,
    cwd: io.cwd,
    ...(io.dangerousLocalShellRoot !== undefined
      ? { dangerousLocalShellRoot: io.dangerousLocalShellRoot }
      : {}),
  })
  if (cfg.validationErrors.length > 0) {
    for (const error of cfg.validationErrors) writeError(io, error)
    writeErr(io, `${redactedConfigSummary(cfg)}\n`)
    return { exitCode: 2 }
  }

  let client: LunaWsClient
  try {
    client = await connectWithRecovery(cfg, io)
  } catch (error) {
    writeError(io, formatRuntimeError(error))
    return { exitCode: 1 }
  }

  const lineReader = createLineReader(io)

  let localShell = makeLocalShellState({
    enabled: cfg.localShellInitial,
    cwd: cfg.cwd,
    approvalMode: cfg.dangerouslyAutoApproveLocalShell ? "auto" : "prompt",
  })
  let quitting = false
  let fatalErrorMessage: string | null = null
  const localShellTasks = new Set<Promise<void>>()
  const localShellControllers = new Set<AbortController>()
  const localCommandEnv = sanitizeLocalCommandEnv(io.env)

  const session = new LunaHeadlessSession({
    client,
    profileName: cfg.profileName,
    model: io.env["LUNA_MODEL"] ?? DEFAULT_MODEL,
    initialThreadId: cfg.threadId,
    autoResumedThreadId: cfg.threadIdAutoResumed ? cfg.threadId : null,
    newThread: cfg.newThread,
    saveLastThread: (id) => {
      try { writeLastThread(io.homeDir ?? homedir(), cfg.profileName, id) } catch {}
    },
    clearLastThread: () => {
      try { clearLastThread(io.homeDir ?? homedir(), cfg.profileName) } catch {}
    },
  })

  // If the session already has a thread bound (subscribe path), notify server
  // of local-shell capability immediately.
  if (session.threadId !== null) {
    sendLocalShellCapability(client, session.threadId, localShell)
  }

  const runLocalShellRequest = (frame: Extract<ServerFrame, { type: "local-shell-request" }>): void => {
    if (!localShell.enabled) {
      client.send(deniedLocalShellResult(frame, "local shell disabled"))
      return
    }
    if (frame.threadId !== session.threadId) {
      client.send(deniedLocalShellResult(frame, "local shell unavailable for thread"))
      return
    }
    if (cfg.dangerouslyAutoApproveLocalShell && !isAutoApprovedLocalShellCwd(frame.cwd, cfg.dangerousLocalShellRoot)) {
      client.send(deniedLocalShellResult(frame, "local shell cwd outside approved root"))
      return
    }

    const controller = new AbortController()
    localShellControllers.add(controller)
    const task = (async (): Promise<void> => {
      const result = await executeLocalCommand({
        request: frame,
        cwd: cfg.cwd,
        env: localCommandEnv,
        timeoutMs: DEFAULT_LOCAL_COMMAND_TIMEOUT_MS,
        maxOutputBytes: MAX_LOCAL_COMMAND_OUTPUT_BYTES,
        approve: cfg.dangerouslyAutoApproveLocalShell
          ? async () => true
          : io.approveLocalCommand ?? (async () => false),
        signal: controller.signal,
      })
      if (!quitting) client.send(result)
    })()
      .catch((error) => {
        if (!quitting) writeError(io, `local shell failed: ${formatRuntimeError(error)}`)
      })
      .finally(() => {
        localShellControllers.delete(controller)
        localShellTasks.delete(task)
      })
    localShellTasks.add(task)
  }

  const abortLocalShellTasks = (): void => {
    for (const controller of localShellControllers) controller.abort()
  }

  // Drain tracking: count sent user messages not yet resolved by assistant-done/error.
  let pendingTurnCount = 0

  const printedTextByTurn = new Map<string, string>()

  const announceReady = (() => {
    let done = false
    return () => {
      if (done) return
      done = true
      const name = cfg.profileName === "stable" ? "Luna" : `Luna ${cfg.profileName}`
      write(io, `${name} ready. Type a message, /help, or /quit.\n`)
    }
  })()

  const waitForAssistantDrain = async (timeoutMs: number): Promise<void> => {
    const start = Date.now()
    while ((printedTextByTurn.size > 0 || pendingTurnCount > 0) && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  session.on("ready", announceReady)
  session.on("threadChange", (threadId) => {
    announceReady()
    sendLocalShellCapability(client, threadId, localShell)
  })
  session.on("userMessageSent", () => {
    pendingTurnCount += 1
  })
  session.on("assistantDelta", ({ turnId, text }) => {
    const previous = printedTextByTurn.get(turnId) ?? ""
    const next = text.startsWith(previous) ? text.slice(previous.length) : text
    printedTextByTurn.set(turnId, text)
    if (previous.length === 0) write(io, "Luna: ")
    write(io, next)
  })
  session.on("assistantDone", ({ turnId }) => {
    printedTextByTurn.delete(turnId)
    if (pendingTurnCount > 0) pendingTurnCount -= 1
    write(io, "\n")
  })
  session.on("assistantError", ({ message, kind, turnId }) => {
    writeErr(io, `luna: ${kind ?? "error"}: ${message}\n`)
    if (turnId !== null) {
      printedTextByTurn.delete(turnId)
      if (pendingTurnCount > 0) pendingTurnCount -= 1
    }
  })
  session.on("threadList", (threads) => {
    for (const t of threads) write(io, `${t.id}\t${t.title ?? ""}\t${t.status}\n`)
  })
  session.on("localShellStatus", (message, accepted) => {
    if (!accepted) writeErr(io, `local shell: ${message}\n`)
  })
  session.on("localShellRequest", (frame) => runLocalShellRequest(frame))
  session.on("fatal", (reason) => { fatalErrorMessage = reason; lineReader.close() })
  session.on("info", (text) => writeErr(io, `${text}\n`))
  session.on("helpText", () => write(io, `${HELP_TEXT}\n`))

  const sessionLoop = session.run()

  // Track whether a thread is pending (for quit-while-buffering drain).
  let threadBound = session.threadId !== null
  session.on("threadChange", () => { threadBound = true })

  // Promise that resolves when thread is first bound (for quit-while-buffering).
  let resolveThreadBound!: () => void
  const threadBoundPromise = new Promise<void>((resolve) => { resolveThreadBound = resolve })
  if (threadBound) resolveThreadBound()
  session.on("threadChange", resolveThreadBound)

  try {
    for await (const rawLine of lineReader) {
      const line = String(rawLine).trimEnd()
      const command = parseSlashCommand(line)

      // Local-shell toggle still lives in the readline view because it
      // owns the LocalShellState object. Phase 2 moves this into the session.
      if (command.type === "local-shell") {
        localShell = setLocalShellEnabled(localShell, command.action === "on")
        if (!localShell.enabled) abortLocalShellTasks()
        write(io, `local shell: ${localShell.enabled ? "on" : "off"}\n`)
        sendLocalShellCapability(client, session.threadId, localShell)
        continue
      }
      if (command.type === "local-shell-status") {
        write(io, `local shell: ${localShell.enabled ? "on" : "off"}\n`)
        sendLocalShellCapability(client, session.threadId, localShell)
        continue
      }
      if (command.type === "error") {
        writeError(io, command.message)
        continue
      }
      if (command.type === "quit") {
        quitting = true
        abortLocalShellTasks()
        // If there are buffered messages waiting for a thread, wait briefly.
        if (!threadBound) {
          await waitBounded(threadBoundPromise, THREAD_CREATE_DRAIN_MS)
        }
        await waitForAssistantDrain(QUIT_DRAIN_MS)
        session.beginQuit()
        lineReader.close()
        break
      }

      session.dispatchSlash(line)
    }

    if (!quitting) await waitForAssistantDrain(QUIT_DRAIN_MS)
    quitting = true
    abortLocalShellTasks()
    await waitBounded(Promise.allSettled([...localShellTasks]), 100)
    await client.close()
    await sessionLoop

    if (fatalErrorMessage !== null) {
      writeError(io, fatalErrorMessage)
      return { exitCode: 1 }
    }
    return { exitCode: 0 }
  } catch (error) {
    quitting = true
    abortLocalShellTasks()
    await client.close().catch(() => undefined)
    await sessionLoop.catch(() => undefined)
    writeError(io, formatRuntimeError(error))
    return { exitCode: 1 }
  }
}
