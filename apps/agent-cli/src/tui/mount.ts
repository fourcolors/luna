import { homedir } from "node:os"
import { render, useRenderer, useKeyboard } from "@opentui/solid"
import type { CliRenderer } from "@opentui/core"
import { createComponent } from "solid-js"
import { createTuiStore } from "./store.js"
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
  // Register the Bun JSX transform plugin before importing any .tsx files.
  // We use Function() to construct the import call so tsc cannot follow the
  // module specifier to type-check the Bun-only preload source.
  // eslint-disable-next-line no-new-func
  await (Function("m", "return import(m)") as (m: string) => Promise<unknown>)("@opentui/solid/preload")

  // Import App.tsx after preload so the Bun JSX transform is registered first.
  // TypeScript resolves "./App.js" to App.tsx for type-checking purposes.
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

  session.on("threadChange", (id) => store.setThreadId(id))
  session.on("assistantDelta", ({ turnId, text }) => store.upsertAssistant(turnId, text, false))
  session.on("assistantDone", ({ turnId, text }) => store.upsertAssistant(turnId, text, true))
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
    if (trimmed.length === 0) return
    store.setInputDraft("")
    const parsed = parseSlashCommand(trimmed)
    if (parsed.type === "quit") {
      session.beginQuit()
      // Close client so sessionLoop's nextFrame() unblocks, then destroy renderer.
      void client.close().then(() => {
        rendererRef?.destroy()
      })
      return
    }
    if (parsed.type === "message") {
      store.appendUser(trimmed)
    }
    session.dispatchSlash(trimmed)
  }

  // Root Solid component with keyboard handling.
  const RootApp = () => {
    // Stash renderer ref for destroy on quit.
    const renderer = useRenderer()
    rendererRef = renderer

    useKeyboard((evt) => {
      if (evt.ctrl && evt.name === "c") {
        session.beginQuit()
        void client.close().then(() => {
          rendererRef?.destroy()
        })
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
      // Printable ASCII characters.
      if (evt.sequence.length === 1 && evt.sequence.charCodeAt(0) >= 0x20) {
        store.setInputDraft((d) => d + evt.sequence)
      }
    })

    return createComponent(App, { store, onSubmit: submit, onKey: () => {} })
  }

  // Mount TUI — render() resolves immediately after setup.
  await render(() => createComponent(RootApp, {}), {
    onDestroy: resolveDestroyed,
  })

  // Wait until the renderer is destroyed (by /quit, Ctrl-C, or fatal).
  await destroyedPromise

  // Now close client and drain the session loop.
  await client.close().catch(() => undefined)
  await sessionLoop.catch(() => undefined)

  return { exitCode: store.fatalReason() !== null ? 1 : 0 }
}
