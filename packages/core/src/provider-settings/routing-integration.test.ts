/**
 * Integration test: proves that the model-keyed overflow chain contract
 * works end-to-end with the broker's resolveChain pattern.
 *
 * The broker does:
 *   const lane = o.model  // e.g. "claude-haiku-4-5" (the wake model)
 *   resolveChain(lane, cfg)
 *
 * Before the fix, chains were keyed by role name ("wake") — the broker's
 * chain lookup always returned null. After the fix, chains are keyed by the
 * primary model id — the broker finds the chain.
 */

import { describe, it, expect } from "vitest"
import { resolveOverflowConfig, resolveRoleModel } from "./resolver.js"
import { resolveChain } from "../overflow-chain.js"
import type { ProviderSettingsPayload } from "./types.js"

describe("routing integration — model-keyed chain lookup", () => {
  const store: ProviderSettingsPayload = {
    version: 1,
    providers: [{ kind: "anthropic", enabled: true }],
    roleBindings: [
      {
        role: "wake",
        preferenceList: [
          { provider: "anthropic", model: "claude-haiku-4-5" },
          { provider: "anthropic", model: "claude-sonnet-4-6" },
        ],
      },
    ],
  }

  it("chain is keyed by primary model id, not role name", () => {
    const cfg = resolveOverflowConfig(store, {})
    // Must have a 2-step chain under the primary model id.
    expect(cfg.chains["claude-haiku-4-5"]).toHaveLength(2)
    // Must NOT have the role name as a key (that was the old broken contract).
    expect(cfg.chains["wake"]).toBeUndefined()
  })

  it("resolveRoleModel returns the primary model for wake", () => {
    expect(resolveRoleModel("wake", store)).toBe("claude-haiku-4-5")
  })

  it("resolveChain(roleModel, cfg) is non-null — mirrors broker's lane = o.model lookup", () => {
    // This is the critical path: the broker calls resolveChain(o.model, cfg)
    // where o.model = LUNA_WAKE_MODEL = resolveRoleModel("wake", store).
    const cfg = resolveOverflowConfig(store, {})
    const roleModel = resolveRoleModel("wake", store) // "claude-haiku-4-5"

    // Broker pattern: const lane = o.model; resolveChain(lane, cfg)
    const chain = resolveChain(roleModel, cfg)
    expect(chain).not.toBeNull()
    expect(chain).toHaveLength(2)
  })

  it("resolveChain('wake', cfg) is null — role-name lookup fails (proves old bug is gone)", () => {
    const cfg = resolveOverflowConfig(store, {})
    // The OLD broken behavior: chain was keyed by "wake" → never found by broker.
    // Now that chains are model-keyed, "wake" as a key returns null.
    expect(resolveChain("wake", cfg)).toBeNull()
  })
})
