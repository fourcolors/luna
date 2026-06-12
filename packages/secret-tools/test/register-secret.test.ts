import { describe, expect, it, vi } from "vitest"
import {
  describeDestination,
  makeRegisterSecret,
  type RegisterSecretDeps,
  type SecretDestination,
} from "../src/register-secret.js"

const OP_TOKEN: SecretDestination = { kind: "op-token", label: "primary" }
const VALID_TOKEN = "ops_realtoken_value_123"

/** Deps that succeed everywhere, with spies. Override per test. */
const happyDeps = (over: Partial<RegisterSecretDeps> = {}): {
  deps: RegisterSecretDeps
  persist: ReturnType<typeof vi.fn>
  persistEnv: ReturnType<typeof vi.fn>
  validate: ReturnType<typeof vi.fn>
  logs: string[]
} => {
  const persist = vi.fn(async (_label: string, _token: string) => {})
  const persistEnv = vi.fn(async (_name: string, _value: string) => {})
  const validate = vi.fn(async (_t: string) => ({ ok: true, message: "" }))
  const logs: string[] = []
  const deps: RegisterSecretDeps = {
    isLabelRegistered: (l) => l === "primary",
    validateOpToken: validate,
    persistOpToken: persist,
    persistEnvSecret: persistEnv,
    log: (m) => logs.push(m),
    ...over,
  }
  return { deps, persist, persistEnv, validate, logs }
}

describe("makeRegisterSecret — op-token", () => {
  it("validates the token then persists it for a registered label", async () => {
    const { deps, persist, validate } = happyDeps()
    const res = await makeRegisterSecret(deps)(OP_TOKEN, VALID_TOKEN)
    expect(res.ok).toBe(true)
    expect(validate).toHaveBeenCalledWith(VALID_TOKEN)
    expect(persist).toHaveBeenCalledWith("primary", VALID_TOKEN)
  })

  it("trims label and secret before use", async () => {
    const { deps, persist } = happyDeps()
    const res = await makeRegisterSecret(deps)(
      { kind: "op-token", label: "  primary  " },
      `  ${VALID_TOKEN}  `,
    )
    expect(res.ok).toBe(true)
    expect(persist).toHaveBeenCalledWith("primary", VALID_TOKEN)
  })

  it("rejects an empty secret with no validate and no persist", async () => {
    const { deps, persist, validate } = happyDeps()
    const res = await makeRegisterSecret(deps)(OP_TOKEN, "   ")
    expect(res.ok).toBe(false)
    expect(validate).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })

  it("rejects an invalid label with no persist", async () => {
    const { deps, persist } = happyDeps({ isLabelRegistered: () => true })
    const res = await makeRegisterSecret(deps)(
      { kind: "op-token", label: "BAD label!" },
      VALID_TOKEN,
    )
    expect(res.ok).toBe(false)
    expect(persist).not.toHaveBeenCalled()
  })

  it("rejects reserved labels (env/file/op)", async () => {
    const { deps } = happyDeps({ isLabelRegistered: () => true })
    for (const label of ["env", "file", "op"]) {
      const res = await makeRegisterSecret(deps)(
        { kind: "op-token", label },
        VALID_TOKEN,
      )
      expect(res.ok).toBe(false)
    }
  })

  it("rejects a label not in LUNA_OP_ACCOUNTS before validating", async () => {
    const { deps, validate, persist } = happyDeps({
      isLabelRegistered: () => false,
    })
    const res = await makeRegisterSecret(deps)(OP_TOKEN, VALID_TOKEN)
    expect(res.ok).toBe(false)
    expect(res.message).toContain("LUNA_OP_ACCOUNTS")
    expect(validate).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })

  it("does not persist when token validation fails", async () => {
    const { deps, persist } = happyDeps({
      validateOpToken: async () => ({
        ok: false,
        message: "1Password rejected this token.",
      }),
    })
    const res = await makeRegisterSecret(deps)(OP_TOKEN, VALID_TOKEN)
    expect(res.ok).toBe(false)
    expect(res.message).toContain("rejected")
    expect(persist).not.toHaveBeenCalled()
  })

  it("returns ok:false (opaque) when persist throws", async () => {
    const { deps } = happyDeps({
      persistOpToken: async () => {
        throw new Error("disk full")
      },
    })
    const res = await makeRegisterSecret(deps)(OP_TOKEN, VALID_TOKEN)
    expect(res.ok).toBe(false)
    expect(res.message).not.toContain("disk full")
  })

  it("NEVER logs the secret value", async () => {
    const { deps, logs } = happyDeps()
    await makeRegisterSecret(deps)(OP_TOKEN, VALID_TOKEN)
    for (const line of logs) {
      expect(line).not.toContain(VALID_TOKEN)
    }
    // an audit line was emitted, and it names the label
    expect(logs.some((l) => l.includes("primary"))).toBe(true)
  })
})

