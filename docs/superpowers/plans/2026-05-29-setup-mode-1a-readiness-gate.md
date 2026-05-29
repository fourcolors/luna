# Setup-Mode #1a — Readiness Gate + Boot Branch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Luna chat-server decide **setup-mode vs normal-mode at boot** from a credential-readiness probe, and in setup-mode serve a token-gated minimal endpoint that advertises a `setup` capability (chat disabled) — replacing today's "zero accounts → hard-exit" guard. (The embedded `claude` terminal + install UI are **#1b**; this foundation just lands the gate + the minimal setup-mode serving.)

**Architecture:** A pure `decideMode(readiness)` + a `probeCredentialReadiness()` (reads the `accounts` table via `bun:sqlite`; for a `claude-code:login` account runs `claude auth status --json`; `env:`/`op://` accounts are treated as ready in v1 — deep-resolve is the installer-spec `luna doctor` concern). `bootstrap()` computes the mode before building layers: **normal** → today's full path; **setup** → a minimal WS-only layer (`chatService: null`) advertising `capabilities.setup = true`. Restart re-decides (the existing SIGTERM→`process.exit(0)`→`Restart=always` path; #1b adds login-triggered/lapse-triggered restarts).

**Tech Stack:** bun + `bun:sqlite`, Effect/ManagedRuntime, vitest, the existing `@luna/ui-ws` server + `chat-server.ts` boot.

**Spec:** `docs/superpowers/specs/2026-05-29-server-setup-mode-onboarding-design.md` (§4.A/B, §9.1–9.2). Depends on PR 0 (merged).

---

## Scope boundary
- **No** embedded terminal, pty, xterm, or install-UI rendering — that's #1b.
- **No** lapse-detection-at-runtime, login flow, or account seeding — #1b.
- This PR's observable behavior: boot with **no account or `loggedIn:false`** → server stays up, WS advertises `{setup:true, chat:false}`, no crash; boot with a usable credential → normal (`{chat:true, setup:false}`).

## File structure
- **Create** `apps/ui-web/scripts/credential-readiness.ts` — `probeCredentialReadiness()` + `decideMode()` (one responsibility: decide the boot mode).
- **Create** `apps/ui-web/scripts/__tests__/credential-readiness.test.ts`.
- **Modify** `packages/ui-ws/src/protocol.ts` — add `setup` to `HelloFrame.capabilities`.
- **Modify** `packages/ui-ws/src/server.ts` — accept + advertise `setup`.
- **Modify** `packages/ui-shared/src/wire.ts` + `reducer.ts` — shadow `setup` capability.
- **Modify** `apps/ui-web/scripts/chat-server.ts` — `bootstrap()` mode branch; replace the `accounts.length === 0` hard-exit.
- **Create** `apps/ui-web/scripts/smoke/setup-mode-boot.smoke.ts` — boot smoke for both modes (mirrors the existing `*-boot.smoke.ts` ManagedRuntime real-layer smokes).

---

### Task 1: Add the `setup` capability (protocol + server + ui-shared shadow)

**Files:**
- Modify: `packages/ui-ws/src/protocol.ts` (HelloFrame.capabilities, ~lines 35–39)
- Modify: `packages/ui-ws/src/server.ts` (hello send, ~lines 393–400)
- Modify: `packages/ui-shared/src/wire.ts` (~lines 96–99) and `packages/ui-shared/src/reducer.ts` (line 50 + line 76)
- Test: `packages/ui-ws/test/` (structural — assert the hello frame carries `setup`)

- [ ] **Step 1: Write the failing test**

Create `packages/ui-ws/test/setup-capability.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import type { HelloFrame } from "../src/protocol.js"

describe("HelloFrame setup capability", () => {
  it("HelloFrame.capabilities includes a boolean `setup`", () => {
    // Type-level + runtime shape check: a valid hello must carry setup.
    const hello: HelloFrame = {
      type: "hello",
      protocolVersion: 2,
      kinds: [],
      capabilities: { chat: false, streamingDeltas: false, localShell: false, setup: true },
    }
    expect(hello.capabilities.setup).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test packages/ui-ws/test/setup-capability.test.ts`
