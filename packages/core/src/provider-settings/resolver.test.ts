/**
 * Unit tests for the provider-settings resolver.
 *
 * Tests verify:
 *   1. Store-overrides-env precedence for ProviderEnv (modelKindMap).
 *   2. Store-overrides-env precedence for OverflowConfig (role chains).
 *   3. Role model resolution (first pref / default).
 *   4. Write-time validation rejects dirty configs, passes clean ones.
 */

import { describe, it, expect } from "vitest"
import {
  resolveProviderEnv,
  resolveOverflowConfig,
  resolveRoleModel,
  validateAndPrepare,
  ProviderSettingsValidationError,
} from "./resolver.js"
import type { ProviderSettingsPayload } from "./types.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

const emptyPayload = (): ProviderSettingsPayload => ({
  version: 1,
  providers: [],
  roleBindings: [],
})

const claudeOnlyEnv: Record<string, string | undefined> = {
  // No overrides — pure anthropic default.
}

// ── resolveProviderEnv ────────────────────────────────────────────────────────

describe("resolveProviderEnv", () => {
  it("returns env base when store config is null", () => {
    const result = resolveProviderEnv(null, claudeOnlyEnv)
    expect(result.modelKindMap).toEqual({})
  })

  it("returns env base when store has empty roleBindings", () => {
    const result = resolveProviderEnv(emptyPayload(), claudeOnlyEnv)
    expect(result.modelKindMap).toEqual({})
  })

  it("STORE OVERRIDES ENV: store binding wins over env modelKindMap", () => {
    const env: Record<string, string | undefined> = {
      LUNA_MODEL_PROVIDER_MAP: "claude-sonnet-4-6=anthropic",
    }
    const store: ProviderSettingsPayload = {
      version: 1,
      providers: [{ kind: "openai", enabled: true }],
      roleBindings: [
        {
          role: "daily-driver",
          preferenceList: [{ provider: "openai", model: "claude-sonnet-4-6" }],
        },
      ],
    }
    const result = resolveProviderEnv(store, env)
    // Store mapping "claude-sonnet-4-6=openai" overrides env "claude-sonnet-4-6=anthropic".
    expect(result.modelKindMap["claude-sonnet-4-6"]).toBe("openai")
  })

  it("env entries not in store are preserved", () => {
    const env: Record<string, string | undefined> = {
      LUNA_MODEL_PROVIDER_MAP: "my-custom-model=ollama-local",
    }
    const store: ProviderSettingsPayload = {
      version: 1,
      providers: [],
      roleBindings: [
        {
          role: "advisor",
          preferenceList: [{ provider: "anthropic", model: "claude-opus-4-8" }],
        },
      ],
    }
    const result = resolveProviderEnv(store, env)
    // Env-only entry preserved.
    expect(result.modelKindMap["my-custom-model"]).toBe("ollama-local")
    // Store entry also present.
    expect(result.modelKindMap["claude-opus-4-8"]).toBe("anthropic")
  })

  it("multiple preference list entries all appear in modelKindMap", () => {
    const store: ProviderSettingsPayload = {
      version: 1,
      providers: [],
      roleBindings: [
        {
          role: "advisor",
          preferenceList: [
            { provider: "anthropic", model: "claude-opus-4-8" },
            { provider: "anthropic", model: "claude-sonnet-4-6" },
          ],
        },
      ],
    }
    const result = resolveProviderEnv(store, {})
    expect(result.modelKindMap["claude-opus-4-8"]).toBe("anthropic")
    expect(result.modelKindMap["claude-sonnet-4-6"]).toBe("anthropic")
  })
})

// ── resolveOverflowConfig ─────────────────────────────────────────────────────

describe("resolveOverflowConfig", () => {
  it("returns env base when store config is null", () => {
    const result = resolveOverflowConfig(null, {})
    expect(result.chains).toEqual({})
  })

  it("returns env base when store has empty roleBindings", () => {
    const result = resolveOverflowConfig(emptyPayload(), {})
    expect(result.chains).toEqual({})
  })

  it("STORE OVERRIDES ENV: store role chain replaces env chain for that lane", () => {
    const env: Record<string, string | undefined> = {
      LUNA_OVERFLOW_CHAINS: JSON.stringify({
        chains: {
          advisor: [{ model: "claude-opus-4-8" }],
          wake: [{ model: "claude-sonnet-4-6" }],
        },
      }),
    }
    const store: ProviderSettingsPayload = {
      version: 1,
      providers: [],
      roleBindings: [
        {
          role: "advisor",
          preferenceList: [
            { provider: "anthropic", model: "claude-haiku-4-5" }, // overrides env
          ],
        },
      ],
    }
    const result = resolveOverflowConfig(store, env)
    // Store chain is keyed by primary model id (not role name) — the broker resolves by model.
    expect(result.chains["claude-haiku-4-5"]).toHaveLength(1)
    expect((result.chains["claude-haiku-4-5"] as Array<{ model: string }>)[0]?.model).toBe("claude-haiku-4-5")
    // Env chain for wake is preserved (not in store, stays as env-keyed lane).
    expect(result.chains["wake"]).toHaveLength(1)
    expect((result.chains["wake"] as Array<{ model: string }>)[0]?.model).toBe("claude-sonnet-4-6")
  })

  it("non-role lanes from env are preserved", () => {
    const env: Record<string, string | undefined> = {
      LUNA_OVERFLOW_CHAINS: JSON.stringify({
        chains: {
          "my-custom-lane": [{ model: "claude-sonnet-4-6" }],
        },
      }),
    }
    const store: ProviderSettingsPayload = {
      version: 1,
      providers: [],
      roleBindings: [
        {
          role: "dream",
          preferenceList: [{ provider: "anthropic", model: "claude-haiku-4-5" }],
        },
      ],
    }
    const result = resolveOverflowConfig(store, env)
    // Custom env lane preserved (not a role binding, stays as-is).
    expect(result.chains["my-custom-lane"]).toBeDefined()
    // Store dream chain is keyed by primary model id, NOT role name.
    expect(result.chains["claude-haiku-4-5"]).toBeDefined()
    expect(result.chains["dream"]).toBeUndefined()
  })

  it("role chain steps carry the provider kind", () => {
    const store: ProviderSettingsPayload = {
      version: 1,
      providers: [],
      roleBindings: [
        {
          role: "daily-driver",
          preferenceList: [
            { provider: "anthropic", model: "claude-sonnet-4-6" },
            { provider: "anthropic", model: "claude-haiku-4-5" },
          ],
        },
      ],
    }
    const result = resolveOverflowConfig(store, {})
    // Chain is keyed by primary model ("claude-sonnet-4-6"), not the role name.
    const steps = result.chains["claude-sonnet-4-6"] as Array<{ model: string; kind: string }>
    expect(steps).toHaveLength(2)
    expect(steps[0]?.kind).toBe("anthropic")
    expect(steps[1]?.kind).toBe("anthropic")
  })
})

