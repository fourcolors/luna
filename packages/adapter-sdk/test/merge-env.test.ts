/**
 * merge-env Tier-1 tests — verifies Option A overlay semantics:
 * caller env passes through unchanged except for broker-owned keys,
 * which always overwrite (with a warning on collision).
 */
import { describe, expect, it } from "vitest"
import { Effect, Logger, LogLevel } from "effect"
import { mergeEnvOverlay, mergeEnvOverlayLogged } from "../src/merge-env.js"

describe("mergeEnvOverlay (pure)", () => {
  it("undefined caller env + broker overlay → just the overlay, no warnings", () => {
    const { env, warnings } = mergeEnvOverlay(undefined, { TOKEN: "abc" })
    expect(env).toEqual({ TOKEN: "abc" })
    expect(warnings).toEqual([])
  })

  it("disjoint keys merge cleanly with no warnings", () => {
    const { env, warnings } = mergeEnvOverlay(
      { FOO: "bar" },
      { TOKEN: "abc" },
    )
    expect(env).toEqual({ FOO: "bar", TOKEN: "abc" })
    expect(warnings).toEqual([])
  })

  it("collision: broker key overwrites caller value and emits warning", () => {
    const { env, warnings } = mergeEnvOverlay(
      { TOKEN: "caller-tok", FOO: "bar" },
      { TOKEN: "broker-tok" },
    )
    expect(env.TOKEN).toBe("broker-tok")
    expect(env.FOO).toBe("bar")
    expect(warnings).toEqual([{ key: "TOKEN" }])
  })

  it("empty overlay → caller env returned unchanged, no warnings", () => {
    const caller = { FOO: "bar", BAZ: "qux" }
    const { env, warnings } = mergeEnvOverlay(caller, {})
    expect(env).toEqual(caller)
    expect(warnings).toEqual([])
    // Defensive: result must be a copy, not the same ref.
    expect(env).not.toBe(caller)
  })
})

describe("mergeEnvOverlayLogged (effectful)", () => {
  it("returns merged env on disjoint inputs", async () => {
    const env = await Effect.runPromise(
      mergeEnvOverlayLogged({ FOO: "bar" }, { TOKEN: "broker" }),
    )
    expect(env).toEqual({ FOO: "bar", TOKEN: "broker" })
  })

  it("emits a Warning log on collision while still returning merged env", async () => {
    const captured: Array<{ level: string; message: string }> = []
    const captureLayer = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message, logLevel }) => {
        captured.push({
          level: logLevel.label,
          message: String(message),
        })
      }),
    )
    const env = await Effect.runPromise(
      mergeEnvOverlayLogged(
        { TOKEN: "caller", X: "y" },
        { TOKEN: "broker" },
      ).pipe(Effect.provide(captureLayer)),
    )
    expect(env.TOKEN).toBe("broker")
    const warns = captured.filter((c) => c.level === LogLevel.Warning.label)
    expect(warns.length).toBeGreaterThanOrEqual(1)
    expect(warns.some((w) => w.message.includes("TOKEN"))).toBe(true)
  })

  it("does not include secret values in warning messages", async () => {
    const captured: string[] = []
    const captureLayer = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message }) => {
        captured.push(String(message))
      }),
    )
    const SECRET_OLD = "S3CR3T_C4LL3R_VALUE_b9f7c3"
    const SECRET_NEW = "S3CR3T_BR0K3R_VALUE_a1b2c4"
    await Effect.runPromise(
      mergeEnvOverlayLogged(
        { TOKEN: SECRET_OLD },
        { TOKEN: SECRET_NEW },
      ).pipe(Effect.provide(captureLayer)),
    )
    for (const m of captured) {
      expect(m).not.toContain(SECRET_OLD)
      expect(m).not.toContain(SECRET_NEW)
    }
  })
})