Expected: FAIL — `setup` is not assignable (TS error / property missing) because `HelloFrame.capabilities` has no `setup`.

- [ ] **Step 3: Add `setup` to the protocol type**

In `packages/ui-ws/src/protocol.ts`, change the `HelloFrame.capabilities` block to:

```ts
  /** Capability flags so older clients can negotiate down. */
  readonly capabilities: {
    readonly chat: boolean
    readonly streamingDeltas: boolean
    readonly localShell: boolean
    readonly setup: boolean
  }
```

- [ ] **Step 4: Advertise it from the server**

In `packages/ui-ws/src/server.ts`, the `hello` send (~line 393): the server is in setup-mode when no `ChatService` was bound. Change the `capabilities` object to:

```ts
          capabilities: {
            chat: chat !== null,
            streamingDeltas: chat !== null,
            localShell: localShellBridge !== null,
            // setup-mode = started without a chat service (unconfigured /
            // credential not usable). #1b serves the login terminal here.
            setup: chat === null,
          },
```

- [ ] **Step 5: Update the ui-shared shadow types**

In `packages/ui-shared/src/wire.ts` (~line 96), add `setup` to the shadow `capabilities`:

```ts
  readonly capabilities: {
    readonly chat: boolean
    readonly streamingDeltas: boolean
    readonly setup: boolean
  }
```

In `packages/ui-shared/src/reducer.ts` line 50, extend the tracked shape:

```ts
  readonly capabilities: { readonly chat: boolean; readonly streamingDeltas: boolean; readonly setup: boolean }
```

and the initial state at line 76:

```ts
  capabilities: { chat: false, streamingDeltas: false, setup: false },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun run test packages/ui-ws/test/setup-capability.test.ts` and `tsc --noEmit -p packages/ui-ws/tsconfig.json` (and `-p packages/ui-shared/tsconfig.json` if present).
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/ui-ws/src/protocol.ts packages/ui-ws/src/server.ts packages/ui-shared/src/wire.ts packages/ui-shared/src/reducer.ts packages/ui-ws/test/setup-capability.test.ts
git commit -m "feat(ui-ws): add setup capability to the hello frame (setup-mode foundation)"
```

---

### Task 2: `decideMode` + `probeCredentialReadiness`

**Files:**
- Create: `apps/ui-web/scripts/credential-readiness.ts`
- Test: `apps/ui-web/scripts/__tests__/credential-readiness.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/ui-web/scripts/__tests__/credential-readiness.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { decideMode, probeCredentialReadiness } from "../credential-readiness.js"

describe("decideMode", () => {
  it("ready → normal, not-ready → setup", () => {
    expect(decideMode({ ready: true, reason: "ok" })).toBe("normal")
    expect(decideMode({ ready: false, reason: "no-accounts" })).toBe("setup")
  })
})

