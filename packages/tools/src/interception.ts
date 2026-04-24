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
import type { PermissionResult } from "@experiment-agent/adapter-sdk"

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
