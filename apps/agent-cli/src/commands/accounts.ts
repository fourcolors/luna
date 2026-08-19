import { homedir } from "node:os"
import { defineCommand } from "citty"
import type { ServerFrame } from "@luna/ui-ws"
import { type ChatConfig, loadChatConfig, readLunaDotEnv } from "../chat/config.js"
import { LunaWsClient } from "../chat/ws-client.js"

/**
 * `luna accounts` — list each account's live health from the running server.
 *
 * The server pushes an `account-list` frame to every client shortly after the
 * initial `hello` frame. This command connects, waits for both frames, renders
 * a tidy table (or JSON), and exits. No server changes are required.
 *
 * Exit codes:
 *   0 — account list received and printed.
 *   1 — connection / auth / timeout failure (reason on stderr).
 *
 * The pure rendering path (accountsFrameToOutput) is decoupled from the
 * network path so it can be unit-tested without a live server.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface AccountRow {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly health: string
}

export interface AccountsRenderOptions {
  /** When true, emit minified JSON instead of a table. */
  readonly json: boolean
}

/* -------------------------------------------------------------------------- */
/* Pure rendering — frame → output string                                      */
/* -------------------------------------------------------------------------- */

/**
 * Pure: format a health value for table display. Rate-limited accounts get a
 * visual `⚠` suffix so operators can spot degraded accounts at a glance.
 */
export const formatHealth = (health: string): string =>
  health === "rate_limited" || health === "spent" ? `${health} ⚠` : health

/**
 * Pure: right-pad a string to at least `width` characters.
 * Returns `s` unchanged when `s.length >= width`.
 */
const pad = (s: string, width: number): string =>
  s.length >= width ? s : s + " ".repeat(width - s.length)

/**
 * Pure: derive column widths from headers + rows (at least the header length).
 */
const colWidths = (
  rows: ReadonlyArray<AccountRow>,
  opts: AccountsRenderOptions,
): { id: number; label: number; kind: number; health: number } => {
  if (opts.json) return { id: 0, label: 0, kind: 0, health: 0 }
  let id = "ID".length
  let label = "LABEL".length
  let kind = "KIND".length
  let health = "HEALTH".length
  for (const r of rows) {
    id = Math.max(id, r.id.length)
    label = Math.max(label, r.label.length)
    kind = Math.max(kind, r.kind.length)
    // formatted health is longer than raw (adds " ⚠")
    health = Math.max(health, formatHealth(r.health).length)
  }
  return { id, label, kind, health }
}

/**
 * Pure: convert an `account-list` payload to a printable string (table or JSON).
 *
 * Separating this from the network path keeps it straightforward to test and
 * reason about, without any live connection.
 */
export const accountsFrameToOutput = (
  accounts: ReadonlyArray<AccountRow>,
  opts: AccountsRenderOptions,
): string => {
  if (opts.json) {
    return JSON.stringify(accounts, null, 2) + "\n"
  }

  if (accounts.length === 0) {
    return "No accounts configured on this server.\n"
  }

  const w = colWidths(accounts, opts)

  const sep = `${"─".repeat(w.id + 2)}─${"─".repeat(w.label + 2)}─${"─".repeat(w.kind + 2)}─${"─".repeat(w.health + 2)}`

  const header = `  ${pad("ID", w.id)}  ${pad("LABEL", w.label)}  ${pad("KIND", w.kind)}  HEALTH`

  const rows = accounts.map(
    (r) =>
      `  ${pad(r.id, w.id)}  ${pad(r.label, w.label)}  ${pad(r.kind, w.kind)}  ${formatHealth(r.health)}`,
  )

  return [header, sep, ...rows, ""].join("\n")
}

/* -------------------------------------------------------------------------- */
/* Network helpers (impure — isolated here to keep the pure seam clean)        */
/* -------------------------------------------------------------------------- */

// 10s, not tighter: a cold dial over a tailnet/mDNS path can take >4s on the
// first resolution (observed live) — warm dials connect in well under 1s.
const HELLO_TIMEOUT_MS = 10_000
// Total budget for hello + account-list. Older servers that don't emit
// account-list will exhaust this and print a clear error rather than hanging.
const ACCOUNT_LIST_TIMEOUT_MS = 15_000

type FrameRace =
  | { readonly kind: "frame"; readonly frame: ServerFrame }
  | { readonly kind: "timeout" }