// ── resolveRoleModel ──────────────────────────────────────────────────────────

describe("resolveRoleModel", () => {
  it("returns default when store is null", () => {
    expect(resolveRoleModel("advisor", null)).toBe("claude-opus-4-8")
    expect(resolveRoleModel("daily-driver", null)).toBe("claude-sonnet-4-6")
    expect(resolveRoleModel("wake", null)).toBe("claude-sonnet-4-6")
    expect(resolveRoleModel("dream", null)).toBe("claude-haiku-4-5")
  })

  it("returns default when store has no binding for the role", () => {
    const store: ProviderSettingsPayload = {
      version: 1,
      providers: [],
      roleBindings: [], // no bindings
    }
    expect(resolveRoleModel("advisor", store)).toBe("claude-opus-4-8")
  })

  it("returns first preference list model when binding exists", () => {
    const store: ProviderSettingsPayload = {
      version: 1,
      providers: [],
      roleBindings: [
        {
          role: "advisor",
          preferenceList: [
            { provider: "anthropic", model: "claude-haiku-4-5" },
            { provider: "anthropic", model: "claude-opus-4-8" },
          ],
        },
      ],
    }
    expect(resolveRoleModel("advisor", store)).toBe("claude-haiku-4-5")
  })

  it("falls back to default when preference list is empty", () => {
    const store: ProviderSettingsPayload = {
      version: 1,
      providers: [],
      roleBindings: [
        {
          role: "wake",
          preferenceList: [], // empty
        },
      ],
    }
    expect(resolveRoleModel("wake", store)).toBe("claude-sonnet-4-6")
  })
})

// ── validateAndPrepare ────────────────────────────────────────────────────────

describe("validateAndPrepare", () => {
  it("passes clean configs with no role bindings", () => {
    const payload = emptyPayload()
    const result = validateAndPrepare(payload, {})
    expect(result).toBe(payload)
  })

  it("passes valid anthropic role bindings", () => {
    const payload: ProviderSettingsPayload = {
      version: 1,
      providers: [{ kind: "anthropic", enabled: true }],
      roleBindings: [
        {
          role: "advisor",
          preferenceList: [{ provider: "anthropic", model: "claude-opus-4-8" }],
        },
        {
          role: "daily-driver",
          preferenceList: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
        },
      ],
    }
    expect(() => validateAndPrepare(payload, {})).not.toThrow()
  })

  it("rejects payload with empty model string in preference list", () => {
    const payload: ProviderSettingsPayload = {
      version: 1,
      providers: [],
      roleBindings: [
        {
          role: "advisor",
          preferenceList: [{ provider: "anthropic", model: "" }], // empty model
        },
      ],
    }
    expect(() => validateAndPrepare(payload, {})).toThrow(ProviderSettingsValidationError)
  })

  it("rejects configs that fail structured-output validation for JSON lanes", () => {
    // openai via gateway has structuredOutput="none"; the wake lane consumes JSON.
    // Setting wake to openai without a gateway configured produces a finding.
    const payload: ProviderSettingsPayload = {
      version: 1,
      providers: [{ kind: "openai", enabled: true }],
      roleBindings: [
        {
          role: "wake",
          preferenceList: [{ provider: "openai", model: "gpt-4o" }],
        },
      ],
    }
    // openai routes through gateway which has structuredOutput="none",
    // and wake is a JSON consumer lane, so this should produce findings.
    expect(() => validateAndPrepare(payload, {})).toThrow(ProviderSettingsValidationError)
    try {
      validateAndPrepare(payload, {})
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderSettingsValidationError)
      const err = e as ProviderSettingsValidationError
      expect(err.findings.length).toBeGreaterThan(0)
    }
  })

  it("ProviderSettingsValidationError carries findings array", () => {
    const payload: ProviderSettingsPayload = {
      version: 1,
      providers: [],
      roleBindings: [
        {
          role: "advisor",
          preferenceList: [{ provider: "anthropic", model: "" }],
        },
      ],
    }
    try {
      validateAndPrepare(payload, {})
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderSettingsValidationError)
      const err = e as ProviderSettingsValidationError
      expect(Array.isArray(err.findings)).toBe(true)
      expect(err.findings.length).toBeGreaterThan(0)
    }
  })
})
