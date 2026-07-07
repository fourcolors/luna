/**
 * Egress allowlist interceptor.
 *
 * Guards WebFetch and WebSearch against uncontrolled external network access.
 * All other tools receive "pass" immediately — this interceptor only cares
 * about the "egress" effect class.
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true when `host` matches one of the allowed host suffixes.
 * An entry "example.com" permits "example.com" and "api.example.com" but not
 * "notexample.com".
 */
const hostAllowed = (
  host: string,
  allowedHosts: ReadonlyArray<string>,
): boolean => {
  const h = host.toLowerCase()
  return allowedHosts.some((entry) => {
    const lower = entry.toLowerCase()
    return h === lower || h.endsWith("." + lower)
  })
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

      // Unrecognised egress tool — fail closed.
      return deny(
        "egress-no-target",
        null,
        `egress denied: unrecognised egress tool "${toolName}" (tool-acl)`,
      )
    })
}
