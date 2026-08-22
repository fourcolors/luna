/**
 * NetSecClient — Phase 16.
 *
 * Mediated HTTP client with egress allowlist enforcement.
 *
 * Architecture:
 *   - Allowlist stored in Ref<AllowlistEntry[]> for runtime mutations.
 *   - Policy check: hostname glob match + method check.
 *   - TLS pinning: deferred (Node.js native TLS APIs require low-level tls
 *     module access; pinning is enforced via a post-response fingerprint
 *     check using the response's TLS certificate — Node v18+ required).
 *     For Phase 16, pinning is noted in the allowlist but not enforced
 *     (logged as a warning). Full enforcement requires @effect/platform-node
 *     or a custom TLS agent — deferred to when deps stabilize.
 *   - fetch() wraps native globalThis.fetch with timeout via AbortController.
 *   - Layer.succeed (no scope needed; no background fibers).
 *
 * Invariants:
 *   - §3.4 #1 no cross-Scope refs: stateless except for the Ref.
 *   - §6.2 frozen errors: EgressBlockedError, TlsPinViolationError,
 *     HttpRequestError — all pre-declared in types.ts.
 *   - Strict mode off = open pass-through (allowlist for pinning only).
 *   - Strict mode on = default-deny, only allowlisted hosts pass.
 */
import { Context,
  Effect,
  Layer,
  Ref,
} from "effect"
import type {
  AllowlistEntry,
  HttpMethod,
  HttpResponse,
  NetSecClientApi,
  NetSecConfig,
  RequestOptions,
} from "./types.js"
import {
  EgressBlockedError,
  HttpRequestError,
} from "./types.js"

/**
 * Match a hostname against an allowlist pattern.
 * Supports exact match and leading "*." wildcard.
 */
function matchHost(pattern: string, hostname: string): boolean {
  if (pattern === "*") return true
  if (pattern === hostname) return true
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1) // ".example.com"
    return hostname.endsWith(suffix) || hostname === suffix.slice(1)
  }
  return false
}

function parseHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export class NetSecClient extends Context.Service<NetSecClient, NetSecClientApi>()("luna/NetSecClient") {
  static readonly Default: Layer.Layer<NetSecClient> =
    NetSecClient.makeLayer({})

  static makeLayer(
    config: NetSecConfig,
  ): Layer.Layer<NetSecClient> {
    return Layer.effect(
      NetSecClient,
      Effect.gen(function* () {
        const strictMode = config.strictMode ?? false
        const timeoutMs = config.timeoutMs ?? 30_000
        const allowlistRef = yield* Ref.make<AllowlistEntry[]>(
          config.allowlist ?? [],
        )

        const isAllowed: NetSecClientApi["isAllowed"] = (url, method) =>
          Ref.get(allowlistRef).pipe(
            Effect.map((allowlist) => {
              if (!strictMode) return true // open pass-through
              if (allowlist.length === 0) return false
              const hostname = parseHostname(url)
              const m = (method ?? "GET") as HttpMethod
              return allowlist.some((entry) => {
                if (!matchHost(entry.host, hostname)) return false
                if (entry.methods !== undefined && !entry.methods.includes(m)) return false
                return true
              })
            }),
          )

        const fetch: NetSecClientApi["fetch"] = (url, opts) =>
          Effect.gen(function* () {
            const method = opts?.method ?? "GET"
            const allowed = yield* isAllowed(url, method)
            if (!allowed) {
              return yield* Effect.fail(
                new EgressBlockedError(
                  url,
                  strictMode ? "host not in allowlist" : "policy blocked",
                ),
              )
            }

            // Note: TLS pin check would go here. Deferred to post-M4 (requires
            // custom TLS agent; globalThis.fetch doesn't expose cert info).

            const reqTimeoutMs = opts?.timeoutMs ?? timeoutMs
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), reqTimeoutMs)

            const fetchInit: RequestInit = {
              method,
              signal: controller.signal,
              // Strict mode: the allowlist is the entire egress control, and it
              // is checked ONLY against the initial url. A 3xx redirecting to a
              // non-allowlisted host would be transparently followed and slip
              // past the allowlist — so fail closed and never follow redirects
              // under strict mode. (Open pass-through mode allows all egress,
              // so default redirect handling is fine there.)
              ...(strictMode ? { redirect: "error" as const } : {}),
              ...(opts?.headers !== undefined ? { headers: opts.headers } : {}),
              ...(opts?.body !== undefined ? { body: opts.body } : {}),
            }

            const resp = yield* Effect.tryPromise({
              try: () =>
                globalThis.fetch(url, fetchInit).then(async (r) => {
                  clearTimeout(timer)
                  const body = await r.text()
                  const headers: Record<string, string> = {}
                  r.headers.forEach((v, k) => { headers[k] = v })
                  return {
                    status: r.status,
                    statusText: r.statusText,
                    headers,
                    body,
                  } satisfies HttpResponse
                }),
              catch: (e) => {
                clearTimeout(timer)
                return new HttpRequestError(url, e)
              },
            })

            return resp
          })

        const allow: NetSecClientApi["allow"] = (entry) =>
          Ref.update(allowlistRef, (list) => [...list, entry])

        return {
          fetch,
          allow,
          isAllowed,
        } satisfies NetSecClientApi
      }),
    )
  }
}
