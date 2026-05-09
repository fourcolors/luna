#!/usr/bin/env bun
/**
 * `luna-account` — seed CLI for the §5.1 `accounts` table.
 *
 * Subcommands:
 *   add  --id <id> --label <label> --kind <kind> --secret-ref <ref>
 *   list
 *   rm   --id <id>
 *
 * Options (all subcommands):
 *   --db-path <path>        override the default ~/.luna/luna.db
 *                           (also reads $LUNA_DB_PATH)
 *
 * Exit codes:
 *   0  success
 *   1  user error (validation failure, "no such account", "already exists")
 *   2  system error (db open / sqlite failure / unknown subcommand)
 *
 * Hot-reload note: AccountBroker hydrates once at Layer construction. CLI
 * inserts will NOT appear in a running chat-server until you restart
 * it. (See `apps/ui-web/scripts/chat-server.ts` header.)
 */
import { runAdd } from "./commands/add.js"
import { runList } from "./commands/list.js"
import { runRm } from "./commands/rm.js"

interface ParsedFlags {
  flags: Record<string, string>
  unknown: string[]
}

const FLAG_ALIAS: Record<string, string> = {
  "--id": "id",
  "--label": "label",
  "--kind": "kind",
  "--secret-ref": "secretRef",
  "--db-path": "dbPath",
}

const parseFlags = (argv: ReadonlyArray<string>): ParsedFlags => {
  const flags: Record<string, string> = {}
  const unknown: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] as string
    if (!tok.startsWith("--")) {
      unknown.push(tok)
      continue
    }
    // Support `--id=value` as well as `--id value`.
    let key: string
    let value: string | undefined
    const eq = tok.indexOf("=")
    if (eq > 0) {
      key = tok.slice(0, eq)
      value = tok.slice(eq + 1)
    } else {
      key = tok
      value = argv[i + 1]
      i++
    }
    const alias = FLAG_ALIAS[key]
    if (alias === undefined) {
      unknown.push(key)
      continue
    }
    if (value === undefined) {
      flags[alias] = ""
    } else {
      flags[alias] = value
    }
  }
  return { flags, unknown }
}

const HELP = `\
usage: luna-account <subcommand> [options]

subcommands:
  add   --id <id> --label <label> --kind <kind> --secret-ref <ref>
        kind ∈ { anthropic, tool-<name>, mcp-<name> }
        secret-ref must start with op://, env://, or file://
  list
  rm    --id <id>

common options:
  --db-path <path>   override default ~/.luna/luna.db (or set $LUNA_DB_PATH)
`

export interface RunResult {
  exitCode: 0 | 1 | 2
  stdout: string
  stderr: string
}

/** Pure entry — used by tests. Returns the result instead of exiting. */
export const runCli = (argv: ReadonlyArray<string>): RunResult => {
  const sub = argv[0]
  if (sub === undefined || sub === "-h" || sub === "--help") {
    return { exitCode: sub === undefined ? 2 : 0, stdout: HELP, stderr: "" }
  }
  const rest = argv.slice(1)
  const { flags, unknown } = parseFlags(rest)
  if (unknown.length > 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `error: unknown argument(s): ${unknown.join(", ")}\n`,
    }
  }
  switch (sub) {
    case "add": {
      const r = runAdd({
        ...(flags["id"] !== undefined ? { id: flags["id"] } : {}),
        ...(flags["label"] !== undefined ? { label: flags["label"] } : {}),
        ...(flags["kind"] !== undefined ? { kind: flags["kind"] } : {}),
        ...(flags["secretRef"] !== undefined
          ? { secretRef: flags["secretRef"] }
          : {}),
        ...(flags["dbPath"] !== undefined ? { dbPath: flags["dbPath"] } : {}),
      })
      return {
        exitCode: r.exitCode,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      }
    }
    case "list": {
      const r = runList(
        flags["dbPath"] !== undefined ? { dbPath: flags["dbPath"] } : {},
      )
      return {
        exitCode: r.exitCode,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      }
    }
    case "rm": {
      const r = runRm({
        ...(flags["id"] !== undefined ? { id: flags["id"] } : {}),
        ...(flags["dbPath"] !== undefined ? { dbPath: flags["dbPath"] } : {}),
      })
      return {
        exitCode: r.exitCode,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      }
    }
    default:
      return {
        exitCode: 2,
        stdout: "",
        stderr: `error: unknown subcommand "${sub}"\n${HELP}`,
      }
  }
}

// Direct execution: `bun run src/index.ts <args...>`.
// Detect via import.meta.main (bun) so the test can `import { runCli }`
// without triggering process.exit.
const isMain = (import.meta as { main?: boolean }).main === true
if (isMain) {
  const result = runCli(process.argv.slice(2))
  if (result.stdout.length > 0) process.stdout.write(result.stdout)
  if (result.stderr.length > 0) process.stderr.write(result.stderr)
  process.exit(result.exitCode)
}