describe("makeRegisterSecret — env-secret", () => {
  const ENV_DEST: SecretDestination = { kind: "env-secret", varName: "OPENAI_API_KEY" }

  it("persists a valid env var", async () => {
    const { deps, persistEnv } = happyDeps()
    const res = await makeRegisterSecret(deps)(ENV_DEST, "sk-abc123")
    expect(res.ok).toBe(true)
    expect(persistEnv).toHaveBeenCalledWith("OPENAI_API_KEY", "sk-abc123")
  })

  it("rejects an invalid var name (would inject into .env) with no persist", async () => {
    const { deps, persistEnv } = happyDeps()
    for (const bad of ["BAD=NAME", "has space", "x\nLEAK=1", "1STARTSNUM"]) {
      const res = await makeRegisterSecret(deps)(
        { kind: "env-secret", varName: bad },
        "v",
      )
      expect(res.ok).toBe(false)
    }
    expect(persistEnv).not.toHaveBeenCalled()
  })

  it("rejects a value containing a line break with no persist", async () => {
    const { deps, persistEnv } = happyDeps()
    const res = await makeRegisterSecret(deps)(ENV_DEST, "line1\nLEAK=evil")
    expect(res.ok).toBe(false)
    expect(persistEnv).not.toHaveBeenCalled()
  })

  // Audit finding: agent write path must reject reserved Luna-internal names
  // before calling persistEnvSecret. Check is CASE-INSENSITIVE.
  it("rejects UI_WS_TOKEN — reserved, persistEnv never called", async () => {
    const { deps, persistEnv } = happyDeps()
    const res = await makeRegisterSecret(deps)(
      { kind: "env-secret", varName: "UI_WS_TOKEN" },
      "tok",
    )
    expect(res.ok).toBe(false)
    expect(res.message).toContain("reserved")
    expect(persistEnv).not.toHaveBeenCalled()
  })

  it("rejects ui_ws_token (lowercase) — case-insensitive check", async () => {
    const { deps, persistEnv } = happyDeps()
    const res = await makeRegisterSecret(deps)(
      { kind: "env-secret", varName: "ui_ws_token" },
      "tok",
    )
    expect(res.ok).toBe(false)
    expect(persistEnv).not.toHaveBeenCalled()
  })

  it("rejects LUNA_X — LUNA_* prefix reserved", async () => {
    const { deps, persistEnv } = happyDeps()
    const res = await makeRegisterSecret(deps)(
      { kind: "env-secret", varName: "LUNA_X" },
      "tok",
    )
    expect(res.ok).toBe(false)
    expect(res.message).toContain("reserved")
    expect(persistEnv).not.toHaveBeenCalled()
  })

  it("rejects luna_connector_y (lowercase LUNA_*) — case-insensitive check", async () => {
    const { deps, persistEnv } = happyDeps()
    const res = await makeRegisterSecret(deps)(
      { kind: "env-secret", varName: "luna_connector_y" },
      "tok",
    )
    expect(res.ok).toBe(false)
    expect(persistEnv).not.toHaveBeenCalled()
  })

  it("returns ok:false (opaque) when env persist throws", async () => {
    const { deps } = happyDeps({
      persistEnvSecret: async () => {
        throw new Error("disk full")
      },
    })
    const res = await makeRegisterSecret(deps)(ENV_DEST, "sk-abc123")
    expect(res.ok).toBe(false)
    expect(res.message).not.toContain("disk full")
  })

  it("NEVER logs the secret value (env)", async () => {
    const { deps, logs } = happyDeps()
    await makeRegisterSecret(deps)(ENV_DEST, "sk-secret-value")
    for (const line of logs) expect(line).not.toContain("sk-secret-value")
  })
})

describe("describeDestination", () => {
  it("renders a human consent string for op-token (no secret)", () => {
    expect(describeDestination(OP_TOKEN)).toBe(
      '1Password service-account token for account "primary"',
    )
  })

  it("renders a human consent string for env-secret (no secret)", () => {
    expect(
      describeDestination({ kind: "env-secret", varName: "OPENAI_API_KEY" }),
    ).toBe("environment variable env:OPENAI_API_KEY")
  })
})
