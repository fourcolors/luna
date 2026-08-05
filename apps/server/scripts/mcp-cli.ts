#!/usr/bin/env bun
/**
 * mcp-cli — operator CLI for the Luna MCP server registry.
 *
 * Manages operator-registered external MCP servers stored in luna.db (or
 * any db file pointed to by LUNA_DB).  All mutations are fail-closed by
 * design: a freshly added server is untrusted with no allowed tools until
 * the operator explicitly trusts it and opts in tools.
 *
 * Usage: bun run apps/server/scripts/mcp-cli.ts <command> [args]
 *
 * Env vars:
 *   LUNA_DB   Path to luna.db (default: ~/.luna/luna.db)
 */
import { Effect, Layer } from "effect"
import { homedir } from "node:os"
import { resolve } from "node:path"
import {
  Clock,
  ConfigError,
  EnvSecretProvider,
  LunaSqliteBootstrap,
  MCPRegistry,
} from "@luna/core"
import {
  McpServerStore,
  syncMcpMounts,
  type SyncMcpMountsResult,
} from "@luna/mcp-servers"
import { mcpToolGate } from "@luna/tools"

// ---------------------------------------------------------------------------
// DB path resolution
// ---------------------------------------------------------------------------

const dbPath = resolve(
  process.env["LUNA_DB"] ?? `${homedir()}/.luna/luna.db`,
)

// ---------------------------------------------------------------------------
// Base layer: stub bootstrap + real Clock + store
// ---------------------------------------------------------------------------

const BootstrapStub: Layer.Layer<LunaSqliteBootstrap> = Layer.succeed(
  LunaSqliteBootstrap,
  { ok: false, reason: "mcp-cli: vectorlite not loaded (script mode)" },
)

const storeLayer: Layer.Layer<McpServerStore, ConfigError, never> =
  McpServerStore.makeLayer(dbPath).pipe(
    Layer.provide(Layer.merge(BootstrapStub, Clock.Default)),
  )

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const GREEN = "\x1b[32m"
const DIM = "\x1b[2m"

const bold = (s: string) => `${BOLD}${s}${RESET}`
const dim = (s: string) => `${DIM}${s}${RESET}`
const red = (s: string) => `${RED}${s}${RESET}`
const yellow = (s: string) => `${YELLOW}${s}${RESET}`
const green = (s: string) => `${GREEN}${s}${RESET}`

function printUsage() {
  console.log(`
${bold("mcp-cli")} — Luna MCP server registry manager
${dim(`DB: ${dbPath}`)}

${bold("USAGE")}
  bun run apps/server/scripts/mcp-cli.ts <command> [args]

${bold("COMMANDS")}
  list
      Print all registered servers (slug, url, enabled, trusted, allowAll,
      allowedTools count).

  add <slug> <url> [--header NAME=REF ...]
      Register a new MCP server.  Headers are NAME=secret-ref pairs, e.g.:
        --header "Authorization=env:MY_TOKEN"
      The server starts ${bold("untrusted")} with ${bold("no tools")} — fail-closed by design.

  trust <slug>
      Accept the trust prompt for a server.  ${yellow("WARNING: see trust warning below.")}

  allow <slug> <tool>
      Add a single tool name to the server's allow-list.

  allow-all <slug> [--on|--off]
      Set the allowAll flag (default: --on).  When on, ALL tools advertised
      by the server are exposed.

  enable <slug>
      Set enabled=true for a server.

  disable <slug>
      Set enabled=false for a server.

  remove <slug>
      Delete a server from the registry.

  preview
      Dry-run syncMcpMounts() — show what the agent would mount at boot,
      with header values REDACTED.

${bold("TRUST WARNING")}
  Running ${bold("trust")} registers this server with the agent.  When the agent next
  boots and mounts this server, it will include your resolved credentials
  (headers) in every request to that server's HTTPS endpoint.  Only trust
  servers you control or fully vet.

${bold("ENV VARS")}
  LUNA_DB   Path to luna.db  (default: ~/.luna/luna.db)
`)
}

function parseHeaders(args: string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === "--header" || arg === "-H") {
      i++
      const pair = args[i]
      if (pair === undefined) {
        console.error(red("error: --header requires NAME=REF argument"))
        process.exit(1)
      }
      const eqIdx = pair.indexOf("=")
      if (eqIdx === -1) {
        console.error(red(`error: --header value must be NAME=REF, got: ${pair}`))
        process.exit(1)
      }
      const name = pair.slice(0, eqIdx)
      const ref = pair.slice(eqIdx + 1)
      if (!name) {
        console.error(red(`error: --header NAME part is empty in: ${pair}`))
        process.exit(1)
      }
      headers[name] = ref
    }
    i++
  }
  return headers
}