/** Race `client.nextFrame()` against a deadline timer. */
const raceFrame = (client: LunaWsClient, timeoutMs: number): Promise<FrameRace> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<FrameRace>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs)
  })
  const next = client.nextFrame().then((frame): FrameRace => ({ kind: "frame", frame }))
  return Promise.race([next, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

export interface AccountsResult {
  /** Text to print to stdout on success. */
  readonly stdout: string
  /** Error message to print to stderr on failure (empty string = success). */
  readonly stderr: string
  readonly exitCode: number
}

/**
 * Connect, wait for `hello` then `account-list`, and return a rendered result.
 * Always closes the socket before returning, even on error paths.
 */
const fetchAccounts = async (
  cfg: ChatConfig,
  opts: AccountsRenderOptions,
): Promise<AccountsResult> => {
  if (cfg.token === null || cfg.token.length === 0) {
    return {
      stdout: "",
      stderr: `no token configured — set LUNA_${cfg.profileName.toUpperCase()}_UI_WS_TOKEN in ~/.luna/.env\n`,
      exitCode: 1,
    }
  }

  let client: LunaWsClient
  try {
    client = await LunaWsClient.connect({
      url: cfg.url,
      token: cfg.token,
      timeoutMs: HELLO_TIMEOUT_MS,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      stdout: "",
      stderr: `connection failed: ${msg}\n`,
      exitCode: 1,
    }
  }

  try {
    const deadline = Date.now() + ACCOUNT_LIST_TIMEOUT_MS

    // Step 1 — wait for hello to confirm the server is up and in chat mode.
    let gotHello = false
    while (!gotHello && Date.now() < deadline) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const race = await raceFrame(client, remaining)
      if (race.kind === "timeout") break
      if (race.frame.type === "hello") {
        gotHello = true
        break
      }
      // skip any frame that arrives before hello (shouldn't happen per protocol,
      // but be defensive — don't stall on an unexpected broadcast)
    }

    if (!gotHello) {
      return {
        stdout: "",
        stderr: "timed out waiting for hello frame — server not responding\n",
        exitCode: 1,
      }
    }

    // Step 2 — wait for account-list (server sends it right after hello).
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const race = await raceFrame(client, remaining)
      if (race.kind === "timeout") break
      if (race.frame.type === "account-list") {
        const frame = race.frame as { accounts: ReadonlyArray<AccountRow> }
        return {
          stdout: accountsFrameToOutput(frame.accounts, opts),
          stderr: "",
          exitCode: 0,
        }
      }
      // skip other frames (skill-catalog, survey-request, etc.)
    }

    return {
      stdout: "",
      stderr:
        "timed out waiting for account-list frame — server may be an older version that does not emit it\n",
      exitCode: 1,
    }
  } finally {
    await client.close().catch(() => {})
  }
}

/* -------------------------------------------------------------------------- */
/* Config resolution — reuse the exact resolver `luna chat` uses               */
/* -------------------------------------------------------------------------- */

/**
 * Build a minimal ChatArgs subset for `loadChatConfig` so accounts gets the
 * same profile/URL/token resolution as `luna chat` and `luna doctor`.
 */
const accountsChatArgs = (args: {
  readonly profile?: string
  readonly url?: string
  readonly token?: string
}) => ({
  command: "chat" as const,
  unknown: [] as string[],
  ...(args.profile !== undefined ? { profile: args.profile } : {}),
  ...(args.url !== undefined ? { url: args.url } : {}),
  ...(args.token !== undefined ? { token: args.token } : {}),
})

const resolveAccountsConfig = (
  args: Parameters<typeof accountsChatArgs>[0],
  env: Record<string, string | undefined>,
  homeDir: string,
  cwd: string,
): ChatConfig =>
  loadChatConfig({
    args: accountsChatArgs(args),
    env,
    dotenv: readLunaDotEnv(homeDir),
    homeDir,
    cwd,
  })

/* -------------------------------------------------------------------------- */
/* citty command                                                               */
/* -------------------------------------------------------------------------- */

export const accountsCommand = defineCommand({
  meta: {
    name: "accounts",
    description: "Show live health for every account registered on the server",
  },
  args: {
    profile: { type: "string", description: "named profile from ~/.luna/.env (default: stable)" },
    url: { type: "string", description: "UI WebSocket URL" },
    token: { type: "string", description: "UI WebSocket bearer token" },
    json: { type: "boolean", description: "emit JSON instead of a table" },
  },
  async run({ args }) {
    const cfg = resolveAccountsConfig(
      {
        profile: args.profile,
        url: args.url,
        token: args.token,
      },
      process.env,
      homedir(),
      process.cwd(),
    )

    const result = await fetchAccounts(cfg, { json: args.json === true })

    const write = (stream: NodeJS.WriteStream, text: string): Promise<void> =>
      new Promise((resolve) => {
        if (text.length === 0) {
          resolve()
          return
        }
        stream.write(text, () => resolve())
      })

    await write(process.stdout, result.stdout)
    await write(process.stderr, result.stderr)
    process.exit(result.exitCode)
  },
})
