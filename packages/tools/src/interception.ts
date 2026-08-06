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

// ---------------------------------------------------------------------------
// MCP server tool gate (Slice C; unmountable-slug fail-closed fix Slice S11b)
//
// Operator-registered MCP servers (tool prefix `mcp__<slug>__`) are
// DENY-BY-DEFAULT.  A tool call is allowed only when the server's durable
// policy says so - either `allowAll: true` OR the exact tool name appears in
// `allowedTools`.
//
// Built-in servers (memory, local_shell, ...) and OAuth connector servers
// are UNAFFECTED: the gate defers ("pass") whenever `policyLookup` returns
// `undefined` for a slug, which only registered operator servers have. See
// {@link McpServerUnmountable} for the registered-but-broken case.
//
// `policyLookup` is read on EVERY call - the caller is expected to back it
// with a mutable Map so that policy changes (allowTool, allowAllTools,
// mount success/failure) take effect without recomposing the boot-global
// permission callback.
// ---------------------------------------------------------------------------

export interface McpServerPolicy {
  readonly allowAll: boolean
  readonly allowedTools: ReadonlySet<string>
}

/**
 * Registered-but-unmountable marker: the operator enabled+trusted this slug
 * in the durable MCP server store, but the boot-time mount attempt failed
 * (e.g. an unresolved secret-ref), so the server was never registered in
 * the runtime MCPRegistry and has NO tools. The operator's intent for it to
 * run is durable, so an `undefined` policyLookup result (-> "pass", defer)
 * would be the wrong polarity for a security gate: it would let a caller
 * address the broken server's namespace with no opinion from the gate at
 * all (issue #445: unknown-because-broken means DENY, not defer).
 *
 * `reason` is the raw mount-failure detail and is for BOOT LOGGING only -
 * it may echo operator-supplied config text (mount-loader.ts's
 * backward-compat header handling embeds the header's configured value
 * when that value fails to resolve as a secret-ref), which is not safe to
 * put in front of the model or a persisted transcript. The gate's deny
 * message never echoes `reason` verbatim; see `summarizeMountFailure`.
 */
export interface McpServerUnmountable {
  readonly unmountable: true
  readonly reason: string
}

/** One entry {@link mcpToolGate} consults per registered server slug. */
export type McpGateEntry = McpServerPolicy | McpServerUnmountable

/**
 * Bound what a mount-failure reason exposes in a DENY message a model can
 * read (and a transcript can persist): a short classification, plus - only
 * where the source string format guarantees it is a NAME and not a value
 * (a header name, a ref name) - that name. Never a raw header/config value.
 * An unrecognized reason shape falls back to a generic classification
 * rather than being echoed verbatim, since the mount loader may add reason
 * shapes this function does not know about. Exported so every surface that
 * renders a mount-failure reason - the gate's DENY message and the boot
 * warning in chat-server.ts - shares this one redaction, never the raw
 * `reason` string.
 */
