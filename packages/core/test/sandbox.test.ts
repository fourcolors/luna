/**
 * SandboxRuntime — tests (Phase 13a).
 *
 * Uses real subprocess execution (Node.js builtins like `node -e`).
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { SandboxRuntime } from "../src/sandbox/index.js"

const run = <A, E>(prog: Effect.Effect<A, E, SandboxRuntime>) =>
  Effect.runPromise(prog.pipe(Effect.provide(SandboxRuntime.Default)))

describe("SandboxRuntime", () => {
  it("(1) executes a node script and returns stdout", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sandbox = yield* SandboxRuntime
        return yield* sandbox.exec({
          command: "node",
          args: ["-e", "process.stdout.write('hello sandbox')"],
        })
      }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("hello sandbox")
    expect(result.stderr).toBe("")
    expect(result.elapsedMs).toBeGreaterThan(0)
    expect(result.truncated).toBe(false)
  })

  it("(2) executes a bash echo command", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sandbox = yield* SandboxRuntime
        return yield* sandbox.exec(
          { command: "bash", args: ["-c", "echo -n world"] },
          { allowNonZero: false },
        )
      }),
    )
    expect(result.stdout.trim()).toBe("world")
  })

  it("(3) non-zero exit code → SandboxError by default", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const sandbox = yield* SandboxRuntime
        return yield* sandbox
          .exec({ command: "node", args: ["-e", "process.exit(1)"] })
          .pipe(Effect.exit)
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("SandboxError")
      expect(JSON.stringify(exit.cause)).toContain("non_zero_exit")
    }
  })

  it("(4) allowNonZero: returns result even on non-zero exit", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sandbox = yield* SandboxRuntime
        return yield* sandbox.exec(
          { command: "node", args: ["-e", "process.stdout.write('ok'); process.exit(2)"] },
          { allowNonZero: true },
        )
      }),
    )
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("ok")
  })

  it("(5) timeout: slow process → SandboxError(reason=timeout)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const sandbox = yield* SandboxRuntime
        return yield* sandbox
          .exec({ command: "node", args: ["-e", "setTimeout(() => {}, 60000)"], timeoutMs: 100 })
          .pipe(Effect.exit)
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("timeout")
    }
  }, 10000)

  it("(6) Layer.succeed provides SandboxRuntime without deps", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sandbox = yield* SandboxRuntime
        return yield* sandbox.exec({
          command: "node",
          args: ["-e", "process.stdout.write('42')"],
        })
      }).pipe(Effect.provide(SandboxRuntime.Default)),
    )
    expect(result.stdout).toBe("42")
  })

  it("(7) env vars are passed to subprocess", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sandbox = yield* SandboxRuntime
        return yield* sandbox.exec({
          command: "node",
          args: ["-e", "process.stdout.write(process.env.MY_VAR ?? '')"],
          env: { MY_VAR: "from-sandbox" },
        })
      }),
    )
    expect(result.stdout).toBe("from-sandbox")
  })
})
