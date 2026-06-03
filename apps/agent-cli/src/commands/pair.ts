import { createReadStream, createWriteStream, openSync } from "node:fs"
import { homedir } from "node:os"
import { createInterface } from "node:readline/promises"
import { defineCommand } from "citty"
import {
  isValidProfileName,
  normalizeProfileName,
  profileEnvPrefix,
} from "../chat/config.js"
import { upsertEnv, writeMoonConnection } from "../chat/pair-writers.js"
import {
  type ProbeOutcomes,
  redactUrl,
  renderVerdicts,
  resolveDoctorConfig,
  runDoctorProbes,
} from "./doctor.js"

/**
 * `luna pair` — one command to point BOTH Mac clients (the `luna` CLI and the
 * Moon widget) at a remote Luna server and verify the connection.
 *
 * It writes TWO config files, each holding the secret WS token at mode 0600:
 *   1. ~/.luna/.env — LUNA_<PROFILE>_WS_URL + LUNA_<PROFILE>_UI_WS_TOKEN, using
 *      the SAME profile→env-key mapping `luna chat`/`luna doctor` read, so the
 *      paired connection IS what those commands use. (Keys come from config.ts's
 *      profileEnvPrefix — never hardcoded here.)
 *   2. ~/.luna/moon-connection.json — {"wsUrl","wsToken"} (camelCase) byte-
 *      matching what Moon's Rust save_connection/load_connection use.
 *
 * After writing, it VERIFIES by running the doctor probe against the just-paired
 * profile and prints WHICH layer (if any) failed — so a bad pairing surfaces
 * immediately, not on next chat. Pairing (the write) is config, not a live
 * connection: a verify FAILURE never undoes the write and never throws — it is
 * reported. Re-running with a new token cleanly overwrites both files (token-
 * rotation recovery).
 *
 * The token is NEVER printed in full: confirmation lines redact it to its first
 * 6 chars + "…". The doctor verify output already redacts the URL query string.
 */

export const DEFAULT_PAIR_PROFILE = "stable"

/** Pure: a ws(s):// URL pointing at host[:port]/ui (the UI WebSocket path). */
export const isValidPairUrl = (raw: string): boolean => {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return false
  if (u.hostname.length === 0) return false
  // Require the /ui path (the UI WebSocket endpoint luna chat connects to).
  // Tolerate an optional trailing slash but nothing deeper.
  const path = u.pathname.replace(/\/$/, "")
  return path === "/ui"
}

/** Pure: redact a secret token for display — first 6 chars + "…" (or "…" if short). */
export const redactToken = (token: string): string => {
  const t = token.trim()
  if (t.length === 0) return "(empty)"
  if (t.length <= 6) return "…"
  return `${t.slice(0, 6)}…`
}

/**
 * Prompt for a single value on the controlling TTY (mirrors approveLocalCommand
 * in luna.ts). `secret` only affects nothing on-screen here (readline has no
 * portable masking); callers redact the value in any echo afterwards. Returns
 * the trimmed answer, or "" if no TTY is available.
 */
const promptTty = async (question: string): Promise<string> => {
  let input: ReturnType<typeof createReadStream> | undefined
  let output: ReturnType<typeof createWriteStream> | undefined
  try {
    input = createReadStream("", { fd: openSync("/dev/tty", "r"), autoClose: true })
    output = createWriteStream("", { fd: openSync("/dev/tty", "w"), autoClose: true })
    const rl = createInterface({ input, output })
    try {
      const answer = await rl.question(question)
      return answer.trim()
    } finally {
      rl.close()
    }
  } catch {
    return ""
  } finally {
    input?.destroy()
    output?.end()
  }
}