export const summarizeMountFailure = (reason: string): string => {
  const header = /^unresolved secret-ref for header '([^']+)'/.exec(reason)
  if (header !== null) return `unresolved secret reference for header '${header[1]}'`
  const template = /^malformed secret-ref template in header '([^']+)'/.exec(reason)
  if (template !== null) {
    return `malformed secret-ref template in header '${template[1]}'`
  }
  const embedded =
    /^unresolved embedded secret-ref '(?:[^']+)' in header '([^']+)'/.exec(reason)
  if (embedded !== null) {
    // The ref text is lifted from the header VALUE - an operator who wrapped
    // a literal credential in ${...} would otherwise see it echoed into the
    // DENY message the model reads. Only the header NAME is safe to surface.
    return `unresolved embedded secret reference in header '${embedded[1]}'`
  }
  if (reason.startsWith("invalid slug")) return "registration rejected (invalid slug)"
  if (reason.startsWith("registry.register() failed")) return "server registration failed"
  return "mount failed (see server boot logs for detail)"
}

/**
 * Fail-closed gate for operator-registered MCP servers. `policyLookup`
 * returns the live entry for a server slug: an allow/deny `McpServerPolicy`
 * for a mounted server, an `McpServerUnmountable` marker for a registered
 * server that failed to mount, or undefined if the slug is NOT an operator-
 * registered MCP server at all (built-ins / connectors -> defer). Reading
 * the lookup per-call is what makes opt-ins (and mount-status changes) take
 * effect without recomposing the boot-global permission callback.
 */
export const mcpToolGate = (
  policyLookup: (slug: string) => McpGateEntry | undefined,
): ToolInterceptor =>
  (toolName, input) =>
    Effect.sync<InterceptorVerdict>(() => {
      // mcp__<slug>__<tool>; slug is [a-z0-9-]+ (no underscores, enforced by
      // the registry), tool may contain underscores.
      const m = /^mcp__([a-z0-9-]+)__(.+)$/.exec(toolName)
      if (m === null) return "pass"
      const slug = m[1]
      const tool = m[2]
      // Both capture groups are guaranteed present when the match succeeds;
      // this guard satisfies noUncheckedIndexedAccess without a non-null assertion.
      if (slug === undefined || tool === undefined) return "pass"
      const entry = policyLookup(slug)
      if (entry === undefined) return "pass" // not an operator MCP server
      if ("unmountable" in entry) {
        return {
          behavior: "deny" as const,
          message:
            `MCP server "${slug}" is registered but failed to mount, so ` +
            `tool "${tool}" is denied (fail-closed) until the mount issue ` +
            `is resolved. Reason: ${summarizeMountFailure(entry.reason)}`,
        }
      }
      const allowed = entry.allowAll || entry.allowedTools.has(tool)
      return allowed
        ? { behavior: "allow" as const, updatedInput: input }
        : {
            behavior: "deny" as const,
            message:
              `MCP tool "${tool}" on server "${slug}" is not permitted. ` +
              `It is registered but this tool is not in its allowlist. ` +
              `Grant it with: luna mcp allow ${slug} ${tool}`,
          }
    })

// ---------------------------------------------------------------------------
// syncMcpMounts() report -> gate entries (Slice S11b)
//
// ONE fold, shared by chat-server.ts (production boot) and mcp-demo.ts (the
// end-to-end demo self-checks), so the two call sites cannot hand-copy this
// logic out of sync with each other. Structural input type only - no
// dependency on @luna/mcp-servers - so it is unit-testable here with a
// plain object literal instead of a stub of the real service.
// ---------------------------------------------------------------------------

/** Structural shape of a `syncMcpMounts()` report (see `@luna/mcp-servers`). */
export interface McpMountReportLike {
  readonly policy: Record<
    string,
    { allowAll: boolean; allowedTools: ReadonlyArray<string> }
  >
  readonly skipped: ReadonlyArray<{ slug: string; reason: string }>
}

/**
 * Fold a `syncMcpMounts()` report into the map {@link mcpToolGate} consults:
 * one `McpServerPolicy` per mounted slug, one `McpServerUnmountable` deny
 * marker per genuinely-unmountable slug.
 *
 * `excludedSlugs` names every slug that must NEVER become a deny marker
 * even though it appears in `skipped`, because the skip does not mean
 * "this server tried and failed to mount":
 *   - a slug colliding with a live connector mount key - that namespace is
 *     not broken, it is actively mounted and served by the connector under
 *     its own path;
 *   - a built-in reserved slug (memory, scheduler, ...) - `syncMcpMounts`
 *     rejects those rows before any mount attempt is made (they can never
 *     be a legitimate operator server), so a "skip" for one is a REJECTED
 *     row, not a failed mount, and denying it would shadow the built-in
 *     server of the same name.
 * Callers build this set from the live connector mount snapshot plus
 * `RESERVED_SLUGS` (both exported by `@luna/mcp-servers`).
 *
 * A skip whose slug fails {@link mcpToolGate}'s own `[a-z0-9-]+` charset
 * (e.g. a hand-edited row with slug "GitHub") still gets a marker here -
 * this fold does not re-validate slug format - but that marker is inert:
 * the gate can never construct a tool name that parses to that slug, so it
 * denies nothing and is not reachable. Every slug the gate CAN address is
 * DENIED when unmountable and not excluded.
 */
export const buildMcpGateEntries = (
  report: McpMountReportLike,
  excludedSlugs: ReadonlySet<string>,
): Map<string, McpGateEntry> => {
  const entries = new Map<string, McpGateEntry>()
  for (const [slug, p] of Object.entries(report.policy)) {
    entries.set(slug, { allowAll: p.allowAll, allowedTools: new Set(p.allowedTools) })
  }
  for (const { slug, reason } of report.skipped) {
    if (excludedSlugs.has(slug)) continue
    entries.set(slug, { unmountable: true, reason })
  }
  return entries
}

// ---------------------------------------------------------------------------
// Live-connector staleness bypass (Slice S11b)
// ---------------------------------------------------------------------------

/**
 * Clear a stale `unmountable` marker for a slug now served by a live
 * connector mount - the marker predates the connector connecting, since
 * `mcpToolPolicyHolder` is only ever rebuilt from the boot-time
 * `syncMcpMounts()` report while a connector can connect after boot. Any
 * other entry - a real `McpServerPolicy` for a server that mounted
 * successfully, or `undefined` for a slug with no entry at all - is
 * returned unchanged: connector liveness must never widen a mounted
 * server's own deny-by-default policy, only defer a marker that no longer
 * reflects reality.
 */
export const clearStaleUnmountableForLiveConnector = (
  entry: McpGateEntry | undefined,
  isLiveConnectorMount: boolean,
): McpGateEntry | undefined => {
  if (entry !== undefined && "unmountable" in entry && isLiveConnectorMount) {
    return undefined
  }
  return entry
}
