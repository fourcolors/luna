/**
 * Per-key merge policy for layered SessionOptions (global → project → session).
 *
 * Advisor verdict Phase 4 Q4: a single global merge rule silently loses
 * nested entries. Each key declares its own policy.
 *
 * Policies:
 *   - "replace"  — later layer wholly replaces earlier (scalars, single objects)
 *   - "concat"   — arrays concatenated; later layer appended
 *   - "concat-unique" — arrays concatenated with later-wins de-dupe by identity
 *   - "deep-merge"   — shallow object merge, later-wins per top-level key
 *
 * Unknown keys default to "replace" — a caller extending sdkOptions gets
 * predictable semantics without a registry edit.
 */
export type MergePolicy =
  | "replace"
  | "concat"
  | "concat-unique"
  | "deep-merge"

/**
 * Policy registry for our added SessionOptions fields + well-known SDK
 * sub-fields that callers layer (env, allowedTools, mcpServers).
 *
 * Applied at two levels: top-level SessionOptions fields, AND (when
 * `sdkOptions` is present) per-key inside `sdkOptions`.
 */
export const MERGE_POLICIES: Readonly<Record<string, MergePolicy>> = {
  // Top-level SessionOptions
  model: "replace",
  idleTimeoutMs: "replace",
  disableIdleTimeout: "replace",
  turnInactivityTimeoutMs: "replace",
  hangCooldownMs: "replace",
  systemPrompt: "replace",
  title: "replace",
  tags: "concat-unique",
  parentSessionId: "replace",
  sdkOptions: "deep-merge", // handled recursively below
  // Well-known SDK Options sub-fields
  env: "deep-merge",
  allowedTools: "concat-unique",
  disallowedTools: "concat-unique",
  mcpServers: "deep-merge",
  additionalDirectories: "concat-unique",
  settingSources: "concat-unique",
  permissionMode: "replace",
  maxTurns: "replace",
  model_sdk: "replace",
  cwd: "replace",
}

const DEFAULT_POLICY: MergePolicy = "replace"

export function policyFor(key: string): MergePolicy {
  return MERGE_POLICIES[key] ?? DEFAULT_POLICY
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  )
}

/**
 * Merge two values under a named policy. `a` is the earlier layer, `b` the
 * later. `undefined` in `b` does NOT clear — the caller unsets by omitting.
 */
export function mergeUnder(
  policy: MergePolicy,
  a: unknown,
  b: unknown,
): unknown {
  if (a === undefined) return b
  if (b === undefined) return a
  switch (policy) {
    case "replace":
      return b
    case "concat": {
      const aa = Array.isArray(a) ? a : [a]
      const bb = Array.isArray(b) ? b : [b]
      return [...aa, ...bb]
    }
    case "concat-unique": {
      const aa = Array.isArray(a) ? a : [a]
      const bb = Array.isArray(b) ? b : [b]
      const seen = new Set<unknown>()
      const out: unknown[] = []
      for (const x of [...aa, ...bb]) {
        const key = typeof x === "object" ? JSON.stringify(x) : x
        if (seen.has(key)) continue
        seen.add(key)
        out.push(x)
      }
      return out
    }
    case "deep-merge": {
      if (isPlainObject(a) && isPlainObject(b)) {
        const out: Record<string, unknown> = { ...a }
        for (const k of Object.keys(b)) {
          out[k] = mergeUnder(policyFor(k), a[k], b[k])
        }
        return out
      }
      return b
    }
  }
}

/**
 * Merge two SessionOptions-shaped records. Top-level uses the policy table;
 * `sdkOptions` is deep-merged with the same table applied recursively.
 */
export function mergeLayer(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const k of Object.keys(b)) {
    out[k] = mergeUnder(policyFor(k), a[k], b[k])
  }
  return out
}

/**
 * Compose N layers left-to-right: `layers[0]` is lowest precedence,
 * `layers[N-1]` wins. Useful for global → project → session stacking.
 */
export function composeLayers(
  layers: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  return layers.reduce<Record<string, unknown>>(
    (acc, layer) => mergeLayer(acc, layer),
    {},
  )
}
