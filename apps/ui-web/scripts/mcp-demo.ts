#!/usr/bin/env bun
/**
 * mcp-demo — self-contained end-to-end showcase of the Luna MCP stack.
 *
 * Proves the full lifecycle: register → fail-closed → trust → mount →
 * gate-deny → allow → gate-permit → (optional) live HTTP proof.
 *
 * Uses a TEMP database (never the real luna.db).  Safe to run repeatedly.
 *
 * Configuration (all optional — sensible defaults for a dry-run):
 *   MCP_DEMO_URL          HTTPS endpoint of your MCP server
 *                         (default: "https://example.com/api/mcp")
 *   MCP_DEMO_TOKEN_ENV    Name of the env var that holds the bearer token
 *                         (default: "MCP_DEMO_TOKEN")
 *                         The env var MUST contain the FULL header value,
 *                         e.g. "Bearer eyJhbGci..." — it is passed verbatim
 *                         as the Authorization header value.
 *   MCP_DEMO_SLUG         Slug for the demo server (default: "demo-server")
 *   MCP_DEMO_TOOL         Tool name to opt-in to (default: "demo-tool")
 *
 * Run:
 *   bun run apps/ui-web/scripts/mcp-demo.ts
 *
 * Live proof (step 8) requires MCP_DEMO_TOKEN_ENV to name an env var that
 * is non-empty. Without it step 8 is skipped gracefully.
 */
import { Effect, Layer, Redacted } from "effect"
import { tmpdir } from "node:os"
import { existsSync, unlinkSync } from "node:fs"
import { Clock, ConfigError, LunaSqliteBootstrap, MCPRegistry, SecretProvider } from "@luna/core"
import { McpServerStore, syncMcpMounts } from "@luna/mcp-servers"
import { mcpToolGate } from "@luna/tools"

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

const DEMO_URL = process.env["MCP_DEMO_URL"] ?? "https://example.com/api/mcp"
const DEMO_TOKEN_ENV = process.env["MCP_DEMO_TOKEN_ENV"] ?? "MCP_DEMO_TOKEN"
const DEMO_SLUG = process.env["MCP_DEMO_SLUG"] ?? "demo-server"
const DEMO_TOOL = process.env["MCP_DEMO_TOOL"] ?? "demo-tool"
const DEMO_DB_PATH = `${tmpdir()}/mcp-demo-${process.pid}.db`

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"

const bold = (s: string) => `${BOLD}${s}${RESET}`
const dim = (s: string) => `${DIM}${s}${RESET}`
const red = (s: string) => `${RED}${s}${RESET}`
const green = (s: string) => `${GREEN}${s}${RESET}`
const yellow = (s: string) => `${YELLOW}${s}${RESET}`
const cyan = (s: string) => `${CYAN}${s}${RESET}`

let stepNum = 0
function step(title: string) {
  stepNum++
  console.log()
  console.log(`${bold(cyan(`[${stepNum}]`))} ${bold(title)}`)
  console.log(dim("─".repeat(60)))
}

function info(msg: string) {
  console.log(`    ${msg}`)
}

function ok(msg: string) {
  console.log(`    ${green("✓")} ${msg}`)
}

function warn(msg: string) {
  console.log(`    ${yellow("⚠")} ${msg}`)
}

function deny(msg: string) {
  console.log(`    ${red("✗")} ${msg}`)
}

// ---------------------------------------------------------------------------
// Inline env SecretProvider — resolves env:VARNAME from process.env.
// This is a minimal inline implementation (mirrors EnvSecretProvider.Default)
// that does NOT depend on bun:sqlite or any IO besides process.env.
// ---------------------------------------------------------------------------

const InlineEnvSecretProvider: Layer.Layer<SecretProvider> = Layer.succeed(
  SecretProvider,
  {
    get: (ref: string) => {
      if (!ref.startsWith("env:")) {
        return Effect.fail(
          new ConfigError({
            module: "InlineEnvSecretProvider",
            key: ref,
            message: `ref "${ref}" is not an env: ref`,
          }),
        )
      }
      const varName = ref.slice(4)
      const v = process.env[varName]
      if (v === undefined || v === "") {
        return Effect.fail(
          new ConfigError({
            module: "InlineEnvSecretProvider",
            key: ref,
            message: `env var "${varName}" is not set or empty`,
          }),
        )
      }
      return Effect.succeed(Redacted.make(v))
    },
  },
)

// ---------------------------------------------------------------------------
// Bootstrap layer (stub — no vectorlite needed for scripts)
// ---------------------------------------------------------------------------

const BootstrapStub: Layer.Layer<LunaSqliteBootstrap> = Layer.succeed(
  LunaSqliteBootstrap,
  { ok: false, reason: "mcp-demo: vectorlite not loaded (script mode)" },
)

