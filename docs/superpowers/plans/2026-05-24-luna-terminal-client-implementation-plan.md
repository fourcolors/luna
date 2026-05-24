# Luna Terminal Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `luna chat`, a terminal client for the existing Luna chat server, with config-backed WebSocket auth, recovery startup, and an opt-in local shell bridge.

**Architecture:** Keep Luna runtime ownership on the server: sessions, memory, account routing, and Agent SDK execution stay in `chat-server.ts`/`ChatService`. The terminal client lives in `apps/agent-cli` and speaks the existing `@luna/ui-ws` protocol. Local shell is an MCP tool package wired beside memory/scheduler/observability tools; tool calls are forwarded through a `ui-ws` bridge to the connected CLI, which prompts and executes locally.

**Tech Stack:** Bun, TypeScript, Vitest, `ws@8`, Effect, Anthropic Claude Agent SDK MCP server helpers already wrapped by `@luna/tools`.

---

## Scope Note

The approved design covers one user-facing feature with three dependent surfaces: terminal chat, server recovery, and local shell. Keep them in one implementation plan because local shell is not useful without the terminal client and the terminal toggle is incomplete without the server-side MCP bridge.

One implementation correction is required: the approved `LocalShellCapabilityFrame` has no `threadId`, but the design also requires one active local shell per thread. Add `threadId` to the capability frame so routing is explicit and testable.

## File Map

Create and modify these files only unless a compile error proves another local export needs updating:

- Modify `apps/agent-cli/package.json`: add `luna` bin, `ws` dependency, `@types/ws` dev dependency.
- Create `apps/agent-cli/src/luna.ts`: top-level `luna` CLI entry point.
- Create `apps/agent-cli/src/chat/args.ts`: pure flag parser for `luna chat`.
- Create `apps/agent-cli/src/chat/config.ts`: `.env` parsing, precedence, redacted diagnostics.
- Create `apps/agent-cli/src/chat/slash.ts`: slash command parser.
- Create `apps/agent-cli/src/chat/local-shell.ts`: local shell state, approval execution, timeout, truncation.
- Create `apps/agent-cli/src/chat/recovery.ts`: local and SSH recovery command runner.
- Create `apps/agent-cli/src/chat/ws-client.ts`: typed WebSocket transport wrapper.
- Create `apps/agent-cli/src/chat/app.ts`: terminal chat orchestration.
- Create `apps/agent-cli/test/chat-config.test.ts`.
- Create `apps/agent-cli/test/chat-slash.test.ts`.
- Create `apps/agent-cli/test/local-shell.test.ts`.
- Create `apps/agent-cli/test/recovery.test.ts`.
- Create `apps/agent-cli/test/ws-client.test.ts`.
- Create `apps/agent-cli/test/chat-app.integration.test.ts`.
- Modify `packages/ui-ws/src/protocol.ts`: add local shell protocol frames and capability flags.
- Modify `packages/ui-ws/src/index.ts`: export the local shell bridge.
- Create `packages/ui-ws/src/local-shell-bridge.ts`: server-side registry and request/response bridge.
- Create `packages/ui-ws/test/local-shell-bridge.test.ts`.
- Modify `packages/ui-ws/src/server.ts`: route local shell frames and expose bridge to callers.
- Create `packages/local-shell-tools/package.json`.
- Create `packages/local-shell-tools/src/index.ts`.
- Create `packages/local-shell-tools/src/tools.ts`.
- Create `packages/local-shell-tools/src/layer.ts`.
- Create `packages/local-shell-tools/test/mcp-structure.test.ts`.
- Create `packages/local-shell-tools/test/tools.test.ts`.
- Create `packages/local-shell-tools/vitest.config.ts`.
- Create `packages/local-shell-tools/tsconfig.json`.
- Create `apps/ui-web/scripts/ui-ws-token.ts`: token resolver shared by script tests and chat server.
- Create `apps/ui-web/scripts/__tests__/ui-ws-token.test.ts`.
- Modify `apps/ui-web/package.json`: add the local shell tools workspace package.
- Modify `apps/ui-web/scripts/chat-server.ts`: read token from env and wire local shell tool package.
- Modify `README.md` only if it already has a CLI/setup section in the current worktree; otherwise create `docs/luna-terminal-client.md`.

## Task 1: Agent CLI Package Wiring

**Files:**
- Modify: `apps/agent-cli/package.json`
- Create: `apps/agent-cli/src/luna.ts`
- Test: existing package scripts

- [ ] **Step 1: Add the new bin and dependencies**

Edit `apps/agent-cli/package.json` so the relevant fields are exactly:

```json
{
  "bin": {
    "luna": "./src/luna.ts",
    "luna-account": "./src/index.ts"
  },
  "scripts": {
    "luna": "bun run src/luna.ts",
    "luna-account": "bun run src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@luna/ui-ws": "workspace:*",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@luna/core": "workspace:*",
    "effect": "^3.21.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5",
    "@types/ws": "^8.5.13"
  }
}
```

Keep existing package metadata outside those fields unchanged.

- [ ] **Step 2: Install dependency metadata**

Run:

```bash
cd /root/projects/luna
bun install
```

Expected: exit 0 and `bun.lock` changes only for `@luna/agent-cli` adding `ws`/`@types/ws`, if the lockfile tracks workspace dependency edges.

- [ ] **Step 3: Add a minimal `luna` entry point**

Create `apps/agent-cli/src/luna.ts`:

```ts
#!/usr/bin/env bun
import { runLunaCli } from "./chat/app.js"

const isMain = (import.meta as { main?: boolean }).main === true

if (isMain) {
  const result = await runLunaCli(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
  })
  process.exit(result.exitCode)
}
```

`runLunaCli` will be created in Task 8.

- [ ] **Step 4: Run the package test command and capture the expected failure**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/agent-cli' test
```

Expected: fail because `./chat/app.js` does not exist yet. This confirms the new entry point is included by TypeScript/Bun resolution.

- [ ] **Step 5: Commit**

```bash
cd /root/projects/luna
git add apps/agent-cli/package.json apps/agent-cli/src/luna.ts bun.lock
git commit -m "feat(agent-cli): add luna chat entrypoint"
```

If `bun.lock` did not change, omit it from `git add`.

## Task 2: Chat Config Loader

**Files:**
- Create: `apps/agent-cli/src/chat/args.ts`
- Create: `apps/agent-cli/src/chat/config.ts`
- Create: `apps/agent-cli/test/chat-config.test.ts`

- [ ] **Step 1: Write failing config tests**

Create `apps/agent-cli/test/chat-config.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { parseChatArgs } from "../src/chat/args.js"
import { loadChatConfig, parseDotEnv, redactedConfigSummary } from "../src/chat/config.js"

