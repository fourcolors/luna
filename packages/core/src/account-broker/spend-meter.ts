// packages/core/src/account-broker/spend-meter.ts
//
// Spend-meter (the B-phase) — pure helpers shared by BOTH brokers (in-memory
// account-broker.ts AND SQL account-broker-sql.ts) so they stay BEHAVIORALLY
// IDENTICAL (§7.5). Given a usage report and an account's current state, this
// computes the new rolling-cycle accumulator and whether the account must cool
// down because it crossed its budget.
//
// SDK-FREE BY DESIGN: plain data + pure functions, mirroring pricing.ts /
// overflow-chain.ts. Pricing flows through `priceTurnUsd(rateFor(...))`.

import { priceTurnUsd, rateFor, type ModelRate } from "../pricing.js"
import type { AccountRecord } from "./rotation-policy.js"

/** Rolling-30d default window for the spend cycle, in milliseconds. */
const DEFAULT_CYCLE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Read the spend-cycle length (ms) from `LUNA_SPEND_CYCLE_MS`. A positive finite
 * integer override is honored; anything else (unset / malformed / non-positive)
 * falls back to the rolling-30d default. Injectable env keeps this pure +
 * unit-testable and deterministic under the test clock.
 */
export function readCycleMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env["LUNA_SPEND_CYCLE_MS"]?.trim()
  if (!raw) return DEFAULT_CYCLE_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_CYCLE_MS
}

/** A usage report's token counts (the spend-meter's only input from a turn). */
export interface UsageTokens {
  readonly model: string
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

/** Result of folding one usage report into an account's spend state. */
export interface SpendUpdate {
  /** The new rolling accumulator (cycleStartMs may have rolled forward). */
  readonly usage: { readonly cycleStartMs: number; readonly spentUsd: number }
  /**
   * If the account crossed its budget this report, the ms timestamp it must
   * stay cooled down until (the next cycle boundary). Undefined ⇒ not exhausted
   * (either no budget, or still under it).
   */
  readonly cooldownUntilMs?: number
}

/**
 * Fold one usage report into an account's spend state. Deterministic under the
 * injected `nowMs` so test clocks drive cycle rolls.
 *
 * Steps:
 *   1. Roll the cycle: if there is no prior usage, or `now >= cycleStartMs +
 *      cycleMs`, start a fresh window at `now` with spentUsd=0.
 *   2. Price this turn via priceTurnUsd(rateFor(model, account.kind)) and add it.
 *   3. If `budgetUsd` is defined (chain-step primary; the caller resolves the
 *      effective budget) and the new spend >= budgetUsd, cool the account down
 *      until the END of the active cycle (cycleStartMs + cycleMs).
 *
 * No-budget account (budgetUsd undefined) ⇒ accumulate-only telemetry: the spend
 * is tracked but `cooldownUntilMs` is never set.
 */
export function applyUsage(
  account: Pick<AccountRecord, "kind" | "usage">,
  report: UsageTokens,
  budgetUsd: number | undefined,
  nowMs: number,
  cycleMs: number,
  rateTable?: Record<string, ModelRate>,
): SpendUpdate {
  // (1) Roll the cycle if expired or never started.
  const prior = account.usage
  const cycleStartMs =
    prior !== undefined && nowMs < prior.cycleStartMs + cycleMs
      ? prior.cycleStartMs
      : nowMs
  const priorSpent =
    prior !== undefined && nowMs < prior.cycleStartMs + cycleMs
      ? prior.spentUsd
      : 0

  // (2) Price + accumulate. rateFor honors a runtime-overridden table when the
  // caller passes one (LUNA_MODEL_RATES via readRateTable); otherwise the
  // built-in RATE_TABLE keyed off the model prefix wins.
  const rate = rateFor(report.model, account.kind, rateTable)
  const turnUsd = priceTurnUsd(
    {
      tokensIn: report.tokensIn,
      tokensOut: report.tokensOut,
      ...(report.cacheRead !== undefined ? { cacheRead: report.cacheRead } : {}),
      ...(report.cacheWrite !== undefined
        ? { cacheWrite: report.cacheWrite }
        : {}),
    },
    rate,
  )
  const spentUsd = priorSpent + turnUsd

  const next: SpendUpdate = {
    usage: { cycleStartMs, spentUsd },
  }

  // (3) Budget gate. No-budget ⇒ telemetry only.
  if (budgetUsd !== undefined && spentUsd >= budgetUsd) {
    return { ...next, cooldownUntilMs: cycleStartMs + cycleMs }
  }
  return next
}
