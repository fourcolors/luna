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

const createThreadWaiter = (): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} => {
  let resolveThread!: () => void
  const promise = new Promise<void>((resolve) => {
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

  let currentThreadId: string | null = cfg.threadId
  let threadWaiter = createThreadWaiter()
  if (currentThreadId !== null) threadWaiter.resolve()
  // Track whether the active thread came from disk-persisted auto-resume so
  // we can transparently recover from a stale id (server lost the thread
  // across a restart, etc.) without surfacing the error to the user.
  let pendingAutoResumedThreadId: string | null = cfg.threadIdAutoResumed
    ? cfg.threadId
    : null
  const pendingUserMessages: string[] = []
  let localShell = makeLocalShellState({
    enabled: cfg.localShellInitial,
    cwd: cfg.cwd,
    approvalMode: cfg.dangerouslyAutoApproveLocalShell ? "auto" : "prompt",
  })
  let quitting = false
  let fatalErrorMessage: string | null = null
  let pendingAssistantCount = 0
  let pendingAssistantDrain: Promise<void> | null = null
  let resolvePendingAssistantDrain: (() => void) | null = null
  let readyAnnounced = false
  const assistantTextByTurn = new Map<string, string>()
  const localShellTasks = new Set<Promise<void>>()
  const localShellControllers = new Set<AbortController>()
  const localCommandEnv = sanitizeLocalCommandEnv(io.env)

  const announceReady = (): void => {
    if (readyAnnounced) return
    readyAnnounced = true
    const name = cfg.profileName === "stable" ? "Luna" : `Luna ${cfg.profileName}`
    write(io, `${name} ready. Type a message, /help, or /quit.\n`)
  }

  const markThread = (threadId: string): void => {
    currentThreadId = threadId
    threadWaiter.resolve()
    announceReady()
    flushPendingUserMessages()
    // Once we successfully bind a thread (any source), clear the
    // auto-resume tracker — subsequent unknown-thread errors are
    // legit errors, not stale-resume cases.
    pendingAutoResumedThreadId = null
    // Persist for next `luna chat` invocation so the user can resume the
    // same thread without remembering the id. Best-effort — disk failures
    // here must not break the live session.
    try {
      writeLastThread(io.homeDir ?? homedir(), cfg.profileName, threadId)
    } catch {
      // Swallow — persisting last-thread is a UX nicety, not load-bearing.
    }
  }

  const resetThreadWaiter = (): void => {
    currentThreadId = null
    threadWaiter = createThreadWaiter()
  }

  const waitForAssistantDrain = (): Promise<void> => {
    if (pendingAssistantCount === 0) return Promise.resolve()
    if (pendingAssistantDrain === null) {
      pendingAssistantDrain = new Promise<void>((resolve) => {
        resolvePendingAssistantDrain = resolve
      })
    }
    return pendingAssistantDrain
  }

  const trackPendingAssistant = (): void => {
    pendingAssistantCount += 1
  }

  const finishPendingAssistant = (): void => {
    if (pendingAssistantCount > 0) pendingAssistantCount -= 1
    if (pendingAssistantCount === 0) {
      resolvePendingAssistantDrain?.()
      pendingAssistantDrain = null
      resolvePendingAssistantDrain = null
    }
  }

  const sendUserMessage = (threadId: string, text: string): void => {
    client.send({ type: "user-message", threadId, text })
    trackPendingAssistant()
  }

  function flushPendingUserMessages(): void {
    if (currentThreadId === null) return
    while (pendingUserMessages.length > 0) {
      const text = pendingUserMessages.shift()
      if (text !== undefined) sendUserMessage(currentThreadId, text)
    }
  }

  const runLocalShellRequest = (frame: Extract<ServerFrame, { type: "local-shell-request" }>): void => {
    if (!localShell.enabled) {
      client.send(deniedLocalShellResult(frame, "local shell disabled"))
      return
    }
    if (frame.threadId !== currentThreadId) {
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
          write(io, `${message.role}: ${message.text}\n`)
        }
        return
      case "user-accepted":
        markThread(frame.threadId)
        return
      case "assistant-delta": {
        const previous = assistantTextByTurn.get(frame.turnId) ?? ""
        const next = frame.text.startsWith(previous) ? frame.text.slice(previous.length) : frame.text
        assistantTextByTurn.set(frame.turnId, frame.text)
        if (previous.length === 0) write(io, "Luna: ")
        write(io, next)
        return
      }
      case "assistant-done":
        assistantTextByTurn.delete(frame.turnId)
        write(io, "\n")
        finishPendingAssistant()
        return
      case "assistant-error":
        if (frame.turnId !== null) assistantTextByTurn.delete(frame.turnId)
        // Auto-recover from a stale resumed thread: server doesn't know the
        // id we persisted (e.g. chat-server restart wiped in-memory state).
        // Clear the bad persisted id, reset thread state, and create a new
        // one. The user's last message becomes the seed of the fresh thread.
        if (
          frame.error.kind === "unknown-thread" &&
          pendingAutoResumedThreadId !== null &&
          frame.threadId === pendingAutoResumedThreadId
        ) {
          try {
            clearLastThread(io.homeDir ?? homedir(), cfg.profileName)
          } catch {
            // Best-effort cleanup.
          }
          writeErr(io, `luna: resumed thread ${pendingAutoResumedThreadId} no longer exists — starting a new one\n`)
          pendingAutoResumedThreadId = null
          resetThreadWaiter()
          if (frame.turnId !== null) finishPendingAssistant()
          client.send({ type: "new-thread", model: io.env["LUNA_MODEL"] ?? DEFAULT_MODEL })
          return
        }
        writeErr(io, `luna: ${frame.error.kind}: ${frame.error.message}\n`)
        if (frame.turnId !== null) finishPendingAssistant()
        return
      case "thread-list":
        for (const thread of frame.threads) {
          write(io, `${thread.id}\t${thread.title ?? ""}\t${thread.status}\n`)
        }
        return
      case "local-shell-status":
        if (!frame.accepted && localShell.enabled) {
          writeErr(io, `local shell: ${frame.message}\n`)
        }
        return
      case "local-shell-request": {
        runLocalShellRequest(frame)
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
          write(io, `${HELP_TEXT}\n`)
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
          if (currentThreadId !== null) client.send({ type: "interrupt", threadId: currentThreadId })
          finishPendingAssistant()
          break
        }
        case "quit":
          quitting = true
          abortLocalShellTasks()
          if (pendingUserMessages.length > 0) {
            await waitBounded(threadWaiter.promise, THREAD_CREATE_DRAIN_MS)
          }
          await waitBounded(waitForAssistantDrain(), QUIT_DRAIN_MS)
          lineReader.close()
          break
        case "local-shell":
          localShell = setLocalShellEnabled(localShell, command.action === "on")
          if (!localShell.enabled) abortLocalShellTasks()
          write(io, `local shell: ${localShell.enabled ? "on" : "off"}\n`)
          sendLocalShellCapability(client, currentThreadId, localShell)
          break
        case "local-shell-status":
          write(io, `local shell: ${localShell.enabled ? "on" : "off"}\n`)
          sendLocalShellCapability(client, currentThreadId, localShell)
          break
        case "error":
          writeError(io, command.message)
          break
        case "message": {
          if (command.text.trim().length === 0) break
          if (currentThreadId === null) {
            pendingUserMessages.push(command.text)
          } else {
            sendUserMessage(currentThreadId, command.text)
          }
          break
        }
      }

      if (quitting) break
    }

    if (!quitting) await waitBounded(waitForAssistantDrain(), QUIT_DRAIN_MS)
    quitting = true
    abortLocalShellTasks()
    await waitBounded(Promise.allSettled([...localShellTasks]), 100)
    await client.close()
    await frameLoop

    if (fatalErrorMessage !== null) {
      writeError(io, fatalErrorMessage)
      return { exitCode: 1 }
    }
    return { exitCode: 0 }
  } catch (error) {
    quitting = true
    abortLocalShellTasks()
    await client.close().catch(() => undefined)
    await frameLoop.catch(() => undefined)
    writeError(io, formatRuntimeError(error))
    return { exitCode: 1 }
  }
}