describe("probeCredentialReadiness", () => {
  const base = { dbPath: "/x/luna.db", claudeExe: "claude" }

  it("no accounts → not ready", () => {
    const r = probeCredentialReadiness({ ...base, _readAccounts: () => [] })
    expect(r.ready).toBe(false)
    expect(r.reason).toBe("no-accounts")
  })

  it("claude-code:login + auth status loggedIn → ready", () => {
    const r = probeCredentialReadiness({
      ...base,
      _readAccounts: () => [{ kind: "anthropic", secret_ref: "claude-code:login" }],
      _authStatus: () => ({ ok: true }),
    })
    expect(r.ready).toBe(true)
  })

  it("claude-code:login + auth status NOT loggedIn → not ready (lapse)", () => {
    const r = probeCredentialReadiness({
      ...base,
      _readAccounts: () => [{ kind: "anthropic", secret_ref: "claude-code:login" }],
      _authStatus: () => ({ ok: false }),
    })
    expect(r.ready).toBe(false)
    expect(r.reason).toBe("claude-login-lapsed")
  })

  it("env:/op:// account → ready in v1 (deep-resolve deferred to doctor)", () => {
    const r = probeCredentialReadiness({
      ...base,
      _readAccounts: () => [{ kind: "anthropic", secret_ref: "env:ANTHROPIC_API_KEY" }],
    })
    expect(r.ready).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test apps/ui-web/scripts/__tests__/credential-readiness.test.ts`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Implement the module**

Create `apps/ui-web/scripts/credential-readiness.ts`:

```ts
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"

export type Mode = "setup" | "normal"
export interface Readiness {
  readonly ready: boolean
  readonly reason: string
}
interface AccountRow {
  readonly kind: string
  readonly secret_ref: string
}
export interface ProbeDeps {
  readonly dbPath: string
  readonly claudeExe: string
  /** Test seam: read account rows. Default reads via bun:sqlite. */
  readonly _readAccounts?: (dbPath: string) => ReadonlyArray<AccountRow>
  /** Test seam: run `claude auth status`. Default spawns the binary. */
  readonly _authStatus?: (claudeExe: string) => { ok: boolean }
}

const CLAUDE_CODE_LOGIN = "claude-code:login"

const defaultReadAccounts = (dbPath: string): ReadonlyArray<AccountRow> => {
  // bun:sqlite via createRequire (mirrors apps/agent-cli/src/db.ts loading).
  const require = createRequire(import.meta.url)
  const { Database } = require("bun:sqlite") as {
    Database: new (p: string, opts?: { readonly?: boolean }) => {
      query: (sql: string) => { all: () => unknown[] }
      close: () => void
    }
  }
  const db = new Database(dbPath, { readonly: true })
  try {
    return db
      .query("SELECT kind, secret_ref FROM accounts")
      .all() as ReadonlyArray<AccountRow>
  } finally {
    db.close()
  }
}

const defaultAuthStatus = (claudeExe: string): { ok: boolean } => {
  // `claude auth status --json` exits 0 + {loggedIn:true} when authenticated.
  // CLAUDE_CONFIG_DIR is already in process.env (loaded before bootstrap).
  const r = spawnSync(claudeExe, ["auth", "status", "--json"], {
    encoding: "utf8",
    timeout: 8000,
    env: process.env,
  })
  if (r.status !== 0 || typeof r.stdout !== "string") return { ok: false }
  try {
    return { ok: (JSON.parse(r.stdout) as { loggedIn?: boolean }).loggedIn === true }
  } catch {
    return { ok: false }
  }
}

/** Pure: a readiness result → which boot mode. */
export const decideMode = (r: Readiness): Mode => (r.ready ? "normal" : "setup")

/**
 * Decide whether the model credential is usable at boot.
 * - 0 accounts → not ready (first run).
 * - a `claude-code:login` account → `claude auth status` must say loggedIn.
 * - env:/op:// accounts → ready in v1 (deep resolution is `luna doctor`'s job;
 *   a misconfigured one still fails lazily at chat time, as it does today).
 */
export const probeCredentialReadiness = (deps: ProbeDeps): Readiness => {
  const readAccounts = deps._readAccounts ?? defaultReadAccounts
  const authStatus = deps._authStatus ?? defaultAuthStatus
  let accounts: ReadonlyArray<AccountRow>
  try {
    accounts = readAccounts(deps.dbPath)
  } catch {
    // No DB / unreadable accounts table → treat as unconfigured.
    return { ready: false, reason: "no-accounts-db" }
  }
  if (accounts.length === 0) return { ready: false, reason: "no-accounts" }
  const hasLogin = accounts.some((a) => a.secret_ref === CLAUDE_CODE_LOGIN)
  if (hasLogin) {
    return authStatus(deps.claudeExe).ok
      ? { ready: true, reason: "claude-login-ok" }
      : { ready: false, reason: "claude-login-lapsed" }
  }
  // env:/op:// account present — ready in v1.
  return { ready: true, reason: "non-login-account-present" }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test apps/ui-web/scripts/__tests__/credential-readiness.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/ui-web/scripts/credential-readiness.ts apps/ui-web/scripts/__tests__/credential-readiness.test.ts
git commit -m "feat(ui-web): credential-readiness probe + decideMode (setup-mode gate)"
```

---

### Task 3: Boot branch in `bootstrap()` (+ replace the hard-exit guard) + boot smoke

**Files:**
- Modify: `apps/ui-web/scripts/chat-server.ts` (`bootstrap()` ~lines 822–840; the `buildServerLayer`/`buildMain` guard at ~776)
- Create: `apps/ui-web/scripts/smoke/setup-mode-boot.smoke.ts`

**Context:** today `buildBaseLayer` builds chat/dream/survey/memory/sdk, `buildServerLayer` starts the WS server with `chatService: chat`, and `buildMain` hard-exits if `accounts.length === 0`. For setup-mode we must NOT build those subsystems and must NOT hard-exit. Add a `buildSetupServerLayer()` that starts the WS server with `chatService: null` (so the server advertises `setup:true, chat:false` from Task 1) and the existing token gate, and branch in `bootstrap()`.

- [ ] **Step 1: Write the failing smoke test**

Create `apps/ui-web/scripts/smoke/setup-mode-boot.smoke.ts` (run directly with bun, like the other `*-boot.smoke.ts`). It must: (a) point `LUNA_DB_PATH` at an empty temp DB → assert `decideMode(probeCredentialReadiness(...)) === "setup"`; (b) seed a `claude-code:login` account with a fake `_authStatus` ok → assert `"normal"`. Minimal version asserting the gate wiring (the full ManagedRuntime boot of each mode is exercised by running the server, but the smoke pins the decision):

```ts
import { decideMode, probeCredentialReadiness } from "../credential-readiness.js"

const empty = probeCredentialReadiness({
  dbPath: "/nonexistent/luna.db",
  claudeExe: "claude",
  _readAccounts: () => [],
})
if (decideMode(empty) !== "setup") throw new Error("expected setup for no accounts")

const lapsed = probeCredentialReadiness({
  dbPath: "x",
  claudeExe: "claude",
  _readAccounts: () => [{ kind: "anthropic", secret_ref: "claude-code:login" }],
  _authStatus: () => ({ ok: false }),
})
if (decideMode(lapsed) !== "setup") throw new Error("expected setup for lapsed login")

const ok = probeCredentialReadiness({
  dbPath: "x",
  claudeExe: "claude",
  _readAccounts: () => [{ kind: "anthropic", secret_ref: "claude-code:login" }],
  _authStatus: () => ({ ok: true }),
})
if (decideMode(ok) !== "normal") throw new Error("expected normal for healthy login")

// eslint-disable-next-line no-console
console.log("[smoke] setup-mode gate OK")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run apps/ui-web/scripts/smoke/setup-mode-boot.smoke.ts`
Expected: FAIL — `credential-readiness.js` import resolves (Task 2 done) but this smoke lives in `scripts/smoke/`; if Task 2's module path differs, fix the import. (If Task 2 is complete it should PASS — in that case this step documents the gate; proceed to wire the boot branch.)

- [ ] **Step 3: Add `buildSetupServerLayer` and branch in `bootstrap()`**

In `apps/ui-web/scripts/chat-server.ts`, add a setup-mode server layer (mirrors `buildServerLayer` but binds **no** chat/dream/survey/memory and starts the WS server with `chatService: null`):

```ts
const buildSetupServerLayer = () =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      yield* startControlServer(4754)
      yield* startUIWebSocketServer({
        port: 4753,
        ...(BIND_HOST !== undefined ? { host: BIND_HOST } : {}),
        token: TOKEN,
        advertisedKinds: DEFAULT_UI_KINDS,
        pingIntervalMs: 5000,
        chatService: null,
        accountBroker: null,
        survey: null,
        localShellBridge: null,
      })
    }),
  ).pipe(Layer.provide(LunaSqliteBootstrapLive))
```

(If `startUIWebSocketServer`'s config requires non-null `chatService`/`accountBroker`, relax those to optional/nullable — they're already used as `chat !== null` / passed through; confirm the config type and widen to `ChatService | null` etc. as needed. The hello-capabilities from Task 1 already key on `chat === null`.)

In `bootstrap()`, after the `[op] … providers active` log and before `buildBaseLayer`, branch on the mode:

```ts
  const paths = resolveRuntimePaths(process.env)
  const claudeExe = process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]?.trim() || "claude"
  const mode = decideMode(
    probeCredentialReadiness({ dbPath: paths.lunaDbPath, claudeExe }),
  )

  if (mode === "setup") {
    writeSync(1, "\n🔧 setup-mode: model credential not usable — serving setup UI (log in to continue)\n")
    const setupRuntime = ManagedRuntime.make(buildSetupServerLayer())
    installShutdown(setupRuntime) // factor the SIGINT/SIGTERM handler into a helper, reused by both modes
    setupRuntime.runPromise(Effect.never).catch((err) => {
      console.error("❌ setup-mode server crashed:", err)
      process.exit(1)
    })
    return
  }

  // normal mode — existing path below (buildBaseLayer + buildServerLayer + buildMain)
```

Factor the existing SIGINT/SIGTERM `shutdown` block (lines ~852–865) into `installShutdown(runtime)` so both modes register it (DRY).

- [ ] **Step 4: Replace the hard-exit guard**

In `buildMain` (~line 776), the `accounts.length === 0` branch is now unreachable in normal-mode (the gate guarantees ≥1 usable account before normal boot), but keep a defensive guard that **does not exit** — instead log and let the readiness gate handle it on the next boot. Replace the `Effect.fail` with a soft log (the gate is the real guard now):

```ts
    const accounts = yield* broker._inspect()
    if (accounts.length === 0) {
      // Should be unreachable: the boot-time readiness gate routes a
      // zero-account boot into setup-mode. If we somehow reach normal-mode
      // with no accounts, log loudly; the next restart re-runs the gate.
      console.error("⚠️ normal-mode reached with 0 accounts — readiness gate bypassed; restart to enter setup-mode")
    }
```

- [ ] **Step 5: Run the smoke + tests + typecheck**

Run:
```bash
bun run apps/ui-web/scripts/smoke/setup-mode-boot.smoke.ts
bun run test apps/ui-web/scripts/__tests__/credential-readiness.test.ts
```
Expected: `[smoke] setup-mode gate OK`; readiness tests PASS. (chat-server has no tsc gate; if `apps/ui-web` has a `typecheck` script scoped to `src/**`, the scripts/ dir may be excluded — run `tsc --noEmit` over the changed scripts manually if practical.)

- [ ] **Step 6: Real-box acceptance (manual, document result)**

On jax-box `luna-dev`: (a) with the current (valid) creds, restart → confirm normal-mode boot (MCP registered, ui-ws on 4753, `chat:true`). (b) Temporarily point `LUNA_DB_PATH` at an empty DB (or remove the account) + restart → confirm the server **stays up** logging `🔧 setup-mode` and the hello advertises `setup:true, chat:false` (probe via the ws-probe from earlier, checking the hello frame), **not** a crash/exit. Restore.

- [ ] **Step 7: Commit**

```bash
git add apps/ui-web/scripts/chat-server.ts apps/ui-web/scripts/smoke/setup-mode-boot.smoke.ts
git commit -m "feat(ui-web): boot into setup-mode when the credential is not usable

Replace the zero-accounts hard-exit with a boot-time readiness gate: not-ready
(no account / claude auth status loggedIn:false) -> minimal setup-mode WS layer
advertising setup:true,chat:false; ready -> normal. Restart re-decides. #1b adds
the embedded login terminal served in setup-mode."
```

---

## Self-review
- **Spec coverage:** implements §4.A (readiness gate: `auth status` for claude-code:login, env/op deferred), §4.B (setup-mode serves token-gated minimal endpoint, chat disabled, `setup` capability), §9.1 (gate replaces hard-exit) and the boot-smoke part of §7. The terminal (§4.C), seed+restart (§9.4), and lapse detection (§4.E/§9.5) are explicitly out (#1b).
- **Placeholders:** none — every code step is complete. The one judgment call (widening `startUIWebSocketServer` config to nullable chat/broker) is stated with the exact reason + where to confirm.
- **Type consistency:** `setup` added in all four shadow sites (protocol, server send, wire, reducer); `decideMode`/`probeCredentialReadiness`/`Readiness`/`ProbeDeps` names are identical across Task 2 + Task 3; `_readAccounts`/`_authStatus` deps match between tests and impl.
- **Restart dependency:** relies on PR 0's graceful-shutdown + `Restart=always` (incus) / `--restart` (OCI) — already in place.
