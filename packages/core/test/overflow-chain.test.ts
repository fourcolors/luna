/**
 * overflow-chain.test.ts — Tier-1 unit tests for the overflow-chain seam.
 *
 * Pure functions, zero network, env injected explicitly. Covers: JSON grammar
 * round-trip (incl. budgetUsd), lane lookup hit/miss, structured-output
 * validation (flagged in a JSON-consumer lane, NOT in a chat lane, and a
 * gemini step NOT flagged — proving it checks the capability not the lane), and
 * chain walking that reuses the real pickAccount (cooldown skip, exhaustion,
 * sticky-pin).
 */
import { describe, expect, it } from "vitest"
import {
  type ChainStep,
  type OverflowConfig,
  readOverflowConfig,
  resolveChain,
  validateOverflowConfig,
  pickChainTarget,
  pickLaneTarget,
  auditOverflowEnv,
} from "../src/overflow-chain.js"
import { readProviderEnv } from "../src/provider-profile.js"
import type { AccountRecord } from "../src/account-broker/rotation-policy.js"

// Deterministic provider env (no real process.env): all defaults.
const PROVIDER_ENV = readProviderEnv({})

function acct(over: Partial<AccountRecord> & { id: string; kind: string }): AccountRecord {
  return {
    secretRef: `secret:${over.id}`,
    inFlight: 0,
    lastUsedMs: 0,
    ...over,
  }
}

describe("readOverflowConfig — JSON grammar", () => {
  it("returns an empty config when the env var is missing", () => {
    expect(readOverflowConfig({})).toEqual({ chains: {} })
  })

  it("parses the full { chains: { lane: [...] } } shape including budgetUsd", () => {
    const cfg = readOverflowConfig({
      LUNA_OVERFLOW_CHAINS: JSON.stringify({
        chains: {
          wake: [
            { model: "claude-sonnet-4-5", budgetUsd: 0.5 },
            { model: "gemini-2.5-flash", kind: "google", accountId: "g1", budgetUsd: 1.25 },
          ],
        },
      }),
    })
    expect(cfg.chains["wake"]).toEqual([
      { model: "claude-sonnet-4-5", budgetUsd: 0.5 },
      { model: "gemini-2.5-flash", kind: "google", accountId: "g1", budgetUsd: 1.25 },
    ])
  })

  it("accepts a bare lane map without the chains wrapper", () => {
    const cfg = readOverflowConfig({
      LUNA_OVERFLOW_CHAINS: JSON.stringify({
        chat: [{ model: "gpt-4.1" }],
      }),
    })
    expect(cfg.chains["chat"]).toEqual([{ model: "gpt-4.1" }])
  })

  it("drops steps without a valid model and survives malformed JSON", () => {
    const cfg = readOverflowConfig({
      LUNA_OVERFLOW_CHAINS: JSON.stringify({
        chains: { wake: [{ kind: "google" }, { model: "claude-opus-4-8" }] },
      }),
    })
    expect(cfg.chains["wake"]).toEqual([{ model: "claude-opus-4-8" }])
    expect(readOverflowConfig({ LUNA_OVERFLOW_CHAINS: "{bad" })).toEqual({ chains: {} })
  })
})

describe("resolveChain — lane lookup", () => {
  const cfg: OverflowConfig = {
    chains: { wake: [{ model: "claude-sonnet-4-5" }] },
  }
  it("returns the chain for a configured lane (hit)", () => {
    expect(resolveChain("wake", cfg)).toEqual([{ model: "claude-sonnet-4-5" }])
  })
  it("returns null for a lane with no chain (miss)", () => {
    expect(resolveChain("chat", cfg)).toBeNull()
  })
})

describe("validateOverflowConfig — structured-output findings", () => {
  it("flags a structuredOutput=none step in a JSON-consumer lane (wake)", () => {
    const cfg: OverflowConfig = {
      // gpt-* -> openai kind -> structuredOutput "none"
      chains: { wake: [{ model: "gpt-4.1" }] },
    }
    const findings = validateOverflowConfig(cfg, PROVIDER_ENV)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('lane "wake"')
    expect(findings[0]).toContain("structuredOutput")
  })

  it("does NOT flag the same none-capable step in a non-JSON lane (chat)", () => {
    const cfg: OverflowConfig = {
      chains: { chat: [{ model: "gpt-4.1" }] },
    }
    expect(validateOverflowConfig(cfg, PROVIDER_ENV)).toEqual([])
  })

  it("does NOT flag a gemini step in wake (it CAN do structured output)", () => {
    // proves the check is on capability, not lane: gemini/google ->
    // structuredOutput "gemini-response-schema", not "none".
    const cfg: OverflowConfig = {
      chains: { wake: [{ model: "gemini-2.5-flash" }] },
    }
    expect(validateOverflowConfig(cfg, PROVIDER_ENV)).toEqual([])
  })

  it("does NOT flag an anthropic step in wake", () => {
    const cfg: OverflowConfig = {
      chains: { wake: [{ model: "claude-sonnet-4-5" }] },
    }
    expect(validateOverflowConfig(cfg, PROVIDER_ENV)).toEqual([])
  })
})

