/**
 * Egress allowlist interceptor.
 *
 * Guards WebFetch, WebSearch, and network-capable MCP tools against
 * uncontrolled external network access. All other tools receive "pass"
 * immediately — this interceptor only cares about the "egress" effect class.
 *
 * See EGRESS-POLICY.md for the threat model, usage guide, and follow-up notes.
 */
import { Effect } from "effect"
import type { ToolInterceptor, InterceptorVerdict } from "./interception.js"
import { classifyTool, type ToolEffectClass } from "./effect-class.js"

// ─── Public types ─────────────────────────────────────────────────────────────

/** Execution context in which the agent call originates. */
export type PolicySubject = "main-thread" | "subagent" | "background-job"

/** Structured audit record emitted via {@link EgressAllowlistOptions.onDecision}. */
export interface EgressDecision {
  readonly subject: PolicySubject
  readonly tool: string
  readonly effectClass: ToolEffectClass
  readonly target: string | null
  readonly decision: "allow" | "deny"
  readonly rule: string
}

/** Options for {@link egressAllowlist}. */
export interface EgressAllowlistOptions {
  /** Host suffixes that are permitted. Matched case-insensitively. */
  readonly allowedHosts: ReadonlyArray<string>
  /**
   * The execution context of the agent using this interceptor.
   * Subagents and background jobs are denied all egress regardless of host.
   * Defaults to `"main-thread"`.
   */
  readonly subject?: PolicySubject
  /**
   * Called exactly once for every egress-class tool evaluation (both allow and
   * deny outcomes). Not called for non-egress tools (those return "pass"
   * without inspection).
   */
  readonly onDecision?: (d: EgressDecision) => void
}

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * Research-friendly default allow-list for main-thread agents.
 * Override via `LUNA_EGRESS_ALLOWED_HOSTS` (comma-separated host suffixes).
 * Empty env string means "use defaults"; `"*"` means allow all hosts (opt-out).
 */
export const DEFAULT_EGRESS_ALLOWED_HOSTS: ReadonlyArray<string> = [
  "anthropic.com",
  "claude.ai",
  "github.com",
  "githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "npmjs.com",
  "npmjs.org",
  "pypi.org",
  "pythonhosted.org",
  "crates.io",
  "docs.rs",
  "golang.org",
  "pkg.go.dev",
  "stackoverflow.com",
  "stackexchange.com",
  "wikipedia.org",
  "wikimedia.org",
  "google.com",
  "googleapis.com",
  "gstatic.com",
  "cloudflare.com",
  "mozilla.org",
  "mdn.io",
  "nodejs.org",
  "deno.land",
  "bun.sh",
  "openai.com",
  "x.ai",
]

/**
 * Parse `LUNA_EGRESS_ALLOWED_HOSTS` (comma-separated host suffixes).
 * - unset / empty / whitespace → {@link DEFAULT_EGRESS_ALLOWED_HOSTS}
 * - `"*"` → empty allow-list with a sentinel handled by {@link egressAllowlist}
 *   as allow-all (operator opt-out); returned as `["*"]`
 * - otherwise → trimmed non-empty entries (no defaults mixed in)
 */
