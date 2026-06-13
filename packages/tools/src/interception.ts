/**
 * Tool interception ("Override Tools" per DESIGN.md §2.1.4).
 *
 * The SDK exposes a single `canUseTool` callback; DESIGN.md §12.2 #4
 * names this the permission choke point. We model the tool-policy
 * surface as a COMPOSED list of small interceptors, each returning
 * either a PermissionResult or the sentinel "pass" (no opinion).
 * `composeInterceptors` collapses the list into the exact shape
 * `SDKAdapter.setPermissionCallback` expects.
 *
 * The first interceptor that returns a non-"pass" result wins —
 * later interceptors are not consulted. This mirrors a standard
 * middleware chain and is explicitly asserted in the eval-order test.
 *
 * Default (all interceptors return "pass"): allow with unchanged input.
 */
import { Effect } from "effect"
import type { PermissionResult } from "@luna/adapter-sdk"

/** Interceptor verdict: concrete `PermissionResult`, or "pass" to defer. */
export type InterceptorVerdict = PermissionResult | "pass"

export type ToolInterceptor = (
  toolName: string,
  input: Record<string, unknown>,
) => Effect.Effect<InterceptorVerdict, never>

/**
 * Compose N interceptors in order. First non-"pass" result wins.
 * When all interceptors pass, the default is
 * `{ behavior: "allow", updatedInput: input }`.
 */
export const composeInterceptors = (
  interceptors: ReadonlyArray<ToolInterceptor>,
): ((
  toolName: string,
  input: Record<string, unknown>,
) => Effect.Effect<PermissionResult, never>) => {
  return (toolName, input) =>
    Effect.gen(function* () {
      for (const i of interceptors) {
        const verdict = yield* i(toolName, input)
        if (verdict !== "pass") return verdict
      }
      return {
        behavior: "allow" as const,
        updatedInput: input,
      } satisfies PermissionResult
    })
}

/** Deny a fixed set of tool names; pass on everything else. */
export const denyByName = (
  names: ReadonlyArray<string>,
  message = "denied by policy",
): ToolInterceptor => {
  const set = new Set(names)
  return (toolName) =>
    Effect.succeed<InterceptorVerdict>(
      set.has(toolName)
        ? { behavior: "deny", message }
        : "pass",
    )
}

/** Allow a fixed set of tool names; pass on everything else. */
export const allowByName = (
  names: ReadonlyArray<string>,
): ToolInterceptor => {
  const set = new Set(names)
  return (toolName, input) =>
    Effect.succeed<InterceptorVerdict>(
      set.has(toolName)
        ? { behavior: "allow", updatedInput: input }
        : "pass",
    )
}

/**
 * For the named tools, strip the listed keys from input before
 * allowing. On non-matching tools: pass.
 */
export const redactInput = (
  names: ReadonlyArray<string>,
  keys: ReadonlyArray<string>,
): ToolInterceptor => {
  const nameSet = new Set(names)
  const keySet = new Set(keys)
  return (toolName, input) =>
    Effect.sync<InterceptorVerdict>(() => {
      if (!nameSet.has(toolName)) return "pass"
      const redacted: Record<string, unknown> = {}
      for (const k of Object.keys(input)) {
        if (!keySet.has(k)) redacted[k] = input[k]
      }
      return { behavior: "allow", updatedInput: redacted }
    })
}

/* -------------------------------------------------------------------------- */
/* Safety rails                                                               */
/*                                                                            */
/* Luna agents run with the research/fix built-ins available (WebFetch,       */
/* Read/Edit/Write, …). These interceptors are the DENY half of a            */
/* default-allow policy: they stop the obvious catastrophic mistake so the    */
/* agent can otherwise work without stalling on a permission prompt.          */
/*                                                                            */
/* denySecretPaths gates the granted FILE built-ins (Read/Edit/Write) — the   */
/* active rail. denyDangerousCommands gates shell-type tools by command       */
/* string and is DEFENSE-IN-DEPTH: Luna's agents run shell through the        */
/* pre-approved, separately-sandboxed `mcp__local_shell__*`, not a raw built- */
/* in, so today nothing routes through it; it stays ready for any future      */
/* shell built-in.                                                            */
/*                                                                            */
/* IMPORTANT: pattern matching on shell strings / paths is BEST-EFFORT, not   */
/* a sandbox. A determined or obfuscating caller can evade it, and it does    */
/* NOT cover web egress (WebFetch/WebSearch). The rails are the in-code       */
/* equivalent of the deny rules an operator sets in Claude Code settings.json */
/* — a guard against accidents, not a security boundary. For true confinement */
/* use the sandboxed `mcp__local_shell__*` path.                              */
/* -------------------------------------------------------------------------- */

/** Does the command carry a flag, by short letter (`-r`) or long name? */
const hasShortOrLongFlag = (
  cmd: string,
  shortLetter: string,
  longName: string,
): boolean =>
  new RegExp(`\\s-\\w*${shortLetter}`, "i").test(cmd) ||
  new RegExp(`--${longName}\\b`, "i").test(cmd)

