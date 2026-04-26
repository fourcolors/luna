/**
 * Option merge guard — DESIGN.md §12.2 invariant #7.
 *
 * The adapter owns the following `Options` keys and must overwrite any
 * caller-supplied values with adapter-managed versions:
 *   - hooks
 *   - canUseTool
 *   - abortController
 *   - resume
 *   - forkSession
 *
 * If a caller passes any of these via `SessionOptions.sdkOptions`, we drop
 * them (with a warning) rather than silently merge — naive merge is how
 * registered hooks get nuked in production.
 */
import { Effect } from "effect"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { RESERVED_SDK_OPTION_KEYS } from "@luna/core"

export interface MergeWarning {
  readonly key: string
}

export interface MergeResult {
  readonly merged: Options
  readonly warnings: ReadonlyArray<MergeWarning>
}

/**
 * Merge caller-supplied `sdkOptions` with adapter-owned overrides. Reserved
 * keys from caller input are dropped; `overrides` wins for everything it
 * declares.
 */
export const mergeOptions = (
  callerSdkOptions: Readonly<Record<string, unknown>> | undefined,
  overrides: Partial<Options>,
): MergeResult => {
  const warnings: MergeWarning[] = []
  const cleaned: Record<string, unknown> = {}

  if (callerSdkOptions) {
    for (const [k, v] of Object.entries(callerSdkOptions)) {
      if ((RESERVED_SDK_OPTION_KEYS as readonly string[]).includes(k)) {
        warnings.push({ key: k })
        continue
      }
      cleaned[k] = v
    }
  }

  const merged = { ...cleaned, ...overrides } as Options
  return { merged, warnings }
}

/**
 * Effectful wrapper that logs warnings via Effect.log before returning the
 * merged options. Use this at the query site.
 */
export const mergeOptionsLogged = (
  callerSdkOptions: Readonly<Record<string, unknown>> | undefined,
  overrides: Partial<Options>,
): Effect.Effect<Options, never> =>
  Effect.gen(function* () {
    const { merged, warnings } = mergeOptions(callerSdkOptions, overrides)
    for (const w of warnings) {
      yield* Effect.logWarning(
        `[SDKAdapter] Dropping caller-supplied reserved Options key: ${w.key}`,
      )
    }
    return merged
  })