export const parseEgressAllowedHosts = (
  raw: string | undefined | null,
): ReadonlyArray<string> => {
  if (raw === undefined || raw === null) return DEFAULT_EGRESS_ALLOWED_HOSTS
  const trimmed = raw.trim()
  if (trimmed.length === 0) return DEFAULT_EGRESS_ALLOWED_HOSTS
  if (trimmed === "*") return ["*"]
  const parts = trimmed
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
  return parts.length > 0 ? parts : DEFAULT_EGRESS_ALLOWED_HOSTS
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true when `host` matches one of the allowed host suffixes.
 * An entry "example.com" permits "example.com" and "api.example.com" but not
 * "notexample.com". `"*"` as a sole allow-list entry means allow all.
 */
const hostAllowed = (
  host: string,
  allowedHosts: ReadonlyArray<string>,
): boolean => {
  if (allowedHosts.length === 1 && allowedHosts[0] === "*") return true
  const h = host.toLowerCase()
  return allowedHosts.some((entry) => {
    const lower = entry.toLowerCase()
    return h === lower || h.endsWith("." + lower)
  })
}

/** Common input keys network tools use for a URL or host. */
const URL_INPUT_KEYS = [
  "url",
  "uri",
  "href",
  "endpoint",
  "baseUrl",
  "base_url",
  "host",
  "hostname",
] as const

/**
 * Best-effort host extraction from a tool input bag. Used for MCP egress
 * tools that are not WebFetch/WebSearch. Returns null when no usable target
 * is present (fail-closed at the call site).
 */
export const extractEgressTargetHost = (
  input: Record<string, unknown>,
): string | null => {
  for (const key of URL_INPUT_KEYS) {
    const raw = input[key]
    if (typeof raw !== "string" || raw.trim().length === 0) continue
    const s = raw.trim()
    // Bare hostname (no scheme).
    if (!s.includes("://") && !s.includes("/") && s.includes(".")) {
      return s.toLowerCase().replace(/\.$/, "")
    }
    try {
      const withScheme = s.includes("://") ? s : `https://${s}`
      const host = new URL(withScheme).hostname.toLowerCase()
      if (host.length > 0) return host
    } catch {
      /* try next key */
    }
  }
  return null
}

// ─── Interceptor factory ──────────────────────────────────────────────────────

/**
 * Build a {@link ToolInterceptor} that enforces an egress allowlist.
 *
 * Placement: add early in the `composeInterceptors` list so it runs before
 * any later interceptors that might accidentally allow an egress tool.
 *
 * ```ts
 * const interceptors = composeInterceptors([
 *   egressAllowlist({ allowedHosts: ["github.com", "api.anthropic.com"] }),
 *   denySecretPaths(),
 * ])
 * ```
 */
export const egressAllowlist = (
  opts: EgressAllowlistOptions,
): ToolInterceptor => {
  const subject: PolicySubject = opts.subject ?? "main-thread"

  return (toolName, input) =>
    Effect.sync<InterceptorVerdict>(() => {
      const effectClass = classifyTool(toolName)

      // Non-egress tools are out of scope — return pass without auditing.
      if (effectClass !== "egress") return "pass"

      // Helper: build + emit + return a deny verdict.
      const deny = (
        rule: string,
        target: string | null,
        message: string,
      ): InterceptorVerdict => {
        const d: EgressDecision = {
          subject,
          tool: toolName,
          effectClass,
          target,
          decision: "deny",
          rule,
        }
        opts.onDecision?.(d)
        return { behavior: "deny", message }
      }

      // Helper: build + emit + return an allow verdict.
      const allow = (
        rule: string,
        target: string | null,
      ): InterceptorVerdict => {
        const d: EgressDecision = {
          subject,
          tool: toolName,
          effectClass,
          target,
          decision: "allow",
          rule,
        }
        opts.onDecision?.(d)
        return { behavior: "allow", updatedInput: input }
      }

      // Subagents and background jobs get no egress, regardless of host.
      if (subject === "subagent" || subject === "background-job") {
        return deny(
          "subject-no-egress",
          null,
          `egress denied: subject "${subject}" may not reach the network (tool-acl)`,
        )
      }

      // ── WebFetch ──────────────────────────────────────────────────────────
      if (toolName === "WebFetch") {
        const rawUrl = input["url"]
        if (typeof rawUrl !== "string" || rawUrl.length === 0) {
          return deny(
            "egress-no-target",
            null,
            "egress denied: WebFetch requires a non-empty url string (tool-acl)",
          )
        }
        let parsed: URL
        try {
          parsed = new URL(rawUrl)
        } catch {
          return deny(
            "egress-no-target",
            null,
            "egress denied: WebFetch url could not be parsed (tool-acl)",
          )
        }
        const host = parsed.hostname.toLowerCase()
        if (hostAllowed(host, opts.allowedHosts)) {
          return allow("host-allowlisted", host)
        }
        return deny(
          "host-not-allowlisted",
          host,
          `egress denied: host "${host}" is not allow-listed (tool-acl)`,
        )
      }

      // ── WebSearch ─────────────────────────────────────────────────────────
      if (toolName === "WebSearch") {
        const rawDomains = input["allowed_domains"]
        const isValidDomainArray =
          Array.isArray(rawDomains) &&
          rawDomains.length > 0 &&
          rawDomains.every((d): d is string => typeof d === "string")

        const requestedTarget: string | null = isValidDomainArray
          ? (rawDomains as ReadonlyArray<string>).join(",")
          : null

        if (
          isValidDomainArray &&
          (rawDomains as ReadonlyArray<string>).every((d) =>
            hostAllowed(d, opts.allowedHosts),
          )
        ) {
          return allow(
            "search-domains-allowlisted",
            (rawDomains as ReadonlyArray<string>).join(","),
          )
        }

        return deny(
          "search-domains-not-allowlisted",
          requestedTarget,
          "egress denied: WebSearch requires a non-empty allowed_domains array " +
            "where every entry is an allow-listed host (tool-acl)",
        )
      }

      // ── Generic / MCP egress tools ───────────────────────────────────────
      // Network-classified MCP tools (and any future egress verb): require a
      // host-bearing input key and allow-list match. Fail closed when the
      // target cannot be extracted.
      const host = extractEgressTargetHost(input)
      if (host === null) {
        return deny(
          "egress-no-target",
          null,
          `egress denied: tool "${toolName}" is egress-class but has no ` +
            "url/host argument to evaluate (tool-acl)",
        )
      }
      if (hostAllowed(host, opts.allowedHosts)) {
        return allow("host-allowlisted", host)
      }
      return deny(
        "host-not-allowlisted",
        host,
        `egress denied: host "${host}" is not allow-listed (tool-acl)`,
      )
    })
}

// ─── PreToolUse hook (covers auto-approved MCP tools) ─────────────────────────

/**
 * Minimal shape of the SDK PreToolUse hook input we need. Typed loosely so
 * `@luna/tools` does not depend on the Agent SDK package (hooks live in
 * adapter-sdk / chat-server).
 */
export interface PreToolUseHookInputLike {
  readonly hook_event_name?: string
  readonly tool_name?: string
  readonly tool_input?: unknown
}

/**
 * Build a PreToolUse hook callback that applies the same egress allowlist as
 * {@link egressAllowlist}. Auto-approved `mcp__*` tools skip `canUseTool`;
 * PreToolUse still runs on every call (including under bypassPermissions
 * when the adapter registers hooks). Only **deny** decisions rewrite the
 * hook output; allow/pass leave the call undisturbed.
 *
 * Return type is intentionally untyped JSON (compatible with SDK
 * `HookJSONOutput`) so this package stays SDK-free.
 */
export const makeEgressPreToolUseHook = (
  opts: EgressAllowlistOptions,
): ((
  input: PreToolUseHookInputLike,
  _toolUseId?: string,
  _options?: { signal?: AbortSignal },
) => Promise<Record<string, unknown>>) => {
  const interceptor = egressAllowlist(opts)
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {}
    const toolName = typeof input.tool_name === "string" ? input.tool_name : ""
    if (toolName.length === 0) return {}
    const toolInput =
      input.tool_input !== null &&
      typeof input.tool_input === "object" &&
      !Array.isArray(input.tool_input)
        ? (input.tool_input as Record<string, unknown>)
        : {}
    const verdict = Effect.runSync(interceptor(toolName, toolInput))
    if (verdict === "pass") return {}
    if (verdict.behavior === "deny") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: verdict.message,
        },
      }
    }
    // allow: do not force permissionDecision — auto-approved tools already
    // proceed; returning empty keeps PreToolUse side-effect free on allow.
    return {}
  }
}