describe("luna chat config", () => {
  it("parses simple dotenv lines without leaking comments", () => {
    expect(parseDotEnv("A=1\n# ignored\nB = two words\nEMPTY=\n")).toEqual({
      A: "1",
      B: "two words",
      EMPTY: "",
    })
  })

  it("applies precedence flags over env over dotenv over defaults", () => {
    const args = parseChatArgs([
      "chat",
      "--url",
      "ws://flag/ui",
      "--token",
      "flag-token-123456",
      "--local-shell",
      "--start-mode",
      "ssh",
    ])
    const cfg = loadChatConfig({
      args,
      env: {
        LUNA_WS_URL: "ws://env/ui",
        LUNA_UI_WS_TOKEN: "env-token-123456",
        LUNA_START_MODE: "local",
      },
      dotenv: {
        LUNA_WS_URL: "ws://file/ui",
        LUNA_UI_WS_TOKEN: "file-token-123456",
        LUNA_START_TIMEOUT_MS: "45000",
      },
      homeDir: "/tmp/home",
      cwd: "/work",
    })
    expect(cfg.url).toBe("ws://flag/ui")
    expect(cfg.token).toBe("flag-token-123456")
    expect(cfg.startMode).toBe("ssh")
    expect(cfg.startTimeoutMs).toBe(45_000)
    expect(cfg.localShellInitial).toBe(true)
  })

  it("defaults to localhost url, no recovery, and local shell off", () => {
    const cfg = loadChatConfig({
      args: parseChatArgs(["chat"]),
      env: {},
      dotenv: {},
      homeDir: "/tmp/home",
      cwd: "/work",
    })
    expect(cfg.url).toBe("ws://127.0.0.1:4753/ui")
    expect(cfg.startMode).toBe("none")
    expect(cfg.localShellInitial).toBe(false)
    expect(cfg.newThread).toBe(true)
  })

  it("returns a setup error when token is missing", () => {
    const cfg = loadChatConfig({
      args: parseChatArgs(["chat"]),
      env: {},
      dotenv: {},
      homeDir: "/tmp/home",
      cwd: "/work",
    })
    expect(cfg.token).toBeNull()
    expect(cfg.validationErrors).toContain("missing LUNA_UI_WS_TOKEN")
  })

  it("does not print token in diagnostics", () => {
    const cfg = loadChatConfig({
      args: parseChatArgs(["chat", "--token", "secret-token-123456"]),
      env: {},
      dotenv: {},
      homeDir: "/tmp/home",
      cwd: "/work",
    })
    const summary = redactedConfigSummary(cfg)
    expect(summary).toContain("token=present")
    expect(summary).not.toContain("secret-token-123456")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/agent-cli' test -- chat-config.test.ts
```

Expected: fail with module-not-found for `src/chat/args.js`.

- [ ] **Step 3: Implement argument parsing**

Create `apps/agent-cli/src/chat/args.ts`:

```ts
export type StartMode = "local" | "ssh" | "none"

export interface ChatArgs {
  readonly command: "chat" | "help" | "unknown"
  readonly unknown: ReadonlyArray<string>
  readonly url?: string
  readonly token?: string
  readonly threadId?: string
  readonly newThread?: boolean
  readonly localShell?: boolean
  readonly startMode?: StartMode
  readonly startCommand?: string
  readonly startSsh?: string
  readonly startTimeoutMs?: number
}

const readValue = (
  argv: ReadonlyArray<string>,
  index: number,
  flag: string,
): { readonly value: string | undefined; readonly nextIndex: number; readonly error?: string } => {
  const token = argv[index] ?? ""
  const eq = token.indexOf("=")
  if (eq > 0) return { value: token.slice(eq + 1), nextIndex: index }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith("--")) {
    return { value: undefined, nextIndex: index, error: `${flag} requires a value` }
  }
  return { value, nextIndex: index + 1 }
}

export const parseChatArgs = (argv: ReadonlyArray<string>): ChatArgs => {
  const first = argv[0]
  if (first === undefined || first === "-h" || first === "--help") {
    return { command: "help", unknown: [] }
  }
  if (first !== "chat") {
    return { command: "unknown", unknown: [first] }
  }

  const out: {
    command: "chat"
    unknown: string[]
    url?: string
    token?: string
    threadId?: string
    newThread?: boolean
    localShell?: boolean
    startMode?: StartMode
    startCommand?: string
    startSsh?: string
    startTimeoutMs?: number
  } = { command: "chat", unknown: [] }

  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i] as string
    const key = tok.includes("=") ? tok.slice(0, tok.indexOf("=")) : tok
    switch (key) {
      case "--url": {
        const r = readValue(argv, i, "--url")
        if (r.error) out.unknown.push(r.error)
        else out.url = r.value
        i = r.nextIndex
        break
      }
      case "--token": {
        const r = readValue(argv, i, "--token")
        if (r.error) out.unknown.push(r.error)
        else out.token = r.value
        i = r.nextIndex
        break
      }
      case "--thread": {
        const r = readValue(argv, i, "--thread")
        if (r.error) out.unknown.push(r.error)
        else out.threadId = r.value
        i = r.nextIndex
        break
      }
      case "--new":
        out.newThread = true
        break
      case "--local-shell":
        out.localShell = true
        break
      case "--no-local-shell":
        out.localShell = false
        break
      case "--start-mode": {
        const r = readValue(argv, i, "--start-mode")
        if (r.value === "local" || r.value === "ssh" || r.value === "none") out.startMode = r.value
        else out.unknown.push("--start-mode must be local, ssh, or none")
        i = r.nextIndex
        break
      }
      case "--start-command": {
        const r = readValue(argv, i, "--start-command")
        if (r.error) out.unknown.push(r.error)
        else out.startCommand = r.value
        i = r.nextIndex
        break
      }
      case "--start-ssh": {
        const r = readValue(argv, i, "--start-ssh")
        if (r.error) out.unknown.push(r.error)
        else out.startSsh = r.value
        i = r.nextIndex
        break
      }
      case "--start-timeout-ms": {
        const r = readValue(argv, i, "--start-timeout-ms")
        const parsed = Number(r.value)
        if (!Number.isFinite(parsed) || parsed <= 0) out.unknown.push("--start-timeout-ms must be positive")
        else out.startTimeoutMs = Math.floor(parsed)
        i = r.nextIndex
        break
      }
      default:
        out.unknown.push(tok)
    }
  }
  return out
}
```

- [ ] **Step 4: Implement config loading**

Create `apps/agent-cli/src/chat/config.ts`:

```ts
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ChatArgs, StartMode } from "./args.js"

export interface ChatConfig {
  readonly url: string
  readonly token: string | null
  readonly threadId: string | null
  readonly newThread: boolean
  readonly localShellInitial: boolean
  readonly startMode: StartMode
  readonly startCommand: string | null
  readonly startSsh: string | null
  readonly startTimeoutMs: number
  readonly cwd: string
  readonly validationErrors: ReadonlyArray<string>
}

export interface LoadChatConfigInput {
  readonly args: ChatArgs
  readonly env: Record<string, string | undefined>
  readonly dotenv: Record<string, string | undefined>
  readonly homeDir: string
  readonly cwd: string
}

export const parseDotEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
    if (key.length > 0) out[key] = value
  }
  return out
}

export const readLunaDotEnv = (homeDir: string): Record<string, string> => {
  const path = join(homeDir, ".luna", ".env")
  if (!existsSync(path)) return {}
  return parseDotEnv(readFileSync(path, "utf8"))
}

const pick = (
  flagValue: string | undefined,
  envValue: string | undefined,
  dotenvValue: string | undefined,
  fallback: string,
): string => flagValue ?? envValue ?? dotenvValue ?? fallback

const parseStartMode = (value: string): StartMode =>
  value === "local" || value === "ssh" || value === "none" ? value : "none"

export const loadChatConfig = (input: LoadChatConfigInput): ChatConfig => {
  const url = pick(
    input.args.url,
    input.env["LUNA_WS_URL"],
    input.dotenv["LUNA_WS_URL"],
    "ws://127.0.0.1:4753/ui",
  )
  const token =
    input.args.token ??
    input.env["LUNA_UI_WS_TOKEN"] ??
    input.env["UI_WS_TOKEN"] ??
    input.dotenv["LUNA_UI_WS_TOKEN"] ??
    input.dotenv["UI_WS_TOKEN"] ??
    null
  const startMode = parseStartMode(
    pick(input.args.startMode, input.env["LUNA_START_MODE"], input.dotenv["LUNA_START_MODE"], "none"),
  )
  const timeoutRaw = pick(
    input.args.startTimeoutMs?.toString(),
    input.env["LUNA_START_TIMEOUT_MS"],
    input.dotenv["LUNA_START_TIMEOUT_MS"],
    "30000",
  )
  const startTimeoutMs = Math.max(1, Number.parseInt(timeoutRaw, 10) || 30_000)
  const startCommand =
    input.args.startCommand ??
    input.env["LUNA_START_COMMAND"] ??
    input.dotenv["LUNA_START_COMMAND"] ??
    null
  const startSsh =
    input.args.startSsh ??
    input.env["LUNA_START_SSH"] ??
    input.dotenv["LUNA_START_SSH"] ??
    null
  const threadId = input.args.threadId ?? null
  const errors: string[] = []
  if (token === null || token.length === 0) errors.push("missing LUNA_UI_WS_TOKEN")
  if (startMode === "local" && (startCommand === null || startCommand.length === 0)) {
    errors.push("LUNA_START_COMMAND is required when LUNA_START_MODE=local")
  }
  if (startMode === "ssh") {
    if (startCommand === null || startCommand.length === 0) errors.push("LUNA_START_COMMAND is required when LUNA_START_MODE=ssh")
    if (startSsh === null || startSsh.length === 0) errors.push("LUNA_START_SSH is required when LUNA_START_MODE=ssh")
  }
  return {
    url,
    token,
    threadId,
    newThread: input.args.newThread ?? threadId === null,
    localShellInitial: input.args.localShell ?? false,
    startMode,
    startCommand,
    startSsh,
    startTimeoutMs,
    cwd: input.cwd,
    validationErrors: errors,
  }
}

export const redactedConfigSummary = (cfg: ChatConfig): string =>
  [
    `url=${cfg.url}`,
    `token=${cfg.token === null ? "missing" : "present"}`,
    `startMode=${cfg.startMode}`,
    `localShell=${cfg.localShellInitial ? "on" : "off"}`,
  ].join(" ")
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/agent-cli' test -- chat-config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /root/projects/luna
git add apps/agent-cli/src/chat/args.ts apps/agent-cli/src/chat/config.ts apps/agent-cli/test/chat-config.test.ts
git commit -m "feat(agent-cli): load luna chat config"
```

## Task 3: Slash Commands and Local Shell Execution

**Files:**
- Create: `apps/agent-cli/src/chat/slash.ts`
- Create: `apps/agent-cli/src/chat/local-shell.ts`
- Create: `apps/agent-cli/test/chat-slash.test.ts`
- Create: `apps/agent-cli/test/local-shell.test.ts`

- [ ] **Step 1: Write failing slash parser tests**

Create `apps/agent-cli/test/chat-slash.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { parseSlashCommand } from "../src/chat/slash.js"

