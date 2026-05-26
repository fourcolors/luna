import { homedir } from "node:os"
import { appendFileSync } from "node:fs"
import { render, useRenderer, useKeyboard } from "@opentui/solid"
import type { CliRenderer } from "@opentui/core"
import { createComponent } from "solid-js"
import { createTuiStore } from "./store.js"

const DEBUG_LOG = process.env["LUNA_TUI_DEBUG"]
const dbg = (msg: string): void => {
  if (DEBUG_LOG === undefined) return
  try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`) } catch { /* best-effort */ }
}
import {
  loadChatConfig,
  readLunaDotEnv,
  writeLastThread,
  clearLastThread,
} from "../chat/config.js"
import { connectWithRecovery } from "../chat/app.js"
import { LunaHeadlessSession } from "../chat/headless.js"
import { parseSlashCommand } from "../chat/slash.js"
import {
  executeLocalCommand,
  makeLocalShellState,
  sanitizeLocalCommandEnv,
} from "../chat/local-shell.js"
import { parseChatArgs } from "../chat/args.js"

const DEFAULT_MODEL = "claude-sonnet-4-5"

const USAGE = [
  "Usage: luna chat [options]",
  "",
  "Options:",
  "  --profile <name>    use a named profile",
  "  --dev               shortcut for --profile dev",
  "  --thread <id>       resume a thread",
  "  --new               start a new thread",
  "  --no-tui            use the legacy readline UI",
  "  -h, --help          show help",
].join("\n")

export type TuiMountResult = { exitCode: 0 | 1 | 2 }

export const mountTui = async (argv: readonly string[]): Promise<TuiMountResult> => {
  dbg(`mountTui start argv=${JSON.stringify(argv)} LUNA_TUI_DEBUG=${DEBUG_LOG ?? "<unset>"}`)
  // The OpenTUI Solid preload (which both installs the Bun JSX transform and
  // swaps solid-js's server build for the reactive client build) is registered
  // at the top of luna.ts. By the time we get here, the plugin is active and
  // any subsequent .tsx import + solid-js read uses the reactive build.
  const { App } = await import("./App.js")

  const args = parseChatArgs(argv)
  if (args.command === "help") {
    process.stdout.write(USAGE + "\n")
    return { exitCode: 0 }
  }
  if (args.command === "unknown" || args.unknown.length > 0) {
    process.stderr.write("error: unknown args\n")
    return { exitCode: 2 }
  }

  const home = homedir()
  const cfg = loadChatConfig({
    args,
    env: process.env,
    dotenv: readLunaDotEnv(home),
    homeDir: home,
    cwd: process.cwd(),
  })
  if (cfg.validationErrors.length > 0) {
    for (const err of cfg.validationErrors) process.stderr.write(`error: ${err}\n`)
    return { exitCode: 2 }
  }

  // Pre-TUI: connect and recover. If this fails, exit before mounting alt-screen.
  let client: Awaited<ReturnType<typeof connectWithRecovery>>
  try {
    client = await connectWithRecovery(cfg, {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      cwd: process.cwd(),
    })
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    return { exitCode: 1 }
  }

  // Promise that resolves when the renderer is destroyed (= TUI teardown complete).
  let resolveDestroyed!: () => void
  const destroyedPromise = new Promise<void>((resolve) => {
    resolveDestroyed = resolve
  })

  // Stash renderer reference so we can call .destroy() on quit.
  let rendererRef: CliRenderer | null = null

  // Now mount the TUI.
  const store = createTuiStore()
  store.setProfileName(cfg.profileName)
  store.setLocalShellEnabled(cfg.localShellInitial)
  if (cfg.threadId !== null) store.setThreadId(cfg.threadId)
  store.setConnection("up")

  const session = new LunaHeadlessSession({
    client,
    profileName: cfg.profileName,
    model: process.env["LUNA_MODEL"] ?? DEFAULT_MODEL,
    initialThreadId: cfg.threadId,
    autoResumedThreadId: cfg.threadIdAutoResumed ? cfg.threadId : null,
    newThread: cfg.newThread,
    saveLastThread: (id) => {
      try { writeLastThread(home, cfg.profileName, id) } catch { /* best-effort */ }
    },
    clearLastThread: () => {
      try { clearLastThread(home, cfg.profileName) } catch { /* best-effort */ }
    },
  })

  session.on("threadChange", (id) => { dbg(`evt threadChange: ${id}`); store.setThreadId(id) })
  session.on("assistantDelta", ({ turnId, text }) => {
    dbg(`evt assistantDelta turn=${turnId} text-len=${text.length}`)
    store.upsertAssistant(turnId, text, false)
  })
  session.on("assistantDone", ({ turnId, text }) => {
    dbg(`evt assistantDone turn=${turnId}`)
    store.upsertAssistant(turnId, text, true)
    dbg(`after upsert, messages count = ${store.messages().length}, last = ${JSON.stringify(store.messages()[store.messages().length - 1])}`)
  })
  session.on("assistantError", ({ message, kind, silent }) => {
    if (silent === true) return
    store.setMessages((m) => [...m, { role: "assistant", text: `[${kind ?? "error"}] ${message}` }])
  })
  session.on("fatal", (reason) => {
    store.setFatalReason(reason)
    store.setConnection("fatal")
    // On fatal, destroy renderer to unblock the await below.
    rendererRef?.destroy()
  })
  session.on("localShellStatus", (msg, accepted) => {
    if (!accepted) store.setMessages((m) => [...m, { role: "assistant", text: `local shell: ${msg}` }])
  })

  // Local-shell request handler.
  const { approveLocalCommand } = await import("../luna.js") as {
    approveLocalCommand: (command: string) => Promise<boolean>
  }
  let localShell = makeLocalShellState({
    enabled: cfg.localShellInitial,
    cwd: cfg.cwd,
    approvalMode: cfg.dangerouslyAutoApproveLocalShell ? "auto" : "prompt",
  })
  const localCommandEnv = sanitizeLocalCommandEnv(process.env)

  session.on("localShellRequest", (frame) => {
    if (!localShell.enabled) {
      client.send({
        type: "local-shell-result",
        requestId: frame.requestId,
        threadId: frame.threadId,
        approved: false,
        exitCode: null,
        stdout: "",
        stderr: "local shell disabled",
        durationMs: 0,
        timedOut: false,
      })
      return
    }
    void (async () => {
      const result = await executeLocalCommand({
        request: frame,
        cwd: cfg.cwd,
        env: localCommandEnv,
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
        approve: cfg.dangerouslyAutoApproveLocalShell ? async () => true : approveLocalCommand,
        signal: new AbortController().signal,
      })
      client.send(result)
    })()
  })

  const sessionLoop = session.run()

  // Submit handler: parse slash commands and dispatch.
  const submit = (text: string) => {
    const trimmed = text.trim()
    dbg(`submit: ${JSON.stringify(trimmed)}`)
    if (trimmed.length === 0) return
    store.setInputDraft("")
    const parsed = parseSlashCommand(trimmed)
    dbg(`submit parsed: ${parsed.type}`)
    if (parsed.type === "quit") {
      session.beginQuit()
      void client.close().then(() => {
        rendererRef?.destroy()
      })
      return
    }
    if (parsed.type === "message") {
      store.appendUser(trimmed)
      dbg(`appendUser done, messages count = ${store.messages().length}`)
    }
    session.dispatchSlash(trimmed)
    dbg(`dispatchSlash done`)
  }

  // Root Solid component with keyboard handling.
  type KeyPressEvent = {
    readonly name?: string
    readonly ctrl?: boolean
    readonly sequence?: string
  }

  const handleKey = (evt: KeyPressEvent): void => {
    dbg(`key: name=${evt.name ?? ""} ctrl=${evt.ctrl ?? false} seq=${JSON.stringify(evt.sequence ?? "")}`)
    if (evt.ctrl === true && evt.name === "c") {
      session.beginQuit()
      void client.close().then(() => { rendererRef?.destroy() })
      return
    }
    if (evt.name === "tab") {
      store.cycleContextPanelTab()
      return
    }
    if (evt.ctrl === true && evt.name === "1") {
      store.setContextPanelTab("memories")
      return
    }
    if (evt.ctrl === true && evt.name === "2") {
      store.setContextPanelTab("events")
      return
    }
    if (evt.ctrl === true && evt.name === "3") {
      store.setContextPanelTab("artifacts")
      return
    }
    if (evt.name === "return") {
      submit(store.inputDraft())
      return
    }
    if (evt.name === "backspace") {
      store.setInputDraft((d) => d.slice(0, -1))
      return
    }
    if (evt.sequence !== undefined && evt.sequence.length === 1 && evt.sequence.charCodeAt(0) >= 0x20) {
      const seq = evt.sequence
      store.setInputDraft((d) => d + seq)
      dbg(`inputDraft now = ${JSON.stringify(store.inputDraft())}`)
    }
  }

  const RootApp = () => {
    // Stash renderer ref for destroy on quit.
    const renderer = useRenderer()
    rendererRef = renderer
    dbg(`RootApp setup, renderer keyInput=${renderer?.keyInput !== undefined ? "present" : "MISSING"}`)

    // Direct keyInput registration (bypassing useKeyboard, which relies on
    // onMount and doesn't fire for pass-through components that return
    // createComponent(...) instead of JSX).
    if (renderer?.keyInput !== undefined) {
      renderer.keyInput.on("keypress", handleKey)
    }

    return createComponent(App, { store, onSubmit: submit, onKey: () => {} })
  }

  // Mount TUI — render() resolves immediately after setup.
  // useThread: false to avoid the Zig threaded stdin reader; we want the
  // Node.js event-loop reader so all stdin bytes reach the JS layer reliably.
  await render(() => createComponent(RootApp, {}), {
    useThread: false,
    onDestroy: resolveDestroyed,
  })

  // Wait until the renderer is destroyed (by /quit, Ctrl-C, or fatal).
  await destroyedPromise

  // Now close client and drain the session loop.
  await client.close().catch(() => undefined)
  await sessionLoop.catch(() => undefined)

  return { exitCode: store.fatalReason() !== null ? 1 : 0 }
}