describe("pickChainTarget — chain walking (reuses pickAccount)", () => {
  it("advances past a fully-cooled-down first kind to the next step", () => {
    const now = 1_000
    const steps: ChainStep[] = [
      { model: "gpt-4.1" }, // -> openai
      { model: "claude-sonnet-4-5" }, // -> anthropic
    ]
    const accounts: AccountRecord[] = [
      // only openai account is cooled down past `now`
      acct({ id: "oa1", kind: "openai", cooldownUntilMs: now + 5_000 }),
      acct({ id: "an1", kind: "anthropic" }),
    ]
    const res = pickChainTarget(steps, accounts, now, undefined, PROVIDER_ENV)
    expect(res).not.toBeNull()
    expect(res!.stepIndex).toBe(1)
    expect(res!.account.id).toBe("an1")
    expect(res!.step.model).toBe("claude-sonnet-4-5")
  })

  it("picks the first step when it has a live account", () => {
    const steps: ChainStep[] = [{ model: "gpt-4.1" }, { model: "claude-sonnet-4-5" }]
    const accounts: AccountRecord[] = [
      acct({ id: "oa1", kind: "openai" }),
      acct({ id: "an1", kind: "anthropic" }),
    ]
    const res = pickChainTarget(steps, accounts, 0, undefined, PROVIDER_ENV)
    expect(res!.stepIndex).toBe(0)
    expect(res!.account.id).toBe("oa1")
  })

  it("returns null when every step is exhausted", () => {
    const now = 1_000
    const steps: ChainStep[] = [{ model: "gpt-4.1" }, { model: "claude-sonnet-4-5" }]
    const accounts: AccountRecord[] = [
      acct({ id: "oa1", kind: "openai", cooldownUntilMs: now + 5_000 }),
      acct({ id: "an1", kind: "anthropic", cooldownUntilMs: now + 5_000 }),
    ]
    expect(pickChainTarget(steps, accounts, now, undefined, PROVIDER_ENV)).toBeNull()
  })

  it("honors a per-step sticky-pin (step.accountId) within a step", () => {
    // two anthropic accounts; LRU would pick the older (lastUsedMs lower), but
    // the step pins the newer one explicitly.
    const steps: ChainStep[] = [{ model: "claude-sonnet-4-5", accountId: "an2" }]
    const accounts: AccountRecord[] = [
      acct({ id: "an1", kind: "anthropic", lastUsedMs: 1 }), // LRU favorite
      acct({ id: "an2", kind: "anthropic", lastUsedMs: 100 }),
    ]
    const res = pickChainTarget(steps, accounts, 0, undefined, PROVIDER_ENV)
    expect(res!.account.id).toBe("an2")
  })

  it("the caller boundId acts as a sticky-pin when no step.accountId is set", () => {
    const steps: ChainStep[] = [{ model: "claude-sonnet-4-5" }]
    const accounts: AccountRecord[] = [
      acct({ id: "an1", kind: "anthropic", lastUsedMs: 1 }),
      acct({ id: "an2", kind: "anthropic", lastUsedMs: 100 }),
    ]
    const res = pickChainTarget(steps, accounts, 0, "an2", PROVIDER_ENV)
    expect(res!.account.id).toBe("an2")
  })
})