describe("slash command parser", () => {
  it("parses local shell toggles", () => {
    expect(parseSlashCommand("/local-shell on")).toEqual({ type: "local-shell", enabled: true })
    expect(parseSlashCommand("/local-shell off")).toEqual({ type: "local-shell", enabled: false })
    expect(parseSlashCommand("/local-shell status")).toEqual({ type: "local-shell-status" })
  })

  it("parses thread and lifecycle commands", () => {
    expect(parseSlashCommand("/threads")).toEqual({ type: "threads" })
    expect(parseSlashCommand("/new")).toEqual({ type: "new-thread" })
    expect(parseSlashCommand("/switch thr_123")).toEqual({ type: "switch-thread", threadId: "thr_123" })
    expect(parseSlashCommand("/interrupt")).toEqual({ type: "interrupt" })
    expect(parseSlashCommand("/quit")).toEqual({ type: "quit" })
    expect(parseSlashCommand("/help")).toEqual({ type: "help" })
  })

  it("returns user message for non-slash text", () => {
    expect(parseSlashCommand("hello")).toEqual({ type: "message", text: "hello" })
  })

  it("rejects local shell run syntax in v1", () => {
    expect(parseSlashCommand("/local-shell run pwd")).toEqual({
      type: "error",
      message: "local shell supports only on, off, and status",
    })
  })
})
```

- [ ] **Step 2: Write failing local shell tests**

Create `apps/agent-cli/test/local-shell.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { executeLocalCommand, makeLocalShellState, setLocalShellEnabled, truncateOutput } from "../src/chat/local-shell.js"

describe("local shell state", () => {
  it("starts disabled and toggles on/off", () => {
    let state = makeLocalShellState({ cwd: "/work", initialEnabled: false })
    expect(state.enabled).toBe(false)
    state = setLocalShellEnabled(state, true)
    expect(state.enabled).toBe(true)
    state = setLocalShellEnabled(state, false)
    expect(state.enabled).toBe(false)
  })

  it("truncates long output with an explicit marker", () => {
    expect(truncateOutput("abcdef", 4)).toBe("abcd\n[truncated 2 bytes]")
  })

  it("returns denied result without running the command", async () => {
    const result = await executeLocalCommand({
      requestId: "req_1",
      threadId: "thr_1",
      command: "echo should-not-run",
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxOutputBytes: 1_000,
      approve: async () => false,
    })
    expect(result.approved).toBe(false)
    expect(result.exitCode).toBeNull()
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("denied by user")
  })

  it("captures success stdout", async () => {
    const result = await executeLocalCommand({
      requestId: "req_2",
      threadId: "thr_1",
      command: "printf hello",
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
      approve: async () => true,
    })
    expect(result.approved).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("hello")
    expect(result.stderr).toBe("")
    expect(result.timedOut).toBe(false)
  })

  it("captures non-zero exit code", async () => {
    const result = await executeLocalCommand({
      requestId: "req_3",
      threadId: "thr_1",
      command: "sh -c 'echo bad >&2; exit 7'",
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
      approve: async () => true,
    })
    expect(result.exitCode).toBe(7)
    expect(result.stderr).toContain("bad")
  })

  it("times out and marks result", async () => {
    const result = await executeLocalCommand({
      requestId: "req_4",
      threadId: "thr_1",
      command: "sleep 2",
      cwd: process.cwd(),
      timeoutMs: 100,
      maxOutputBytes: 1_000,
      approve: async () => true,
    })
    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(true)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/agent-cli' test -- chat-slash.test.ts local-shell.test.ts
```

Expected: fail with module-not-found errors.

- [ ] **Step 4: Implement slash parser**

Create `apps/agent-cli/src/chat/slash.ts`:

```ts
export type SlashCommand =
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "help" }
  | { readonly type: "threads" }
  | { readonly type: "new-thread" }
  | { readonly type: "switch-thread"; readonly threadId: string }
  | { readonly type: "interrupt" }
  | { readonly type: "local-shell"; readonly enabled: boolean }
  | { readonly type: "local-shell-status" }
  | { readonly type: "quit" }
  | { readonly type: "error"; readonly message: string }

export const HELP_TEXT = [
  "/help",
  "/threads",
  "/new",
  "/switch <thread-id>",
  "/interrupt",
  "/local-shell on",
  "/local-shell off",
  "/local-shell status",
  "/quit",
].join("\n")

export const parseSlashCommand = (line: string): SlashCommand => {
  const trimmed = line.trim()
  if (!trimmed.startsWith("/")) return { type: "message", text: line }
  const [cmd, ...rest] = trimmed.split(/\s+/)
  switch (cmd) {
    case "/help":
      return { type: "help" }
    case "/threads":
      return { type: "threads" }
    case "/new":
      return { type: "new-thread" }
    case "/switch": {
      const threadId = rest[0]
      return threadId ? { type: "switch-thread", threadId } : { type: "error", message: "/switch requires a thread id" }
    }
    case "/interrupt":
      return { type: "interrupt" }
    case "/quit":
    case "/exit":
      return { type: "quit" }
    case "/local-shell": {
      const action = rest[0]
      if (action === "on" && rest.length === 1) return { type: "local-shell", enabled: true }
      if (action === "off" && rest.length === 1) return { type: "local-shell", enabled: false }
      if (action === "status" && rest.length === 1) return { type: "local-shell-status" }
      return { type: "error", message: "local shell supports only on, off, and status" }
    }
    default:
      return { type: "error", message: `unknown command: ${cmd}` }
  }
}
```

- [ ] **Step 5: Implement local shell execution**

Create `apps/agent-cli/src/chat/local-shell.ts`:

```ts
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { platform } from "node:os"

export interface LocalShellState {
  readonly enabled: boolean
  readonly clientId: string
  readonly platform: string
  readonly cwd: string
}

export interface LocalCommandRequest {
  readonly requestId: string
  readonly threadId: string
  readonly command: string
  readonly cwd?: string
  readonly timeoutMs?: number
}

export interface LocalCommandResult {
  readonly type: "local-shell-result"
  readonly requestId: string
  readonly threadId: string
  readonly approved: boolean
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
}

export interface ExecuteLocalCommandOptions extends LocalCommandRequest {
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly approve: (command: string) => Promise<boolean>
}

export const makeLocalShellState = (input: {
  readonly cwd: string
  readonly initialEnabled: boolean
}): LocalShellState => ({
  enabled: input.initialEnabled,
  clientId: `cli_${randomUUID()}`,
  platform: platform(),
  cwd: input.cwd,
})

export const setLocalShellEnabled = (
  state: LocalShellState,
  enabled: boolean,
): LocalShellState => ({ ...state, enabled })

export const truncateOutput = (text: string, maxBytes: number): string => {
  const buf = Buffer.from(text)
  if (buf.byteLength <= maxBytes) return text
  const sliced = buf.subarray(0, maxBytes).toString("utf8")
  return `${sliced}\n[truncated ${buf.byteLength - maxBytes} bytes]`
}

export const executeLocalCommand = async (
  opts: ExecuteLocalCommandOptions,
): Promise<LocalCommandResult> => {
  const start = Date.now()
  const approved = await opts.approve(opts.command)
  if (!approved) {
    return {
      type: "local-shell-result",
      requestId: opts.requestId,
      threadId: opts.threadId,
      approved: false,
      exitCode: null,
      stdout: "",
      stderr: "denied by user",
      durationMs: Date.now() - start,
      timedOut: false,
    }
  }

  return await new Promise<LocalCommandResult>((resolve) => {
    const child = spawn(opts.command, {
      cwd: opts.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (exitCode: number | null, timedOut: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        type: "local-shell-result",
        requestId: opts.requestId,
        threadId: opts.threadId,
        approved: true,
        exitCode,
        stdout: truncateOutput(stdout, opts.maxOutputBytes),
        stderr: truncateOutput(stderr, opts.maxOutputBytes),
        durationMs: Date.now() - start,
        timedOut,
      })
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL")
      }, 500)
      finish(null, true)
    }, opts.timeoutMs)
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", (err) => {
      stderr += err.message
      finish(null, false)
    })
    child.on("close", (code) => finish(code, false))
  })
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/agent-cli' test -- chat-slash.test.ts local-shell.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /root/projects/luna
git add apps/agent-cli/src/chat/slash.ts apps/agent-cli/src/chat/local-shell.ts apps/agent-cli/test/chat-slash.test.ts apps/agent-cli/test/local-shell.test.ts
git commit -m "feat(agent-cli): add chat commands and local shell executor"
```

## Task 4: WebSocket Client and Recovery

**Files:**
- Create: `apps/agent-cli/src/chat/ws-client.ts`
- Create: `apps/agent-cli/src/chat/recovery.ts`
- Create: `apps/agent-cli/test/ws-client.test.ts`
- Create: `apps/agent-cli/test/recovery.test.ts`

- [ ] **Step 1: Write failing WebSocket client tests**

Create `apps/agent-cli/test/ws-client.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"
import { LunaWsClient } from "../src/chat/ws-client.js"