export interface PairInput {
  readonly url?: string
  readonly token?: string
  readonly profile?: string
  /**
   * When true, ALSO switch the Moon's active channel to the just-paired profile
   * (writes moon-connection.json's activeProfile). Off by default so pairing
   * `dev` never hijacks a running `stable` Moon — the user switches channels in
   * the Moon's Settings. (A first-ever pairing always activates regardless,
   * since there is no prior active channel to preserve.)
   */
  readonly activate?: boolean
}

export interface PairResult {
  readonly lines: ReadonlyArray<string>
  readonly exitCode: number
}

/**
 * The verify step, injected so unit tests can stub it (the task requires verify
 * be skippable without a live server). Default = the real doctor probe against
 * the just-paired profile.
 */
export type PairVerify = (input: {
  readonly profileName: string
  readonly homeDir: string
  readonly cwd: string
  readonly env: Record<string, string | undefined>
}) => Promise<{
  readonly lines: ReadonlyArray<string>
  /**
   * True only when the server actively REJECTED the token (WS upgrade 401) —
   * i.e. the PAIRING ITSELF is wrong, not merely "server not up yet". This is
   * what drives pair's exit code: a wrong token must fail loudly; a correct
   * pairing against a down/slow server is still a successful pairing (exit 0).
   */
  readonly tokenRejected: boolean
}>

const defaultVerify: PairVerify = async ({ profileName, homeDir, cwd, env }) => {
  // Reuse the EXACT resolver + probes + renderer doctor uses, against the
  // profile we just wrote — so the verdict reflects the paired connection.
  const cfg = resolveDoctorConfig({ profile: profileName }, env, homeDir, cwd)
  let outcomes: ProbeOutcomes
  try {
    outcomes = await runDoctorProbes(cfg)
  } catch (e) {
    // A verify that throws must NOT crash pairing — the write already
    // succeeded. Surface the error as a soft note; not a token rejection.
    const detail = e instanceof Error ? e.message : String(e)
    return { lines: [`verify error: ${detail}`], tokenRejected: false }
  }
  const report = renderVerdicts(outcomes, { profileName: cfg.profileName, url: cfg.url })
  return { lines: report.lines, tokenRejected: outcomes.token?.kind === "rejected" }
}

/**
 * Core of `luna pair`: validate, write both config files, then verify. Pure of
 * stdout/TTY — it RETURNS lines + an exit code so it is testable. The caller
 * (the citty command) does the interactive prompting and the printing.
 *
 * Exit-code policy: a validation failure (bad url / empty token) returns exit 2
 * WITHOUT writing anything. A successful write returns the VERIFY's exit code
 * (0 if the connection is healthy, 1 if a layer failed) — the files are written
 * either way, since pairing is config and the verify is informational.
 */
