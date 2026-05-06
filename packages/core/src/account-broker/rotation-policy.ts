/**
 * Pure rotation-policy function. Lives in its own file so it can be
 * Tier-1 unit tested without spinning up Effect / Refs / Layers.
 *
 * Policy (per Phase 9 brief, derived from §0.2 and the sol-agent spec):
 *   1. Filter accounts to those matching `kind`.
 *   2. Filter out accounts whose `cooldownUntilMs` is in the future.
 *   3. If `boundId` is provided, return ONLY that account if it survives
 *      the above filters; otherwise return null (sticky-pin semantics —
 *      caller maps null → AllAccountsExhaustedError).
 *   4. Otherwise sort by ascending `inFlight`, breaking ties by
 *      ascending `lastUsedMs` (oldest wins). Return head of sorted list.
 */
export interface AccountRecord {
  readonly id: string
  readonly label?: string
  readonly kind: string
  readonly secretRef: string
  readonly inFlight: number
  readonly cooldownUntilMs?: number
  /** Last acquire time for LRU tie-breaking. 0 if never used. */
  readonly lastUsedMs: number
}

export const pickAccount = (
  accounts: ReadonlyArray<AccountRecord>,
  kind: string,
  nowMs: number,
  boundId?: string,
): AccountRecord | null => {
  const eligible = accounts.filter(
    (a) =>
      a.kind === kind &&
      (a.cooldownUntilMs === undefined || a.cooldownUntilMs <= nowMs),
  )
  if (boundId !== undefined) {
    return eligible.find((a) => a.id === boundId) ?? null
  }
  if (eligible.length === 0) return null
  // Sort: lowest inFlight first, then lowest lastUsedMs (oldest).
  const sorted = [...eligible].sort((a, b) => {
    if (a.inFlight !== b.inFlight) return a.inFlight - b.inFlight
    return a.lastUsedMs - b.lastUsedMs
  })
  return sorted[0] ?? null
}