const servers: WebSocketServer[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

const startServer = async (handler: (raw: string) => void) => {
  const server = new WebSocketServer({ port: 0 })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const address = server.address()
  if (typeof address !== "object" || address === null) throw new Error("no address")
  server.on("connection", (socket, req) => {
    expect(req.headers.authorization).toBe("Bearer token-1234567890")
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 2, kinds: [], capabilities: { chat: true, streamingDeltas: true } }))
    socket.on("message", (raw) => handler(raw.toString()))
  })
  return `ws://127.0.0.1:${address.port}/ui`
}

describe("LunaWsClient", () => {
  it("connects with bearer auth and receives hello", async () => {
    const url = await startServer(() => undefined)
    const client = await LunaWsClient.connect({ url, token: "token-1234567890" })
    const hello = await client.nextFrame()
    expect(hello.type).toBe("hello")
    await client.close()
  })

  it("sends JSON frames", async () => {
    const seen: string[] = []
    const url = await startServer((raw) => seen.push(raw))
    const client = await LunaWsClient.connect({ url, token: "token-1234567890" })
    await client.nextFrame()
    client.send({ type: "list-threads", limit: 5 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(JSON.parse(seen[0] as string)).toEqual({ type: "list-threads", limit: 5 })
    await client.close()
  })
})
```

- [ ] **Step 2: Write failing recovery tests**

Create `apps/agent-cli/test/recovery.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { buildRecoveryCommand, runRecovery } from "../src/chat/recovery.js"

describe("recovery", () => {
  it("builds local command", () => {
    expect(buildRecoveryCommand({ mode: "local", command: "systemctl restart luna", sshTarget: null })).toEqual({
      command: "systemctl restart luna",
      args: [],
      shell: true,
    })
  })

  it("builds ssh command", () => {
    expect(buildRecoveryCommand({ mode: "ssh", command: "systemctl restart luna", sshTarget: "root@jax-box" })).toEqual({
      command: "ssh",
      args: ["root@jax-box", "systemctl restart luna"],
      shell: false,
    })
  })

  it("does nothing for none mode", async () => {
    const result = await runRecovery({
      mode: "none",
      command: null,
      sshTarget: null,
      timeoutMs: 100,
    })
    expect(result.ran).toBe(false)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/agent-cli' test -- ws-client.test.ts recovery.test.ts
```

Expected: fail with module-not-found errors.

- [ ] **Step 4: Implement WebSocket client**

Create `apps/agent-cli/src/chat/ws-client.ts`:

```ts
import WebSocket from "ws"
import type { ClientFrame, ServerFrame } from "@luna/ui-ws"

export class LunaWsClient {
  private readonly pending: ServerFrame[] = []
  private readonly waiters: Array<(frame: ServerFrame) => void> = []

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as ServerFrame
      const waiter = this.waiters.shift()
      if (waiter) waiter(frame)
      else this.pending.push(frame)
    })
  }

  static connect(input: { readonly url: string; readonly token: string }): Promise<LunaWsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(input.url, {
        headers: { Authorization: `Bearer ${input.token}` },
      })
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error(`connection timed out: ${input.url}`))
      }, 10_000)
      ws.once("open", () => {
        clearTimeout(timer)
        resolve(new LunaWsClient(ws))
      })
      ws.once("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
      ws.once("unexpected-response", (_req, res) => {
        clearTimeout(timer)
        reject(new Error(`websocket auth/connect failed: HTTP ${res.statusCode}`))
      })
    })
  }

  send(frame: ClientFrame): void {
    this.ws.send(JSON.stringify(frame))
  }

  nextFrame(): Promise<ServerFrame> {
    const frame = this.pending.shift()
    if (frame) return Promise.resolve(frame)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) {
        resolve()
        return
      }
      this.ws.once("close", () => resolve())
      this.ws.close()
    })
  }
}
```

- [ ] **Step 5: Implement recovery**

Create `apps/agent-cli/src/chat/recovery.ts`:

```ts
import { spawn } from "node:child_process"
import type { StartMode } from "./args.js"

export interface RecoveryInput {
  readonly mode: StartMode
  readonly command: string | null
  readonly sshTarget: string | null
  readonly timeoutMs: number
}

export interface BuiltRecoveryCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly shell: boolean
}

export interface RecoveryResult {
  readonly ran: boolean
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stderr: string
}

export const buildRecoveryCommand = (input: {
  readonly mode: StartMode
  readonly command: string
  readonly sshTarget: string | null
}): BuiltRecoveryCommand => {
  if (input.mode === "ssh") {
    if (!input.sshTarget) throw new Error("ssh recovery requires target")
    return { command: "ssh", args: [input.sshTarget, input.command], shell: false }
  }
  return { command: input.command, args: [], shell: true }
}

export const runRecovery = async (input: RecoveryInput): Promise<RecoveryResult> => {
  if (input.mode === "none" || input.command === null || input.command.length === 0) {
    return { ran: false, exitCode: null, timedOut: false, stderr: "" }
  }
  const built = buildRecoveryCommand({
    mode: input.mode,
    command: input.command,
    sshTarget: input.sshTarget,
  })
  return await new Promise((resolve) => {
    const child = spawn(built.command, built.args, { shell: built.shell, stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    let settled = false
    const finish = (exitCode: number | null, timedOut: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ran: true, exitCode, timedOut, stderr })
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      finish(null, true)
    }, input.timeoutMs)
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", (err) => {
      stderr += err.message
      finish(null, false)
    })
    child.on("close", (code) => finish(code, false))
  })
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/agent-cli' test -- ws-client.test.ts recovery.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /root/projects/luna
git add apps/agent-cli/src/chat/ws-client.ts apps/agent-cli/src/chat/recovery.ts apps/agent-cli/test/ws-client.test.ts apps/agent-cli/test/recovery.test.ts
git commit -m "feat(agent-cli): add websocket client and recovery"
```

## Task 5: Local Shell Protocol and Bridge

**Files:**
- Modify: `packages/ui-ws/src/protocol.ts`
- Modify: `packages/ui-ws/src/index.ts`
- Create: `packages/ui-ws/src/local-shell-bridge.ts`
- Create: `packages/ui-ws/test/local-shell-bridge.test.ts`

- [ ] **Step 1: Write failing bridge tests**

Create `packages/ui-ws/test/local-shell-bridge.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createLocalShellBridge } from "../src/local-shell-bridge.js"