const storeLayer = McpServerStore.makeLayer(DEMO_DB_PATH).pipe(
  Layer.provide(Layer.merge(BootstrapStub, Clock.Default)),
)

// ---------------------------------------------------------------------------
// Full demo layer
// ---------------------------------------------------------------------------

const demoLayer = Layer.mergeAll(
  storeLayer,
  MCPRegistry.Default,
  InlineEnvSecretProvider,
)

// ---------------------------------------------------------------------------
// Policy map helper — rebuilt after each sync to reflect current policy
// ---------------------------------------------------------------------------

type PolicyMap = Map<string, { allowAll: boolean; allowedTools: Set<string> }>

function buildPolicyMap(
  policy: Record<string, { allowAll: boolean; allowedTools: string[] }>,
): PolicyMap {
  const map: PolicyMap = new Map()
  for (const [slug, p] of Object.entries(policy)) {
    map.set(slug, { allowAll: p.allowAll, allowedTools: new Set(p.allowedTools) })
  }
  return map
}

// ---------------------------------------------------------------------------
// Main demo program
// ---------------------------------------------------------------------------

const demo = Effect.gen(function* () {
  console.log()
  console.log(bold("━━━ Luna MCP Stack — End-to-End Demo ━━━"))
  console.log(dim(`  temp DB:    ${DEMO_DB_PATH}`))
  console.log(dim(`  server URL: ${DEMO_URL}`))
  console.log(dim(`  slug:       ${DEMO_SLUG}`))
  console.log(dim(`  token env:  ${DEMO_TOKEN_ENV}`))
  console.log(dim(`  demo tool:  ${DEMO_TOOL}`))

  const store = yield* McpServerStore
  const registry = yield* MCPRegistry

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 1: DB created, layer built
  // ─────────────────────────────────────────────────────────────────────────
  step("Create temp DB + build layers")
  ok(`temp DB: ${DEMO_DB_PATH}`)
  ok("McpServerStore.makeLayer initialized")
  ok("MCPRegistry.Default initialized")
  ok("InlineEnvSecretProvider ready (resolves env:VAR from process.env)")

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 2: Token env documentation
  // ─────────────────────────────────────────────────────────────────────────
  step(`Token configuration (env var: ${DEMO_TOKEN_ENV})`)
  const tokenPresent =
    typeof process.env[DEMO_TOKEN_ENV] === "string" &&
    (process.env[DEMO_TOKEN_ENV] as string).length > 0
  if (tokenPresent) {
    ok(`${DEMO_TOKEN_ENV} is set (value redacted)`)
  } else {
    warn(`${DEMO_TOKEN_ENV} is not set — live proof (step 8) will be skipped`)
  }
  info(`Header ref used: "env:${DEMO_TOKEN_ENV}"`)
  info(`The env var must contain the COMPLETE header value, e.g.:`)
  info(`  export ${DEMO_TOKEN_ENV}="Bearer eyJhbGci..."`)
  info(`It is passed verbatim as the "Authorization" header.`)

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 3: Add server (fail-closed)
  // ─────────────────────────────────────────────────────────────────────────
  step(`store.add({ slug: "${DEMO_SLUG}", url: "${DEMO_URL}" })`)
  const row = yield* store.add({
    slug: DEMO_SLUG,
    url: DEMO_URL,
    headers: { Authorization: `env:${DEMO_TOKEN_ENV}` },
  })
  ok(`added: ${row.slug}`)
  info(`enabled: ${row.enabled}`)
  info(`trustAcceptedAt: ${row.trustAcceptedAt ?? "null (untrusted)"}`)
  info(`allowedTools: [${row.allowedTools.join(", ")}]`)
  info(`allowAll: ${row.allowAll}`)
  warn("FAIL-CLOSED: server is untrusted with no tools — not mountable yet.")

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 4: syncMcpMounts() — should NOT mount (untrusted)
  // ─────────────────────────────────────────────────────────────────────────
  step("syncMcpMounts() — before trust (expect: not mounted)")
  const result1 = yield* syncMcpMounts()
  if (result1.registered.length === 0) {
    ok("registered: [] — server is NOT mounted (correct, fail-closed)")
  } else {
    deny(`unexpected: registered = [${result1.registered.join(", ")}]`)
  }
  if (result1.skipped.length > 0) {
    const skip = result1.skipped[0]
    info(`skipped[0]: ${skip?.slug ?? "?"} — ${skip?.reason ?? "?"}`)
  }
  warn("FAIL-CLOSED: untrusted server not mounted.")

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 5: acceptTrust → syncMcpMounts() — now mounted
  // ─────────────────────────────────────────────────────────────────────────
  step(`store.acceptTrust("${DEMO_SLUG}") + syncMcpMounts()`)
  yield* store.acceptTrust(DEMO_SLUG, Date.now())
  ok(`trust accepted for: ${DEMO_SLUG}`)
  warn(
    "TRUST WARNING: this server will receive resolved credentials on mount.",
  )

  const result2 = yield* syncMcpMounts()
  if (result2.registered.includes(DEMO_SLUG)) {
    ok(`registered: [${result2.registered.join(", ")}]`)
  } else {
    // Secret ref may be unresolvable if token not set — show skip reason
    const skip = result2.skipped.find((s) => s.slug === DEMO_SLUG)
    if (skip !== undefined) {
      warn(`skipped: ${skip.reason}`)
      info("(this is expected if the token env var is not set)")
    } else {
      deny("server not in registered or skipped — unexpected state")
    }
  }

  // Show mount config with REDACTED headers
  const snapshot = registry.snapshotSync()
  const mountedConfig = snapshot[DEMO_SLUG]
  if (mountedConfig !== undefined) {
    info("mount config:")
    info(`  type: ${String(mountedConfig["type"] ?? "http")}`)
    info(`  url:  ${String(mountedConfig["url"] ?? DEMO_URL)}`)
    const hdrs = mountedConfig["headers"]
    if (hdrs !== null && typeof hdrs === "object" && !Array.isArray(hdrs)) {
      for (const name of Object.keys(hdrs as Record<string, unknown>)) {
        info(`  header: ${name}: <redacted>`)
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 6: Gate DENY — tool not yet allowed
  // ─────────────────────────────────────────────────────────────────────────
  step("mcpToolGate — DENY (tool not yet in allowlist)")
  const policyMap1 = buildPolicyMap(result2.policy)
  const gate1 = mcpToolGate((s) => policyMap1.get(s))

  const toolName = `mcp__${DEMO_SLUG}__${DEMO_TOOL}`
  const verdict1 = yield* gate1(toolName, {})
  if (verdict1.behavior === "deny") {
    deny(`${toolName} → DENY`)
    info(`reason: ${verdict1.message}`)
  } else {
    warn(`unexpected: ${toolName} → ALLOW (should have been denied)`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 7: allowTool → re-sync → gate ALLOW + DENY different tool
  // ─────────────────────────────────────────────────────────────────────────
  step(`store.allowTool("${DEMO_SLUG}", "${DEMO_TOOL}") + gate check`)
  yield* store.allowTool(DEMO_SLUG, DEMO_TOOL)
  ok(`tool "${DEMO_TOOL}" added to allowlist`)

  const result3 = yield* syncMcpMounts()
  const policyMap2 = buildPolicyMap(result3.policy)
  const gate2 = mcpToolGate((s) => policyMap2.get(s))

  // Check allowed tool
  const verdict2 = yield* gate2(toolName, {})
  if (verdict2.behavior === "allow") {
    ok(`${toolName} → ALLOW`)
  } else {
    deny(`unexpected: ${toolName} → DENY`)
  }

  // Check a different tool — should still be denied
  const otherTool = `mcp__${DEMO_SLUG}__other-tool`
  const verdict3 = yield* gate2(otherTool, {})
  if (verdict3.behavior === "deny") {
    deny(`${otherTool} → DENY (correct — not opted in)`)
  } else {
    warn(`unexpected: ${otherTool} → ALLOW`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 8: Live HTTPS proof (only if token is set)
  // ─────────────────────────────────────────────────────────────────────────
  step("Live HTTPS proof")

  const tokenValue = process.env[DEMO_TOKEN_ENV]
  if (!tokenValue) {
    warn(`Live step skipped (no token in $${DEMO_TOKEN_ENV})`)
    info(`Set ${DEMO_TOKEN_ENV}=<full-header-value> to run the live proof.`)
  } else {
    info(`Connecting to ${DEMO_URL} ...`)
    // NEVER print the token — only the header NAME
    info(`Using Authorization header (value redacted)`)

    const liveResult = yield* Effect.tryPromise({
      try: () => runLiveMcpProof(DEMO_URL, tokenValue),
      catch: (e) =>
        new ConfigError({
          module: "mcp-demo",
          key: "live-proof",
          message: String(e),
        }),
    }).pipe(
      Effect.catchAll((e) => {
        warn(`Live proof failed: ${e.message}`)
        return Effect.succeed(null)
      }),
    )

    if (liveResult !== null) {
      ok(`LIVE: connected to ${DEMO_URL}`)
      ok(`initialize ok, ${liveResult.toolCount} tools available`)
      if (liveResult.toolNames.length > 0) {
        info(`first ${liveResult.toolNames.length} tool(s): ${liveResult.toolNames.join(", ")}`)
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 9: Cleanup
  // ─────────────────────────────────────────────────────────────────────────
  step("Cleanup")
  // DB file cleanup is registered as a finalizer via Effect.addFinalizer
  // in McpServerStore.makeLayer (db.close()), but the file itself is not
  // deleted by the store. We delete it here.
  info(`Temp DB: ${DEMO_DB_PATH}`)
  // Cleanup happens in the finally block below; note it here.
  ok("temp DB will be deleted on exit")

  console.log()
  console.log(bold("━━━ Demo complete ━━━"))
  console.log()
})

// ---------------------------------------------------------------------------
// Live MCP HTTP proof
// ---------------------------------------------------------------------------

interface LiveProofResult {
  toolCount: number
  toolNames: string[]
}

/**
 * Makes two MCP JSON-RPC requests:
 * 1. initialize — to establish the session
 * 2. tools/list — to enumerate available tools
 *
 * Never logs the token value. Parses both JSON and SSE (text/event-stream)
 * response formats. Reads Mcp-Session-Id from initialize response headers.
 */
async function runLiveMcpProof(
  url: string,
  authHeaderValue: string,
): Promise<LiveProofResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": authHeaderValue, // value is never printed
  }

  // ── initialize ────────────────────────────────────────────────────────
  const initBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "mcp-demo", version: "1.0.0" },
      capabilities: {},
    },
  })

  const initRes = await fetch(url, { method: "POST", headers, body: initBody })
  if (!initRes.ok) {
    throw new Error(`initialize failed: HTTP ${initRes.status} ${initRes.statusText}`)
  }

  // Capture session id for subsequent requests (may be absent on some servers)
  const sessionId = initRes.headers.get("mcp-session-id") ?? undefined

  const initText = await initRes.text()
  const initJson = parseMcpResponse(initText)
  if (initJson === null) {
    throw new Error(`initialize response unparseable: ${initText.slice(0, 200)}`)
  }
  if ("error" in initJson && initJson["error"] !== undefined) {
    throw new Error(`initialize error: ${JSON.stringify(initJson["error"])}`)
  }

  // ── tools/list ────────────────────────────────────────────────────────
  const listHeaders: Record<string, string> = { ...headers }
  if (sessionId !== undefined) {
    listHeaders["Mcp-Session-Id"] = sessionId
  }

  const listBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  })

  const listRes = await fetch(url, {
    method: "POST",
    headers: listHeaders,
    body: listBody,
  })
  if (!listRes.ok) {
    throw new Error(`tools/list failed: HTTP ${listRes.status} ${listRes.statusText}`)
  }

  const listText = await listRes.text()
  const listJson = parseMcpResponse(listText)
  if (listJson === null) {
    throw new Error(`tools/list response unparseable: ${listText.slice(0, 200)}`)
  }
  if ("error" in listJson && listJson["error"] !== undefined) {
    throw new Error(`tools/list error: ${JSON.stringify(listJson["error"])}`)
  }

  // Extract tools array
  const result = (listJson as Record<string, unknown>)["result"]
  const tools =
    result !== null &&
    typeof result === "object" &&
    "tools" in (result as object) &&
    Array.isArray((result as Record<string, unknown>)["tools"])
      ? ((result as Record<string, unknown>)["tools"] as unknown[])
      : []

  const toolNames = tools
    .slice(0, 5)
    .map((t) =>
      t !== null && typeof t === "object" && "name" in (t as object)
        ? String((t as Record<string, unknown>)["name"])
        : "?",
    )

  return { toolCount: tools.length, toolNames }
}

/**
 * Parse either a plain JSON response or an SSE (text/event-stream) response.
 * SSE format: one or more `data: <json>` lines; we take the first data line
 * that is valid JSON and contains a jsonrpc field.
 */
function parseMcpResponse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()

  // Try plain JSON first
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      // fall through to SSE parse
    }
  }

  // Try SSE: look for "data: {...}" lines
  for (const line of trimmed.split("\n")) {
    const stripped = line.trim()
    if (!stripped.startsWith("data:")) continue
    const jsonPart = stripped.slice(5).trim()
    if (!jsonPart.startsWith("{")) continue
    try {
      const parsed = JSON.parse(jsonPart) as Record<string, unknown>
      if ("jsonrpc" in parsed) return parsed
    } catch {
      // skip malformed lines
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

Effect.runPromise(
  demo.pipe(
    Effect.scoped,
    Effect.provide(demoLayer),
    Effect.tapError((e) =>
      Effect.sync(() => {
        console.error()
        console.error(
          `\x1b[31mDemo failed:\x1b[0m ${String(e)}`,
        )
      }),
    ),
  ),
)
  .catch(() => {
    process.exit(1)
  })
  .finally(() => {
    // Clean up temp DB file regardless of success/failure
    try {
      if (existsSync(DEMO_DB_PATH)) {
        unlinkSync(DEMO_DB_PATH)
        console.log(dim(`  deleted: ${DEMO_DB_PATH}`))
      }
    } catch {
      // best-effort cleanup
    }
  })