/**
 * `rm` invoked AS a command — at the start, after a shell separator
 * (`;` `|` `&` newline), behind a leading wrapper (sudo/xargs/time/nohup), or
 * as the body of a `find … -exec` / `for … do` construct. This avoids flagging
 * `rm -rf` merely MENTIONED inside a quoted string or argument (e.g.
 * `echo 'rm -rf'`, a `git commit -m "… rm -rf …"` message) while still
 * catching `find … -exec rm -rf {} +` and `for f in *; do rm -rf "$f"; done`,
 * the most common ways an agent actually emits a recursive delete.
 */
const RM_AS_COMMAND =
  /(?:^|[\n;|&]|\bsudo\b|\bxargs\b|\btime\b|\bnohup\b|-exec\b|\bdo\b)\s*rm\b/i

/** `rm` (in command position) with both recursive AND force flags. */
const isDestructiveRm = (cmd: string): boolean =>
  RM_AS_COMMAND.test(cmd) &&
  hasShortOrLongFlag(cmd, "r", "recursive") &&
  hasShortOrLongFlag(cmd, "f", "force")

/**
 * Extra destructive-command matchers beyond `rm -rf` (filesystem format,
 * raw-device overwrite, fork bomb). Extend per deployment if needed.
 */
export const DEFAULT_DESTRUCTIVE_COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  /\bmkfs(\.\w+)?\b/i, // format a filesystem
  /\bdd\b[^\n]*\bof=\/dev\/[a-z]/i, // overwrite a block device
  />\s*\/dev\/(?:sd|nvme|hd|disk)\w*/i, // redirect over a raw disk
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;\s*:/, // classic fork bomb
]

/**
 * Deny destructive shell commands. Inspects the `command` field of the named
 * tools (default: built-in `Bash`) against `rm -rf` and
 * {@link DEFAULT_DESTRUCTIVE_COMMAND_PATTERNS}. Pass on everything else.
 */
export const denyDangerousCommands = (
  toolNames: ReadonlyArray<string> = ["Bash"],
  extraPatterns: ReadonlyArray<RegExp> = DEFAULT_DESTRUCTIVE_COMMAND_PATTERNS,
  message = "blocked by Luna safety rail (destructive command)",
): ToolInterceptor => {
  const nameSet = new Set(toolNames)
  return (toolName, input) =>
    Effect.sync<InterceptorVerdict>(() => {
      if (!nameSet.has(toolName)) return "pass"
      const cmd =
        typeof input["command"] === "string" ? (input["command"] as string) : ""
      if (cmd === "") return "pass"
      const dangerous =
        isDestructiveRm(cmd) || extraPatterns.some((re) => re.test(cmd))
      return dangerous ? { behavior: "deny", message } : "pass"
    })
}

/**
 * Path matchers for secret/credential files: `.env*`, a `secrets/` directory,
 * SSH private keys, and `.pem` files. Anchored so `.environment` and the like
 * do not trip them.
 */
export const DEFAULT_SECRET_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|\/)\.env(?:\.[^/]*)?$/i, // .env, .env.local, a/b/.env.production
  /(?:^|\/)secrets?\//i, // a secrets/ (or secret/) directory
  /(?:^|\/)\.aws\/credentials$/i, // AWS access keys
  /(?:^|\/)\.(?:netrc|npmrc|git-credentials)$/i, // plaintext creds/tokens
  /(?:^|\/)id_(?:rsa|dsa|ed25519|ecdsa)(?:\.pub)?$/i, // ssh keys
  /(?:^|\/)authorized_keys$/i, // ssh authorized_keys
  /(?:^|\/)credentials\.json$/i, // service-account / oauth creds
  /\.(?:pem|key)$/i, // PEM / private-key files
]

/**
 * Deny reads/writes of secret-bearing paths. Inspects the `file_path` (or
 * `path`) field of the named file tools against
 * {@link DEFAULT_SECRET_PATH_PATTERNS}. Pass on everything else.
 */
export const denySecretPaths = (
  toolNames: ReadonlyArray<string> = [
    "Read",
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
  ],
  pathPatterns: ReadonlyArray<RegExp> = DEFAULT_SECRET_PATH_PATTERNS,
  message = "blocked by Luna safety rail (secret/credential path)",
): ToolInterceptor => {
  const nameSet = new Set(toolNames)
  return (toolName, input) =>
    Effect.sync<InterceptorVerdict>(() => {
      if (!nameSet.has(toolName)) return "pass"
      const candidate =
        typeof input["file_path"] === "string"
          ? (input["file_path"] as string)
          : typeof input["path"] === "string"
            ? (input["path"] as string)
            : ""
      if (candidate === "") return "pass"
      return pathPatterns.some((re) => re.test(candidate))
        ? { behavior: "deny", message }
        : "pass"
    })
}

/**
 * Luna's default agent safety rails: a default-allow policy with
 * destructive-command and secret-path denials. Compose and install via
 * `SDKAdapter.setPermissionCallback(composeInterceptors(defaultSafetyInterceptors()))`.
 */
export const defaultSafetyInterceptors = (): ReadonlyArray<ToolInterceptor> => [
  denyDangerousCommands(),
  denySecretPaths(),
]
