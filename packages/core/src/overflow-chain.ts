// packages/core/src/overflow-chain.ts
//
// Overflow chains (concept "rev-2"): an ordered fallback list of provider
// targets ("steps") per logical lane. When the preferred account for a lane is
// exhausted (all of its kind cooled down / pinned away), the broker walks the
// lane's chain and picks the first step that yields a live account.
//
// SDK-FREE BY DESIGN: this module is plain data + pure functions. It REUSES the
// existing routing seam (provider-profile.ts) and the existing rotation policy
// (account-broker/rotation-policy.ts — `pickAccount`, imported DIRECTLY to avoid
// the account-broker barrel, which transitively loads `bun:sqlite`). It does NOT
// reimplement cooldown / LRU / sticky-pin.

import {
  type ProviderEnv,
  profileForKind,
  readProviderEnv,
  resolveKind,
} from "./provider-profile.js"
import {
  type AccountRecord,
  pickAccount,
} from "./account-broker/rotation-policy.js"

/** One hop in a lane's overflow chain. */
export interface ChainStep {
  /** Explicit provider kind. If omitted it's derived via `resolveKind(model)`. */
  readonly kind?: string
  /** Optional sticky-pin: route only to this account id within this step. */
  readonly accountId?: string
  /** The model string the SDK should be pointed at for this step. */
  readonly model: string
  /** Optional per-step spend ceiling in USD (informational; consumed by the
   * spend-meter — this module only parses/validates/walks, it does not enforce). */
  readonly budgetUsd?: number
}

/** All overflow chains, keyed by lane name (e.g. "wake", "chat"). */
export interface OverflowConfig {
  readonly chains: Readonly<Record<string, ReadonlyArray<ChainStep>>>
}

const EMPTY_CONFIG: OverflowConfig = { chains: {} }

/** Lanes whose output is parsed as JSON — a step that can't emit structured
 * output in one of these lanes is a config-time FINDING. Exact-match membership. */
const JSON_CONSUMER_LANES = new Set(["wake", "dream", "reasoner"])

/**
 * Read the overflow config from `LUNA_OVERFLOW_CHAINS`.
 *
 * GRAMMAR — JSON. The env var holds a JSON object shaped EXACTLY like
 * {@link OverflowConfig}:
 *
 *   {
 *     "chains": {
 *       "<lane>": [
 *         { "model": "<id>", "kind"?: "<kind>", "accountId"?: "<id>", "budgetUsd"?: <number> },
 *         ...
 *       ],
 *       ...
 *     }
 *   }
 *
 * As a convenience, a bare top-level object WITHOUT a `chains` key is also
 * accepted and treated as the chains map directly, i.e. `{ "wake": [ ... ] }`
 * is equivalent to `{ "chains": { "wake": [ ... ] } }`.
 *
 * Only `model` (a non-empty string) is required per step; `kind`, `accountId`,
 * and `budgetUsd` are optional and copied through when well-typed. Steps lacking
 * a valid `model` are dropped. Missing / malformed JSON ⇒ `{ chains: {} }`
 * (never throws), mirroring readProviderEnv's defensive style.
 */
export function readOverflowConfig(
  env: Record<string, string | undefined> = process.env,
): OverflowConfig {
  const raw = env["LUNA_OVERFLOW_CHAINS"]?.trim()
  if (!raw) return EMPTY_CONFIG
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== "object") return EMPTY_CONFIG
    // Accept either { chains: {...} } or a bare lane map {...}.
    const obj = parsed as Record<string, unknown>
    const rawChains =
      "chains" in obj && obj["chains"] !== null && typeof obj["chains"] === "object"
        ? (obj["chains"] as Record<string, unknown>)
        : obj
    const chains: Record<string, ReadonlyArray<ChainStep>> = {}
    for (const [lane, stepsRaw] of Object.entries(rawChains)) {
      if (!Array.isArray(stepsRaw)) continue
      const steps: ChainStep[] = []
      for (const sr of stepsRaw) {
        if (sr === null || typeof sr !== "object") continue
        const s = sr as Record<string, unknown>
        if (typeof s["model"] !== "string" || s["model"].trim() === "") continue
        const step: {
          model: string
          kind?: string
          accountId?: string
          budgetUsd?: number
        } = { model: s["model"] }
        if (typeof s["kind"] === "string" && s["kind"].trim() !== "") {
          step.kind = s["kind"]
        }
        if (typeof s["accountId"] === "string" && s["accountId"].trim() !== "") {
          step.accountId = s["accountId"]
        }
        if (typeof s["budgetUsd"] === "number" && Number.isFinite(s["budgetUsd"])) {
          step.budgetUsd = s["budgetUsd"]
        }
        steps.push(step)
      }
      chains[lane] = steps
    }
    return { chains }
  } catch {
    return EMPTY_CONFIG
  }
}

/** Look up a lane's chain. Returns null if the lane has no configured chain. */
export function resolveChain(
  lane: string,
  cfg: OverflowConfig,
): ReadonlyArray<ChainStep> | null {
  return cfg.chains[lane] ?? null
}

/**
 * Static validation: flag steps that can't satisfy their lane's needs. For each
 * lane named in {@link JSON_CONSUMER_LANES} (wake/dream/reasoner — they parse
 * the model output as JSON), any step whose resolved provider profile reports
 * `capabilities.structuredOutput === "none"` is a FINDING (it can't reliably
 * emit JSON). Returns one human-readable string per finding; empty array = clean.
 */
export function validateOverflowConfig(
  cfg: OverflowConfig,
  providerEnv: ProviderEnv,
): string[] {
  const findings: string[] = []
  for (const [lane, steps] of Object.entries(cfg.chains)) {
    if (!JSON_CONSUMER_LANES.has(lane)) continue
    steps.forEach((step, i) => {
      const kind = step.kind ?? resolveKind(step.model, providerEnv)
      const profile = profileForKind(kind, providerEnv)
      if (profile.capabilities.structuredOutput === "none") {
        findings.push(
          `lane "${lane}" step ${i} (model "${step.model}", kind "${kind}") ` +
            `cannot produce structured output (structuredOutput="none") but the ` +
            `lane consumes JSON — this step will likely fail to parse.`,
        )
      }
    })
  }
  return findings
}

/**
 * Walk a chain in order and return the first step that yields a live account.
 *
 * For each step: derive `kind = step.kind ?? resolveKind(step.model)`, then defer
 * to the EXISTING `pickAccount(accounts, kind, nowMs, boundId)` — REUSING its
 * cooldown / LRU / sticky-pin logic verbatim. The per-step `accountId` acts as a
 * sticky-pin: it takes precedence over the caller's `boundId` for that step. The
 * first step with a non-null account wins; all steps exhausted ⇒ null.
 */
export function pickChainTarget(
  steps: ReadonlyArray<ChainStep>,
  accounts: ReadonlyArray<AccountRecord>,
  nowMs: number,
  boundId?: string,
  providerEnv: ProviderEnv = readProviderEnv(),
): { step: ChainStep; account: AccountRecord; stepIndex: number } | null {
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex]!
    const kind = step.kind ?? resolveKind(step.model, providerEnv)
    const pin = step.accountId ?? boundId
    const account = pickAccount(accounts, kind, nowMs, pin)
    if (account !== null) return { step, account, stepIndex }
  }
  return null
}