describe("pickLaneTarget — shared lane selection (both brokers)", () => {
  const lane = "chat"
  it("no chain: single-step fallback, caller budget wins over seed", () => {
    const accounts = [
      acct({ id: "a1", kind: "anthropic", budgetUsd: 9 }),
      acct({ id: "a2", kind: "anthropic" }),
    ]
    const hit = pickLaneTarget(
      { lane, chain: null, fallbackKind: "anthropic", callerBudgetUsd: 2, providerEnv: PROVIDER_ENV },
      accounts,
      1_000,
    )
    expect(hit).not.toBeNull()
    expect(hit?.model).toBe(lane)
    expect(hit?.stepIndex).toBe(0)
    expect(hit?.budgetUsd).toBe(2)
    // Two same-kind accounts → failoverPossible true (sibling survives)
    expect(hit?.failoverPossible).toBe(true)
  })

  it("no chain, sole account ⇒ failoverPossible false", () => {
    const accounts = [acct({ id: "a1", kind: "anthropic" })]
    const hit = pickLaneTarget(
      { lane, chain: null, fallbackKind: "anthropic", providerEnv: PROVIDER_ENV },
      accounts,
      1_000,
    )
    expect(hit?.failoverPossible).toBe(false)
  })

  it("no chain, boundId pin ⇒ failoverPossible false even with sibling", () => {
    const accounts = [
      acct({ id: "a1", kind: "anthropic" }),
      acct({ id: "a2", kind: "anthropic" }),
    ]
    const hit = pickLaneTarget(
      { lane, chain: null, fallbackKind: "anthropic", boundId: "a1", providerEnv: PROVIDER_ENV },
      accounts,
      1_000,
    )
    expect(hit?.account.id).toBe("a1")
    expect(hit?.failoverPossible).toBe(false)
  })

  it("no chain, sibling cooled ⇒ failoverPossible false", () => {
    const accounts = [
      acct({ id: "a1", kind: "anthropic" }),
      acct({ id: "a2", kind: "anthropic", cooldownUntilMs: 99_999 }),
    ]
    const hit = pickLaneTarget(
      { lane, chain: null, fallbackKind: "anthropic", providerEnv: PROVIDER_ENV },
      accounts,
      1_000, // nowMs < a2's cooldown
    )
    expect(hit?.account.id).toBe("a1")
    expect(hit?.failoverPossible).toBe(false)
  })

  it("chain: budget precedence step ?? caller ?? seed, failoverPossible true when another target survives", () => {
    const chain: ChainStep[] = [
      { model: "claude-sonnet-4-5", budgetUsd: 5 },
      { model: "gemini-2.5-flash", kind: "google" },
    ]
    const accounts = [
      acct({ id: "a1", kind: "anthropic" }),
      acct({ id: "g1", kind: "google" }),
    ]
    const hit = pickLaneTarget(
      { lane, chain, fallbackKind: "anthropic", callerBudgetUsd: 2, providerEnv: PROVIDER_ENV },
      accounts,
      1_000,
    )
    expect(hit?.stepIndex).toBe(0)
    expect(hit?.budgetUsd).toBe(5) // step beats caller
    expect(hit?.failoverPossible).toBe(true) // g1 survives a1's exclusion
  })

  it("chain whose only viable target is the winner ⇒ failoverPossible false", () => {
    const chain: ChainStep[] = [
      { model: "claude-sonnet-4-5" },
      { model: "gemini-2.5-flash", kind: "google" },
    ]
    // No google account exists — the gemini step can never serve.
    const accounts = [acct({ id: "a1", kind: "anthropic" })]
    const hit = pickLaneTarget(
      { lane, chain, fallbackKind: "anthropic", providerEnv: PROVIDER_ENV },
      accounts,
      1_000,
    )
    expect(hit?.stepIndex).toBe(0)
    expect(hit?.failoverPossible).toBe(false)
  })
})

describe("auditOverflowEnv — boot-time config findings", () => {
  it("returns no findings when the env var is unset", () => {
    expect(auditOverflowEnv({}, PROVIDER_ENV)).toEqual([])
  })

  it("flags a set-but-unparseable LUNA_OVERFLOW_CHAINS (previously silent)", () => {
    const findings = auditOverflowEnv(
      { LUNA_OVERFLOW_CHAINS: "{not json" },
      PROVIDER_ENV,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain("parsed to no chains")
  })

  it("flags a lane whose steps were all dropped as invalid", () => {
    const findings = auditOverflowEnv(
      { LUNA_OVERFLOW_CHAINS: JSON.stringify({ wake: [{ kind: "google" }] }) },
      PROVIDER_ENV,
    )
    expect(findings.some((f) => f.includes('lane "wake" has no valid steps'))).toBe(true)
  })

  it("includes validateOverflowConfig structured-output findings for a clean parse", () => {
    const findings = auditOverflowEnv(
      {
        LUNA_OVERFLOW_CHAINS: JSON.stringify({
          wake: [{ model: "qwen3:cloud" }],
        }),
      },
      PROVIDER_ENV,
    )
    expect(findings.some((f) => f.includes("structuredOutput"))).toBe(true)
  })

  it("returns no findings for a healthy chat-lane chain", () => {
    expect(
      auditOverflowEnv(
        {
          LUNA_OVERFLOW_CHAINS: JSON.stringify({
            chat: [{ model: "claude-sonnet-4-5" }, { model: "gpt-4.1" }],
          }),
        },
        PROVIDER_ENV,
      ),
    ).toEqual([])
  })
})