export const runPair = async (
  input: Required<Pick<PairInput, "url" | "token">> & {
    readonly profile?: string
    readonly activate?: boolean
  },
  deps: {
    readonly homeDir: string
    readonly cwd: string
    readonly env: Record<string, string | undefined>
    readonly verify?: PairVerify
  },
): Promise<PairResult> => {
  const lines: string[] = []
  const url = input.url.trim()
  const token = input.token.trim()

  const profileRaw = input.profile ?? DEFAULT_PAIR_PROFILE
  if (!isValidProfileName(profileRaw)) {
    return {
      lines: [
        `invalid --profile '${profileRaw}': must start with a letter and contain only letters, numbers, hyphens, or underscores`,
      ],
      exitCode: 2,
    }
  }
  const profileName = normalizeProfileName(profileRaw)

  if (!isValidPairUrl(url)) {
    return {
      lines: [
        `invalid --url '${url}': expected a WebSocket URL like ws(s)://host[:port]/ui`,
      ],
      exitCode: 2,
    }
  }
  if (token.length === 0) {
    return { lines: ["invalid --token: token must not be empty"], exitCode: 2 }
  }

  // Resolve the per-profile env keys from the SAME mapping loadChatConfig reads.
  const prefix = profileEnvPrefix(profileName)
  const urlKey = `${prefix}_WS_URL`
  const tokenKey = `${prefix}_UI_WS_TOKEN`

  // Write both client configs (atomic, mode 0600). Idempotent: a re-run with a
  // new token cleanly overwrites the profile's slot (rotation recovery). The
  // Moon writer writes into profiles.<profileName>, PRESERVING other channels'
  // creds and migrating a legacy flat file first.
  upsertEnv(deps.homeDir, urlKey, url)
  upsertEnv(deps.homeDir, tokenKey, token)
  const activate = input.activate === true
  writeMoonConnection(deps.homeDir, url, token, { profile: profileName, activate })

  // Redact any ?token= in the displayed URL (a user could pass the token in the
  // url query form). Same leak class already fixed in doctor's output.
  lines.push(`paired profile '${profileName}' → ${redactUrl(url)}`)
  lines.push(`  token: ${redactToken(token)}`)
  lines.push(`  wrote ~/.luna/.env (${urlKey}, ${tokenKey})`)
  lines.push(`  wrote ~/.luna/moon-connection.json (profiles.${profileName})`)
  if (activate) {
    lines.push(`  set the Moon's active channel to '${profileName}'`)
  } else {
    lines.push(
      `  (did not change the Moon's active channel — switch to '${profileName}' in the Moon's Settings, or re-run with --activate)`,
    )
  }
  lines.push("")
  lines.push("verifying connection…")

  const verify = deps.verify ?? defaultVerify
  const report = await verify({
    profileName,
    homeDir: deps.homeDir,
    cwd: deps.cwd,
    env: deps.env,
  })
  for (const l of report.lines) lines.push(l)

  // Exit-code policy: pairing is CONFIG, and both files were written above, so
  // a successful write is a successful pair — exit 0 — EVEN if the server is
  // down or slow right now (you can pair before starting the server). The ONE
  // exception is an actively REJECTED token: that means the pairing itself is
  // wrong, so fail non-zero and tell the user. (Validation failures returned
  // exit 2 earlier and never reach here.)
  lines.push("")
  if (report.tokenRejected) {
    lines.push("✗ paired, but the server REJECTED this token — double-check the token and re-run `luna pair`.")
    return { lines, exitCode: 1 }
  }
  lines.push("✓ paired. `luna chat` and the Luna Moon widget will use this server.")
  return { lines, exitCode: 0 }
}

export const pairCommand = defineCommand({
  meta: {
    name: "pair",
    description:
      "Point both Luna clients (CLI + Moon) at a remote server and verify: writes ~/.luna/.env and ~/.luna/moon-connection.json, then runs the doctor preflight",
  },
  args: {
    url: { type: "string", description: "UI WebSocket URL, e.g. wss://host:4753/ui" },
    token: { type: "string", description: "UI WebSocket bearer token" },
    profile: {
      type: "string",
      description: `named profile to write into ~/.luna/.env (default: ${DEFAULT_PAIR_PROFILE})`,
    },
    activate: {
      type: "boolean",
      description:
        "also switch the Moon's active channel to the just-paired profile (default: false — pairing does not hijack the running Moon's channel)",
    },
  },
  async run({ args }) {
    // Interactive fill-in for any missing value (scriptable when both passed).
    let url = (args.url ?? "").trim()
    if (url.length === 0) {
      url = await promptTty("Server WebSocket URL (ws(s)://host[:port]/ui): ")
    }
    let token = (args.token ?? "").trim()
    if (token.length === 0) {
      token = await promptTty("Server WS token: ")
    }

    const result = await runPair(
      { url, token, profile: args.profile, activate: args.activate === true },
      { homeDir: homedir(), cwd: process.cwd(), env: process.env },
    )

    const output = result.lines.map((l) => `${l}\n`).join("")
    await new Promise<void>((resolve) => {
      process.stdout.write(output, () => resolve())
    })
    process.exit(result.exitCode)
  },
})