describe("local shell bridge", () => {
  it("registers one client per thread", () => {
    const bridge = createLocalShellBridge()
    const first = bridge.setCapability({
      type: "local-shell-capability",
      threadId: "thr_1",
      enabled: true,
      clientId: "cli_1",
      platform: "darwin",
      cwd: "/work",
    }, () => undefined)
    const second = bridge.setCapability({
      type: "local-shell-capability",
      threadId: "thr_1",
      enabled: true,
      clientId: "cli_2",
      platform: "linux",
      cwd: "/work",
    }, () => undefined)
    expect(first.accepted).toBe(true)
    expect(second.accepted).toBe(false)
    expect(second.message).toContain("already attached")
  })

  it("removes a client when capability is disabled", () => {
    const bridge = createLocalShellBridge()
    bridge.setCapability({
      type: "local-shell-capability",
      threadId: "thr_1",
      enabled: true,
      clientId: "cli_1",
      platform: "darwin",
      cwd: "/work",
    }, () => undefined)
    bridge.setCapability({
      type: "local-shell-capability",
      threadId: "thr_1",
      enabled: false,
      clientId: "cli_1",
      platform: "darwin",
      cwd: "/work",
    }, () => undefined)
    expect(bridge.getCapability("thr_1")).toBeNull()
  })

  it("resolves request when result arrives", async () => {
    const bridge = createLocalShellBridge()
    const sent: unknown[] = []
    bridge.setCapability({
      type: "local-shell-capability",
      threadId: "thr_1",
      enabled: true,
      clientId: "cli_1",
      platform: "darwin",
      cwd: "/work",
    }, (frame) => sent.push(frame))
    const pending = bridge.request({
      threadId: "thr_1",
      command: "pwd",
      timeoutMs: 2_000,
    })
    expect(sent).toHaveLength(1)
    const req = sent[0] as { requestId: string }
    bridge.acceptResult({
      type: "local-shell-result",
      requestId: req.requestId,
      threadId: "thr_1",
      approved: true,
      exitCode: 0,
      stdout: "/work",
      stderr: "",
      durationMs: 3,
      timedOut: false,
    })
    await expect(pending).resolves.toMatchObject({ stdout: "/work", exitCode: 0 })
  })

  it("rejects request when no client is enabled", async () => {
    const bridge = createLocalShellBridge()
    await expect(bridge.request({ threadId: "thr_1", command: "pwd", timeoutMs: 10 })).rejects.toThrow("local shell unavailable")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/ui-ws' test -- local-shell-bridge.test.ts
```

Expected: fail with module-not-found for `src/local-shell-bridge.js`.

- [ ] **Step 3: Extend protocol types**

Modify `packages/ui-ws/src/protocol.ts`:

```ts
export interface HelloFrame {
  readonly type: "hello"
  readonly protocolVersion: typeof UI_WS_PROTOCOL_VERSION
  readonly kinds: ReadonlyArray<string>
  readonly capabilities: {
    readonly chat: boolean
    readonly streamingDeltas: boolean
    readonly localShell: boolean
  }
}

export interface LocalShellRequestFrame {
  readonly type: "local-shell-request"
  readonly requestId: string
  readonly threadId: string
  readonly command: string
  readonly cwd?: string
  readonly timeoutMs?: number
}

export interface LocalShellStatusFrame {
  readonly type: "local-shell-status"
  readonly threadId: string
  readonly enabled: boolean
  readonly accepted: boolean
  readonly message: string
}

export interface LocalShellCapabilityFrame {
  readonly type: "local-shell-capability"
  readonly threadId: string
  readonly enabled: boolean
  readonly clientId: string
  readonly platform: string
  readonly cwd: string
}

export interface LocalShellResultFrame {
  readonly type: "local-shell-result"
  readonly requestId: string
  readonly threadId: string
  readonly approved: boolean
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
}
```

Add `LocalShellRequestFrame` and `LocalShellStatusFrame` to `ServerFrame`. Add `LocalShellCapabilityFrame` and `LocalShellResultFrame` to `ClientFrame`.

Modify `packages/ui-ws/src/index.ts`:

```ts
export * from "./protocol.js"
export * from "./server.js"
export * from "./local-shell-bridge.js"
```

- [ ] **Step 4: Implement bridge**

Create `packages/ui-ws/src/local-shell-bridge.ts`:

```ts
import { randomUUID } from "node:crypto"
import type {
  LocalShellCapabilityFrame,
  LocalShellRequestFrame,
  LocalShellResultFrame,
  LocalShellStatusFrame,
} from "./protocol.js"

export type SendLocalShellFrame = (frame: LocalShellRequestFrame | LocalShellStatusFrame) => void

interface RegisteredClient {
  readonly capability: LocalShellCapabilityFrame
  readonly send: SendLocalShellFrame
}

interface PendingRequest {
  readonly threadId: string
  readonly resolve: (frame: LocalShellResultFrame) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export interface LocalShellBridge {
  readonly setCapability: (frame: LocalShellCapabilityFrame, send: SendLocalShellFrame) => LocalShellStatusFrame
  readonly removeClient: (clientId: string) => void
  readonly getCapability: (threadId: string) => LocalShellCapabilityFrame | null
  readonly request: (input: { readonly threadId: string; readonly command: string; readonly cwd?: string; readonly timeoutMs: number }) => Promise<LocalShellResultFrame>
  readonly acceptResult: (frame: LocalShellResultFrame) => void
}

export const createLocalShellBridge = (): LocalShellBridge => {
  const clients = new Map<string, RegisteredClient>()
  const pending = new Map<string, PendingRequest>()

  const setCapability = (
    frame: LocalShellCapabilityFrame,
    send: SendLocalShellFrame,
  ): LocalShellStatusFrame => {
    const existing = clients.get(frame.threadId)
    if (!frame.enabled) {
      if (existing?.capability.clientId === frame.clientId) clients.delete(frame.threadId)
      return {
        type: "local-shell-status",
        threadId: frame.threadId,
        enabled: false,
        accepted: true,
        message: "local shell disabled",
      }
    }
    if (existing && existing.capability.clientId !== frame.clientId) {
      return {
        type: "local-shell-status",
        threadId: frame.threadId,
        enabled: false,
        accepted: false,
        message: `local shell already attached for ${frame.threadId}`,
      }
    }
    clients.set(frame.threadId, { capability: frame, send })
    return {
      type: "local-shell-status",
      threadId: frame.threadId,
      enabled: true,
      accepted: true,
      message: "local shell enabled",
    }
  }

  const removeClient = (clientId: string): void => {
    for (const [threadId, client] of clients) {
      if (client.capability.clientId === clientId) clients.delete(threadId)
    }
  }

  const getCapability = (threadId: string): LocalShellCapabilityFrame | null =>
    clients.get(threadId)?.capability ?? null

  const request = (input: {
    readonly threadId: string
    readonly command: string
    readonly cwd?: string
    readonly timeoutMs: number
  }): Promise<LocalShellResultFrame> => {
    const client = clients.get(input.threadId)
    if (!client) return Promise.reject(new Error(`local shell unavailable for ${input.threadId}`))
    const requestId = `lsh_${randomUUID()}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`local shell request timed out: ${requestId}`))
      }, input.timeoutMs)
      pending.set(requestId, { threadId: input.threadId, resolve, reject, timer })
      client.send({
        type: "local-shell-request",
        requestId,
        threadId: input.threadId,
        command: input.command,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        timeoutMs: input.timeoutMs,
      })
    })
  }

  const acceptResult = (frame: LocalShellResultFrame): void => {
    const entry = pending.get(frame.requestId)
    if (!entry) return
    if (entry.threadId !== frame.threadId) return
    clearTimeout(entry.timer)
    pending.delete(frame.requestId)
    entry.resolve(frame)
  }

  return { setCapability, removeClient, getCapability, request, acceptResult }
}
```

- [ ] **Step 5: Run bridge tests**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/ui-ws' test -- local-shell-bridge.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /root/projects/luna
git add packages/ui-ws/src/protocol.ts packages/ui-ws/src/index.ts packages/ui-ws/src/local-shell-bridge.ts packages/ui-ws/test/local-shell-bridge.test.ts
git commit -m "feat(ui-ws): add local shell bridge protocol"
```

## Task 6: Local Shell MCP Tool Package

**Files:**
- Create: `packages/local-shell-tools/package.json`
- Create: `packages/local-shell-tools/src/index.ts`
- Create: `packages/local-shell-tools/src/tools.ts`
- Create: `packages/local-shell-tools/src/layer.ts`
- Create: `packages/local-shell-tools/test/mcp-structure.test.ts`
- Create: `packages/local-shell-tools/test/tools.test.ts`
- Create: `packages/local-shell-tools/vitest.config.ts`
- Create: `packages/local-shell-tools/tsconfig.json`

- [ ] **Step 1: Create package metadata**

Create `packages/local-shell-tools/package.json`:

```json
{
  "name": "@luna/local-shell-tools",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@luna/tools": "workspace:*",
    "@luna/ui-ws": "workspace:*",
    "effect": "^3.21.0"
  },
  "peerDependencies": {
    "@anthropic-ai/claude-agent-sdk": ">=0.2.0 <1",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.119",
    "zod": "^4.0.0",
    "vitest": "^2.1.5",
    "typescript": "^5.6.3"
  }
}
```

Create `packages/local-shell-tools/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
  },
})
```

Create `packages/local-shell-tools/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "include": ["src/**/*.ts"],
  "exclude": ["test/**/*.ts", "node_modules"]
}
```

Create `packages/local-shell-tools/src/index.ts`:

```ts
export * from "./layer.js"
export * from "./tools.js"
```

- [ ] **Step 2: Write failing MCP package tests**

Create `packages/local-shell-tools/test/mcp-structure.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { LocalShellToolsLayer, LocalShellToolsService, LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM } from "../src/layer.js"
import { createLocalShellBridge } from "@luna/ui-ws"
import { Effect } from "effect"

describe("LocalShellToolsLayer", () => {
  it("builds an sdk MCP server config", async () => {
    const bridge = createLocalShellBridge()
    const config = await Effect.runPromise(
      Effect.scoped(Effect.gen(function* () {
        return yield* LocalShellToolsService
      })).pipe(Effect.provide(LocalShellToolsLayer({ bridge }))),
    )
    expect(config.serverName).toBe("local_shell")
    expect((config.server as { type?: string }).type).toBe("sdk")
    expect((config.server as { name?: string }).name).toBe("local_shell")
    expect(config.systemPromptAddendum).toBe(LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM)
  })
})
```

Create `packages/local-shell-tools/test/tools.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createLocalShellBridge } from "@luna/ui-ws"
import { makeLocalShellTools } from "../src/tools.js"

describe("local shell MCP tool", () => {
  it("returns unavailable error when no client is attached", async () => {
    const bridge = createLocalShellBridge()
    const [tool] = makeLocalShellTools(bridge, () => "thr_1")
    const result = await (tool as unknown as {
      handler: (args: { command: string; timeout_ms?: number; cwd?: string }, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
    }).handler({ command: "pwd" }, {})
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain("local_shell.run")
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/local-shell-tools' test
```

Expected: fail with module-not-found for package files or package filter before `bun install`.

- [ ] **Step 4: Implement local shell tool**

Create `packages/local-shell-tools/src/tools.ts`:

```ts
import { Effect } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import type { LocalShellBridge } from "@luna/ui-ws"

const runShape = {
  command: z.string().min(1).describe("Shell command to run on the machine where the Luna CLI is connected."),
  cwd: z.string().optional().describe("Working directory for the command. Defaults to the CLI process cwd."),
  timeout_ms: z.number().int().positive().max(120_000).optional().describe("Command timeout in milliseconds. Default 120000."),
  thread_id: z.string().optional().describe("Luna thread id. Omit unless the current thread id is known."),
}

export const makeLocalShellTools = (
  bridge: LocalShellBridge,
  currentThreadId: () => string | null,
) => {
  const run = defineTool({
    name: "local_shell_run",
    description:
      "Request approval to run a shell command on the user's connected Luna CLI machine. " +
      "The CLI always shows the command and requires user approval before execution.",
    inputSchema: runShape,
    handler: (args) =>
      Effect.tryPromise({
        try: async () => {
          const threadId = args.thread_id ?? currentThreadId()
          if (threadId === null) throw new Error("no current Luna thread is bound")
          const result = await bridge.request({
            threadId,
            command: args.command,
            ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
            timeoutMs: args.timeout_ms ?? 120_000,
          })
          return {
            approved: result.approved,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
          } as const
        },
        catch: (cause) =>
          new ToolError({
            tool: "local_shell",
            op: "run",
            cause,
          }),
      }),
  })
  return [run] as const
}
```

- [ ] **Step 5: Implement local shell tool layer**

Create `packages/local-shell-tools/src/layer.ts`:

```ts
import { Effect, Layer } from "effect"
import { makeSdkMcpServer } from "@luna/tools"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import type { LocalShellBridge } from "@luna/ui-ws"
import { makeLocalShellTools } from "./tools.js"

export interface LocalShellToolsConfig {
  readonly serverName: "local_shell"
  readonly server: McpSdkServerConfigWithInstance
  readonly systemPromptAddendum: string
  readonly bindSession: (sessionId: string) => void
  readonly clearSession: (sessionId: string) => void
}

export class LocalShellToolsService extends Effect.Tag("luna/LocalShellToolsService")<
  LocalShellToolsService,
  LocalShellToolsConfig
>() {}

export const LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM =
  "You have one local shell tool (MCP server `local_shell`): " +
  "`local_shell_run(command, cwd?, timeout_ms?, thread_id?)`. " +
  "Use it only when Sterling asks you to inspect or operate on the machine connected by the Luna CLI. " +
  "Every command requires approval in Sterling's terminal before it runs. " +
  "If the tool says local shell is unavailable or denied, continue without command output."

export const buildLocalShellMcpServer = (
  bridge: LocalShellBridge,
  currentThreadId: () => string | null,
): McpSdkServerConfigWithInstance => {
  const tools = makeLocalShellTools(bridge, currentThreadId) as unknown as ReadonlyArray<
    SdkMcpToolDefinition<AnyZodRawShape>
  >
  return makeSdkMcpServer("local_shell", "0.1.0", tools)
}

export const LocalShellToolsLayer = (input: {
  readonly bridge: LocalShellBridge
}): Layer.Layer<LocalShellToolsService> =>
  Layer.scoped(
    LocalShellToolsService,
    Effect.gen(function* () {
      const sessionCell: { value: string | null } = { value: null }
      const currentThreadId = () => sessionCell.value
      const server = buildLocalShellMcpServer(input.bridge, currentThreadId)
      return {
        serverName: "local_shell" as const,
        server,
        systemPromptAddendum: LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM,
        bindSession: (sessionId: string) => {
          sessionCell.value = sessionId
        },
        clearSession: (sessionId: string) => {
          if (sessionCell.value === sessionId) sessionCell.value = null
        },
      }
    }),
  )
```

- [ ] **Step 6: Install workspace metadata and run tests**

Run:

```bash
cd /root/projects/luna
bun install
bun run --filter '@luna/local-shell-tools' test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /root/projects/luna
git add packages/local-shell-tools package.json bun.lock
git commit -m "feat(local-shell): add local shell MCP tool"
```

If root `package.json` did not change because workspaces already include `packages/*`, omit it from `git add`.

## Task 7: Server Token Resolution and Local Shell Wiring

**Files:**
- Create: `apps/ui-web/scripts/ui-ws-token.ts`
- Create: `apps/ui-web/scripts/__tests__/ui-ws-token.test.ts`
- Modify: `apps/ui-web/package.json`
- Modify: `apps/ui-web/scripts/chat-server.ts`
- Modify: `packages/ui-ws/src/server.ts`

- [ ] **Step 1: Write failing token tests**

Create `apps/ui-web/scripts/__tests__/ui-ws-token.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { resolveUiWsToken } from "../ui-ws-token.js"

describe("resolveUiWsToken", () => {
  it("uses UI_WS_TOKEN first", () => {
    expect(resolveUiWsToken({ UI_WS_TOKEN: "a-token-long-enough", LUNA_UI_WS_TOKEN: "other-token-long-enough" })).toBe("a-token-long-enough")
  })

  it("uses LUNA_UI_WS_TOKEN second", () => {
    expect(resolveUiWsToken({ LUNA_UI_WS_TOKEN: "luna-token-long-enough" })).toBe("luna-token-long-enough")
  })

  it("fails closed when missing", () => {
    expect(() => resolveUiWsToken({})).toThrow("UI_WS_TOKEN or LUNA_UI_WS_TOKEN must be set")
  })

  it("fails closed when too short", () => {
    expect(() => resolveUiWsToken({ UI_WS_TOKEN: "short" })).toThrow("at least 16 characters")
  })
})
```

- [ ] **Step 2: Write failing server bridge tests in the existing server test**

Modify `packages/ui-ws/test/server.test.ts`. Add this import:

```ts
import { createLocalShellBridge } from "../src/local-shell-bridge.js"
```

In the existing `"sends hello frame on connect with correct bearer"` test, add:

```ts
expect(frames[0].capabilities.localShell).toBe(false)
```

Add this test inside `describe("UIWebSocketServer", () => { ... })`:

```ts
it("advertises and accepts local shell capability when bridge is configured", async () => {
  rig = await startRig(undefined, {
    localShellBridge: createLocalShellBridge(),
  })
  const ws = new WebSocket(rig.url, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const frames: ServerFrame[] = []
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timeout waiting for local shell status")),
      2000,
    )
    ws.on("error", reject)
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as ServerFrame
      frames.push(frame)
      if (frame.type === "hello") {
        expect(frame.capabilities.localShell).toBe(true)
        ws.send(JSON.stringify({
          type: "local-shell-capability",
          threadId: "thr_1",
          enabled: true,
          clientId: "cli_1",
          platform: "test",
          cwd: "/work",
        }))
      }
      if (frame.type === "local-shell-status") {
        clearTimeout(timer)
        expect(frame).toMatchObject({
          threadId: "thr_1",
          enabled: true,
          accepted: true,
        })
        ws.close()
        resolve()
      }
    })
  })
  expect(frames.map((frame) => frame.type)).toEqual([
    "hello",
    "local-shell-status",
  ])
})
```

- [ ] **Step 3: Implement token helper**

Create `apps/ui-web/scripts/ui-ws-token.ts`:

```ts
export const resolveUiWsToken = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const token = env["UI_WS_TOKEN"] ?? env["LUNA_UI_WS_TOKEN"]
  if (token === undefined || token.length === 0) {
    throw new Error("UI_WS_TOKEN or LUNA_UI_WS_TOKEN must be set")
  }
  if (token.length < 16) {
    throw new Error("UI_WS_TOKEN or LUNA_UI_WS_TOKEN must be at least 16 characters")
  }
  return token
}
```

- [ ] **Step 4: Wire local shell bridge into `startUIWebSocketServer`**

Modify `packages/ui-ws/src/server.ts`:

```ts
import type { LocalShellBridge } from "./local-shell-bridge.js"
```

Add to `UIWebSocketServerConfig`:

```ts
  readonly localShellBridge?: LocalShellBridge
```

In the `hello` frame capabilities, add:

```ts
localShell: config.localShellBridge !== undefined,
```

In the inbound message switch, add:

```ts
case "local-shell-capability": {
  if (!config.localShellBridge) return
  const status = config.localShellBridge.setCapability(frame, (out) => send(ws, out))
  send(ws, status)
  return
}
case "local-shell-result": {
  config.localShellBridge?.acceptResult(frame)
  return
}
```

Change the message handler guard from chat-only to chat-or-local-shell:

```ts
if (chat !== null || config.localShellBridge !== undefined) {
  ws.on("message", (raw) => {
    // existing parse and switch body stays here
  })
}
```

In the connection finalizer, remove any enabled local shell clients for this connection. Track client ids in a `Set<string>` local to the connection:

```ts
const localShellClientIds = new Set<string>()
```

When capability is accepted and enabled:

```ts
if (status.accepted && frame.enabled) localShellClientIds.add(frame.clientId)
if (status.accepted && !frame.enabled) localShellClientIds.delete(frame.clientId)
```

In the finalizer:

```ts
for (const clientId of localShellClientIds) {
  config.localShellBridge?.removeClient(clientId)
}
```

- [ ] **Step 5: Wire token and local shell tools into chat server**

Modify `apps/ui-web/package.json` dev dependencies:

```json
"@luna/local-shell-tools": "workspace:*"
```

Modify `apps/ui-web/scripts/chat-server.ts`:

```ts
import { resolveUiWsToken } from "./ui-ws-token.js"
import { createLocalShellBridge } from "@luna/ui-ws"
import { LocalShellToolsLayer, LocalShellToolsService } from "@luna/local-shell-tools"
```

Replace:

```ts
const TOKEN = "dev-ui-ws-token-do-not-ship"
```

with:

```ts
const TOKEN = resolveUiWsToken()
const localShellBridge = createLocalShellBridge()
```

In `buildServerLayer`, resolve the service:

```ts
const localShellTools = yield* LocalShellToolsService
```

Include it in boot logging:

```ts
localShellTools.serverName,
```

Include it in `mergedSystemPrompt`:

```ts
localShellTools.systemPromptAddendum,
```

Include it in `mergedMcp`:

```ts
[localShellTools.serverName]: localShellTools.server,
```

After thread creation, bind session:

```ts
Effect.tap((summary) => {
  obsTools.bindSession(summary.id)
  localShellTools.bindSession(summary.id)
  console.log("[luna/thread] session bound:", summary.id, "- obs tools and local shell active")
  return Effect.void
})
```

Pass the bridge to `startUIWebSocketServer`:

```ts
localShellBridge,
```

Provide the layer:

```ts
Layer.provide(LocalShellToolsLayer({ bridge: localShellBridge })),
```

Remove or redact the line that prints the token. Replace it with:

```ts
console.log("token: configured")
```

- [ ] **Step 6: Run server/token tests**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/ui-web' test -- ui-ws-token.test.ts
bun run --filter '@luna/ui-ws' test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /root/projects/luna
git add apps/ui-web/package.json apps/ui-web/scripts/ui-ws-token.ts apps/ui-web/scripts/__tests__/ui-ws-token.test.ts apps/ui-web/scripts/chat-server.ts packages/ui-ws/src/server.ts packages/ui-ws/test/server.test.ts
git commit -m "feat(server): wire env token and local shell bridge"
```

## Task 8: Terminal Chat App

**Files:**
- Create: `apps/agent-cli/src/chat/app.ts`
- Create: `apps/agent-cli/test/chat-app.integration.test.ts`
- Modify: `apps/agent-cli/src/luna.ts` if imports need adjustment

- [ ] **Step 1: Write failing integration test**

Create `apps/agent-cli/test/chat-app.integration.test.ts`:

```ts
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"
import { runLunaCli } from "../src/chat/app.js"

const servers: WebSocketServer[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

const startChatServer = async () => {
  const received: unknown[] = []
  const server = new WebSocketServer({ port: 0 })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const address = server.address()
  if (typeof address !== "object" || address === null) throw new Error("no address")
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 2, kinds: [], capabilities: { chat: true, streamingDeltas: true, localShell: true } }))
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString())
      received.push(frame)
      if (frame.type === "new-thread") {
        socket.send(JSON.stringify({ type: "thread-created", thread: { id: "thr_1", title: "Terminal", tags: [], model: "claude-sonnet-4-5", status: "active", createdAt: 1, updatedAt: 1 } }))
        socket.send(JSON.stringify({ type: "thread-snapshot", threadId: "thr_1", throughSeq: -1, messages: [] }))
      }
      if (frame.type === "user-message") {
        socket.send(JSON.stringify({ type: "assistant-delta", threadId: "thr_1", turnId: "turn_1", text: "Hi" }))
        socket.send(JSON.stringify({ type: "assistant-done", threadId: "thr_1", turnId: "turn_1", seq: 1, message: { id: "asst_1", role: "assistant", text: "Hi", ts: 1 } }))
      }
    })
  })
  return { url: `ws://127.0.0.1:${address.port}/ui`, received }
}

describe("luna chat app", () => {
  it("creates a thread, sends one user message, renders assistant output, and quits", async () => {
    const server = await startChatServer()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let output = ""
    stdout.on("data", (chunk) => {
      output += String(chunk)
    })
    const done = runLunaCli(["chat", "--url", server.url], {
      stdin,
      stdout,
      stderr,
      env: { LUNA_UI_WS_TOKEN: "token-1234567890" },
      cwd: process.cwd(),
    })
    stdin.write("hello\n")
    stdin.write("/quit\n")
    stdin.end()
    const result = await done
    expect(result.exitCode).toBe(0)
    expect(server.received.some((f) => (f as { type?: string }).type === "new-thread")).toBe(true)
    expect(server.received.some((f) => (f as { type?: string }).type === "user-message")).toBe(true)
    expect(output).toContain("Hi")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/agent-cli' test -- chat-app.integration.test.ts
```

Expected: fail with module-not-found for `src/chat/app.js`.

- [ ] **Step 3: Implement app orchestration**

Create `apps/agent-cli/src/chat/app.ts`:

```ts
import { homedir } from "node:os"
import { createInterface } from "node:readline/promises"
import type { Readable, Writable } from "node:stream"
import { parseChatArgs } from "./args.js"
import { HELP_TEXT, parseSlashCommand } from "./slash.js"
import { loadChatConfig, readLunaDotEnv, redactedConfigSummary } from "./config.js"
import { runRecovery } from "./recovery.js"
import { LunaWsClient } from "./ws-client.js"
import { executeLocalCommand, makeLocalShellState, setLocalShellEnabled } from "./local-shell.js"

export interface CliIo {
  readonly stdin: Readable
  readonly stdout: Writable
  readonly stderr: Writable
  readonly env: Record<string, string | undefined>
  readonly cwd: string
  readonly approveLocalCommand?: (command: string) => Promise<boolean>
}

export interface CliResult {
  readonly exitCode: 0 | 1 | 2
}

const write = (stream: Writable, text: string): void => {
  stream.write(text)
}

const connectWithRecovery = async (
  cfg: ReturnType<typeof loadChatConfig>,
  io: CliIo,
): Promise<LunaWsClient> => {
  if (cfg.token === null) throw new Error("missing token")
  try {
    return await LunaWsClient.connect({ url: cfg.url, token: cfg.token })
  } catch (firstError) {
    if (cfg.startMode === "none") throw firstError
    write(io.stderr, `luna: connection failed, running ${cfg.startMode} recovery\n`)
    await runRecovery({
      mode: cfg.startMode,
      command: cfg.startCommand,
      sshTarget: cfg.startSsh,
      timeoutMs: cfg.startTimeoutMs,
    })
    return await LunaWsClient.connect({ url: cfg.url, token: cfg.token })
  }
}

export const runLunaCli = async (
  argv: ReadonlyArray<string>,
  io: CliIo,
): Promise<CliResult> => {
  const args = parseChatArgs(argv)
  if (args.command === "help") {
    write(io.stdout, "usage: luna chat [--url <ws-url>] [--thread <id>] [--new] [--local-shell]\n")
    return { exitCode: 0 }
  }
  if (args.command !== "chat" || args.unknown.length > 0) {
    write(io.stderr, `error: ${args.unknown.join(", ") || "unknown command"}\n`)
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
    write(io.stderr, `luna chat config error: ${cfg.validationErrors.join("; ")}\n${redactedConfigSummary(cfg)}\n`)
    return { exitCode: 2 }
  }

  const client = await connectWithRecovery(cfg, io)
  let threadId = cfg.threadId
  let assistantInFlight = false
  let localShell = makeLocalShellState({ cwd: cfg.cwd, initialEnabled: cfg.localShellInitial })

  const sendLocalShellCapability = () => {
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

  const frames = (async () => {
    for (;;) {
      const frame = await client.nextFrame()
      switch (frame.type) {
        case "hello":
          break
        case "thread-created":
          threadId = frame.thread.id
          client.send({ type: "subscribe", threadId })
          sendLocalShellCapability()
          break
        case "thread-snapshot":
          threadId = frame.threadId
          sendLocalShellCapability()
          break
        case "assistant-delta":
          assistantInFlight = true
          write(io.stdout, `\rLuna: ${frame.text}`)
          break
        case "assistant-done":
          assistantInFlight = false
          write(io.stdout, `\n`)
          break
        case "assistant-error":
          assistantInFlight = false
          write(io.stderr, `\nluna: ${frame.error.kind}: ${frame.error.message}\n`)
          break
        case "thread-list":
          for (const thread of frame.threads) write(io.stdout, `${thread.id}\t${thread.title ?? ""}\n`)
          break
        case "local-shell-status":
          write(io.stdout, `local shell: ${frame.message}\n`)
          break
        case "local-shell-request": {
          write(io.stdout, `\nLuna wants to run locally:\n  ${frame.command}\n\nApprove? [y/N] `)
          const result = await executeLocalCommand({
            requestId: frame.requestId,
            threadId: frame.threadId,
            command: frame.command,
            cwd: frame.cwd ?? localShell.cwd,
            timeoutMs: frame.timeoutMs ?? 120_000,
            maxOutputBytes: 64_000,
            approve: io.approveLocalCommand ?? (async () => false),
          })
          client.send(result)
          break
        }
      }
    }
  })()

  if (threadId !== null && !cfg.newThread) {
    client.send({ type: "subscribe", threadId })
  } else {
    client.send({ type: "new-thread", model: io.env["LUNA_MODEL"] ?? "claude-sonnet-4-5", title: "Terminal" })
  }

  const rl = createInterface({ input: io.stdin, output: io.stdout, terminal: false })
  for await (const line of rl) {
    const cmd = parseSlashCommand(line)
    if (cmd.type === "message") {
      if (threadId === null) {
        write(io.stderr, "luna: no thread yet\n")
      } else {
        client.send({ type: "user-message", threadId, text: cmd.text })
      }
      continue
    }
    if (cmd.type === "quit") break
    if (cmd.type === "help") write(io.stdout, `${HELP_TEXT}\n`)
    if (cmd.type === "threads") client.send({ type: "list-threads", limit: 50 })
    if (cmd.type === "new-thread") client.send({ type: "new-thread", model: io.env["LUNA_MODEL"] ?? "claude-sonnet-4-5", title: "Terminal" })
    if (cmd.type === "switch-thread") {
      threadId = cmd.threadId
      client.send({ type: "subscribe", threadId })
      sendLocalShellCapability()
    }
    if (cmd.type === "interrupt" && threadId !== null) client.send({ type: "interrupt", threadId })
    if (cmd.type === "local-shell") {
      localShell = setLocalShellEnabled(localShell, cmd.enabled)
      sendLocalShellCapability()
    }
    if (cmd.type === "local-shell-status") write(io.stdout, `local shell: ${localShell.enabled ? "on" : "off"}\n`)
    if (cmd.type === "error") write(io.stderr, `${cmd.message}\n`)
    if (cmd.type === "interrupt" && !assistantInFlight) write(io.stderr, "luna: no assistant turn in flight\n")
  }

  await client.close()
  void frames.catch(() => undefined)
  return { exitCode: 0 }
}
```

- [ ] **Step 4: Wire real terminal approval**

Modify `apps/agent-cli/src/luna.ts` so direct terminal execution passes an approval function:

```ts
#!/usr/bin/env bun
import { createInterface } from "node:readline/promises"
import { runLunaCli } from "./chat/app.js"

const isMain = (import.meta as { main?: boolean }).main === true

if (isMain) {
  const approvalReader = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })
  const result = await runLunaCli(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    approveLocalCommand: async () => {
      const answer = await approvalReader.question("")
      return answer.trim().toLowerCase() === "y" ||
        answer.trim().toLowerCase() === "yes"
    },
  })
  approvalReader.close()
  process.exit(result.exitCode)
}
```

Keep the default in `app.ts` as deny, so non-interactive test pipes never execute local commands without an injected approval function.

- [ ] **Step 5: Run integration test**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/agent-cli' test -- chat-app.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run all agent-cli tests**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/agent-cli' test
bun run --filter '@luna/agent-cli' typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /root/projects/luna
git add apps/agent-cli/src/chat/app.ts apps/agent-cli/src/luna.ts apps/agent-cli/test/chat-app.integration.test.ts
git commit -m "feat(agent-cli): implement luna terminal chat"
```

## Task 9: Manual Smoke and Docs

**Files:**
- Create: `docs/luna-terminal-client.md` unless a current CLI docs page is a better existing target

- [ ] **Step 1: Add concise operator docs**

Create `docs/luna-terminal-client.md`:

```md
# Luna Terminal Client

`luna chat` connects a terminal to the Luna chat WebSocket server.

Required config:

```env
LUNA_WS_URL=ws://127.0.0.1:4753/ui
LUNA_UI_WS_TOKEN=<same token used by chat-server>
```

Optional recovery config:

```env
LUNA_START_MODE=local|ssh|none
LUNA_START_COMMAND=incus exec agent-lab-1 -- systemctl restart jax-agent-lab.service
LUNA_START_SSH=root@jax-box
LUNA_START_TIMEOUT_MS=30000
```

Common commands:

```bash
luna chat
luna chat --url ws://127.0.0.1:4753/ui
luna chat --thread <thread-id>
luna chat --local-shell
```

In-session commands:

```text
/help
/threads
/new
/switch <thread-id>
/interrupt
/local-shell on
/local-shell off
/local-shell status
/quit
```

Local shell is off by default. When enabled, Luna can request a command on the machine running the CLI, but the CLI asks for approval before execution.
```

- [ ] **Step 2: Run full targeted validation**

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/agent-cli' test
bun run --filter '@luna/agent-cli' typecheck
bun run --filter '@luna/ui-ws' test
bun run --filter '@luna/local-shell-tools' test
bun run --filter '@luna/local-shell-tools' typecheck
bun run --filter '@luna/ui-web' test -- ui-ws-token.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 3: Manual local smoke**

Start server with a non-hardcoded token:

```bash
cd /root/projects/luna
UI_WS_TOKEN="$(openssl rand -hex 24)" bun run --filter '@luna/ui-web' server:chat
```

In a second terminal using the same token:

```bash
cd /root/projects/luna
LUNA_UI_WS_TOKEN="<token-from-shell>" bun run --filter '@luna/agent-cli' luna -- chat
```

Expected:

- The CLI connects and creates a thread.
- A normal message streams a Luna response.
- `/interrupt` sends an interrupt frame when Luna is responding.
- `/local-shell on` returns an accepted local-shell status.
- Asking Luna to inspect the current directory triggers a terminal approval prompt before any command executes.

- [ ] **Step 4: Manual jax-box smoke**

From the machine that should act as client:

```bash
LUNA_WS_URL=ws://127.0.0.1:43111/ui \
LUNA_UI_WS_TOKEN="<deployed-token>" \
LUNA_START_MODE=ssh \
LUNA_START_SSH=root@jax-box \
LUNA_START_COMMAND="incus exec agent-lab-1 -- systemctl restart jax-agent-lab.service" \
bun run --filter '@luna/agent-cli' luna -- chat --local-shell
```

Expected:

- If the server is down, the SSH recovery command runs once and the client reconnects.
- Local shell commands run on the client machine, not automatically inside `agent-lab-1`, unless the CLI itself is running there.

- [ ] **Step 5: Commit docs and any smoke fixes**

```bash
cd /root/projects/luna
git add docs/luna-terminal-client.md
git commit -m "docs: document luna terminal client"
```

If smoke fixes required code changes, commit those files with a message that names the fixed behavior.

## Final Verification

Run:

```bash
cd /root/projects/luna
bun run --filter '@luna/agent-cli' test
bun run --filter '@luna/agent-cli' typecheck
bun run --filter '@luna/ui-ws' test
bun run --filter '@luna/local-shell-tools' test
bun run --filter '@luna/local-shell-tools' typecheck
git diff --check
```

Expected: all commands exit 0 and `git diff --check` prints no errors.

## Self-Review Notes

- Spec coverage:
  - `luna chat`: Tasks 1, 2, 4, 8.
  - WebSocket token config and fail-closed server token: Task 7.
  - Local and Tailscale/SSH connection config: Tasks 2, 4, 9.
  - Recovery command path: Task 4 and Task 9.
  - In-session slash commands: Task 3 and Task 8.
  - Local shell off by default, `--local-shell`, live toggle, per-command approval, timeout, truncation: Tasks 3, 5, 6, 8.
  - One active local shell client per thread: Task 5.
  - Agent-facing tool integration: Tasks 6 and 7.
- Placeholder scan:
  - No `TBD`, `TODO`, "implement later", or unspecified error-handling steps are intentionally present.
- Type consistency:
  - `LocalShellCapabilityFrame` includes `threadId` in all tasks.
  - `local_shell_run` maps to MCP server name `local_shell`.
  - `LunaWsClient` uses `ClientFrame`/`ServerFrame` from `@luna/ui-ws`.