function runEffect<A, E>(
  eff: Effect.Effect<A, E, never>,
  label: string,
): Promise<A> {
  return Effect.runPromise(
    eff.pipe(
      Effect.tapError((e) =>
        Effect.sync(() => {
          console.error(red(`error [${label}]: ${String(e)}`))
        }),
      ),
    ),
  ).catch((err: unknown) => {
    process.exit(1)
    // unreachable — satisfies TS
    throw err
  })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdList() {
  await runEffect(
    Effect.gen(function* () {
      const store = yield* McpServerStore
      const rows = yield* store.list()
      if (rows.length === 0) {
        console.log(dim("(no servers registered)"))
        return
      }
      console.log(
        `${bold("SLUG")}`.padEnd(28) +
        `${bold("URL")}`.padEnd(52) +
        `${bold("ENA")}`.padEnd(6) +
        `${bold("TRUSTED")}`.padEnd(10) +
        `${bold("ALL")}`.padEnd(6) +
        `${bold("TOOLS")}`,
      )
      console.log("─".repeat(110))
      for (const row of rows) {
        const trusted = row.trustAcceptedAt !== null ? green("yes") : red("no")
        const ena = row.enabled ? green("on") : red("off")
        const all = row.allowAll ? yellow("yes") : "no"
        console.log(
          row.slug.padEnd(28) +
          row.url.slice(0, 48).padEnd(52) +
          ena.padEnd(6 + 9) + // extra for ANSI codes
          trusted.padEnd(10 + 9) +
          all.padEnd(6 + (row.allowAll ? 9 : 0)) +
          String(row.allowedTools.length),
        )
      }
      console.log(dim(`\n${rows.length} server(s) total`))
    }).pipe(Effect.provide(storeLayer)),
    "list",
  )
}

async function cmdAdd(slug: string, url: string, headers: Record<string, string>) {
  await runEffect(
    Effect.gen(function* () {
      const store = yield* McpServerStore
      const row = yield* store.add({ slug, url, headers })
      console.log(green(`✓ added: ${row.slug}`))
      console.log(dim(`  url:  ${row.url}`))
      if (Object.keys(headers).length > 0) {
        console.log(dim(`  headers: ${Object.keys(headers).join(", ")} (refs stored, not values)`))
      }
      console.log()
      console.log(
        yellow("FAIL-CLOSED: server added as untrusted with no tools allowed."),
      )
      console.log(
        `Run: ${bold(`mcp-cli trust ${slug}`)} && ${bold(`mcp-cli allow ${slug} <tool>`)}`,
      )
    }).pipe(Effect.provide(storeLayer)),
    "add",
  )
}

async function cmdTrust(slug: string) {
  await runEffect(
    Effect.gen(function* () {
      const store = yield* McpServerStore
      const row = yield* store.get(slug)
      if (row === null) {
        console.error(red(`error: server "${slug}" not found`))
        process.exit(1)
      }
      yield* store.acceptTrust(slug, Date.now())
      console.log(green(`✓ trusted: ${slug}`))
      console.log()
      console.log(
        yellow("TRUST WARNING: this server will be mounted by the agent on next boot."),
      )
      console.log(
        "  Resolved header credentials will be sent to: " + bold(row.url),
      )
      console.log(
        "  Only trust servers you control or have fully vetted.",
      )
    }).pipe(Effect.provide(storeLayer)),
    "trust",
  )
}

async function cmdAllow(slug: string, tool: string) {
  await runEffect(
    Effect.gen(function* () {
      const store = yield* McpServerStore
      yield* store.allowTool(slug, tool)
      console.log(green(`✓ allowed tool: ${tool} on ${slug}`))
    }).pipe(Effect.provide(storeLayer)),
    "allow",
  )
}

async function cmdAllowAll(slug: string, on: boolean) {
  await runEffect(
    Effect.gen(function* () {
      const store = yield* McpServerStore
      yield* store.allowAllTools(slug, on)
      if (on) {
        console.log(yellow(`✓ allow-all ENABLED for ${slug} — all tools on this server are exposed`))
      } else {
        console.log(green(`✓ allow-all DISABLED for ${slug} — per-tool allowlist applies`))
      }
    }).pipe(Effect.provide(storeLayer)),
    "allow-all",
  )
}

async function cmdSetEnabled(slug: string, enabled: boolean) {
  await runEffect(
    Effect.gen(function* () {
      const store = yield* McpServerStore
      yield* store.setEnabled(slug, enabled)
      console.log(green(`✓ ${enabled ? "enabled" : "disabled"}: ${slug}`))
    }).pipe(Effect.provide(storeLayer)),
    `${enabled ? "enable" : "disable"}`,
  )
}

async function cmdRemove(slug: string) {
  await runEffect(
    Effect.gen(function* () {
      const store = yield* McpServerStore
      yield* store.remove(slug)
      console.log(green(`✓ removed: ${slug}`))
    }).pipe(Effect.provide(storeLayer)),
    "remove",
  )
}

async function cmdPreview() {
  // Build a full layer including MCPRegistry + EnvSecretProvider for preview
  const previewLayer = Layer.mergeAll(
    storeLayer,
    MCPRegistry.Default,
    EnvSecretProvider.Default,
  )

  await runEffect(
    Effect.gen(function* () {
      console.log(bold("preview: dry-run syncMcpMounts()"))
      console.log(dim(`DB: ${dbPath}`))
      console.log()

      const result: SyncMcpMountsResult = yield* syncMcpMounts()
      const registry = yield* MCPRegistry
      const snapshot = registry.snapshotSync()

      if (result.registered.length === 0 && result.skipped.length === 0) {
        console.log(dim("(no enabled+trusted servers to mount)"))
      }

      if (result.registered.length > 0) {
        console.log(bold("REGISTERED:"))
        for (const slug of result.registered) {
          const config = snapshot[slug]
          const p = result.policy[slug]
          console.log(`  ${green("✓")} ${bold(slug)}`)
          if (config !== undefined) {
            const url = typeof config["url"] === "string" ? config["url"] : "(unknown)"
            console.log(`      url:       ${url}`)
            const rawHeaders = config["headers"]
            if (
              rawHeaders !== null &&
              typeof rawHeaders === "object" &&
              !Array.isArray(rawHeaders)
            ) {
              const headers = rawHeaders as Record<string, unknown>
              const names = Object.keys(headers)
              if (names.length > 0) {
                for (const name of names) {
                  console.log(`      header:    ${name}: <redacted>`)
                }
              }
            }
          }
          if (p !== undefined) {
            console.log(`      allowAll:  ${p.allowAll}`)
            console.log(`      tools:     ${p.allowedTools.length > 0 ? p.allowedTools.join(", ") : "(none)"}`)
          }
        }
      }

      if (result.skipped.length > 0) {
        console.log()
        console.log(bold("SKIPPED:"))
        for (const s of result.skipped) {
          console.log(`  ${red("✗")} ${s.slug}: ${s.reason}`)
        }
      }

      console.log()
      console.log(
        dim(
          `total: ${result.registered.length} registered, ${result.skipped.length} skipped`,
        ),
      )

      // Show gate policy summary
      if (result.registered.length > 0) {
        console.log()
        console.log(bold("GATE POLICY SUMMARY:"))
        const policyMap = new Map(
          Object.entries(result.policy).map(([slug, p]) => [
            slug,
            { allowAll: p.allowAll, allowedTools: new Set(p.allowedTools) },
          ]),
        )
        const gate = mcpToolGate((s) => policyMap.get(s))
        for (const slug of result.registered) {
          const p = result.policy[slug]
          if (p === undefined) continue
          const verdict = p.allowAll
            ? green("allow-all")
            : p.allowedTools.length > 0
              ? green(`${p.allowedTools.length} tool(s) allowed`)
              : red("deny-all (no tools opted in)")
          console.log(`  ${slug}: ${verdict}`)
        }
        // suppress unused-variable warning on gate — it's instantiated above
        // to verify the gate builds without errors
        void gate
      }
    }).pipe(Effect.provide(previewLayer)),
    "preview",
  )
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const cmd = argv[0]

switch (cmd) {
  case "list": {
    await cmdList()
    break
  }

  case "add": {
    const slug = argv[1]
    const url = argv[2]
    if (!slug || !url) {
      console.error(red("error: add requires <slug> <url>"))
      printUsage()
      process.exit(1)
    }
    const headers = parseHeaders(argv.slice(3))
    await cmdAdd(slug, url, headers)
    break
  }

  case "trust": {
    const slug = argv[1]
    if (!slug) {
      console.error(red("error: trust requires <slug>"))
      process.exit(1)
    }
    await cmdTrust(slug)
    break
  }

  case "allow": {
    const slug = argv[1]
    const tool = argv[2]
    if (!slug || !tool) {
      console.error(red("error: allow requires <slug> <tool>"))
      process.exit(1)
    }
    await cmdAllow(slug, tool)
    break
  }

  case "allow-all": {
    const slug = argv[1]
    if (!slug) {
      console.error(red("error: allow-all requires <slug>"))
      process.exit(1)
    }
    const flag = argv[2]
    const on = flag === "--off" ? false : true
    await cmdAllowAll(slug, on)
    break
  }

  case "enable": {
    const slug = argv[1]
    if (!slug) {
      console.error(red("error: enable requires <slug>"))
      process.exit(1)
    }
    await cmdSetEnabled(slug, true)
    break
  }

  case "disable": {
    const slug = argv[1]
    if (!slug) {
      console.error(red("error: disable requires <slug>"))
      process.exit(1)
    }
    await cmdSetEnabled(slug, false)
    break
  }

  case "remove": {
    const slug = argv[1]
    if (!slug) {
      console.error(red("error: remove requires <slug>"))
      process.exit(1)
    }
    await cmdRemove(slug)
    break
  }

  case "preview": {
    await cmdPreview()
    break
  }

  case "--help":
  case "-h":
  case "help":
  case undefined: {
    printUsage()
    if (cmd === undefined) process.exit(1)
    break
  }

  default: {
    console.error(red(`error: unknown command "${cmd}"`))
    printUsage()
    process.exit(1)
  }
}
