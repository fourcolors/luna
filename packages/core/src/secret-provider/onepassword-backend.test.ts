/**
 * OnePasswordSecretProvider Tier-1 tests — mocks `node:child_process` so
 * we exercise every code path without invoking the real `op` binary.
 */
import { EventEmitter } from "node:events"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { Effect, Exit, Layer, Redacted } from "effect"

// ---- mock setup -----------------------------------------------------------
// Each test pushes a "next spawn behavior" onto this queue; the mocked
// `spawn` consumes them in FIFO order. This keeps each test fully
// hermetic and makes the call sequence assertions explicit.
interface SpawnBehavior {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
  readonly errorOnSpawn?: NodeJS.ErrnoException
}
interface SpawnRecord {
  readonly cmd: string
  readonly args: ReadonlyArray<string>
  readonly env: NodeJS.ProcessEnv
}

const spawnQueue: SpawnBehavior[] = []
const spawnLog: SpawnRecord[] = []

vi.mock("node:child_process", () => ({
  spawn: (
    cmd: string,
    args: ReadonlyArray<string>,
    opts: { env: NodeJS.ProcessEnv },
  ) => {
    spawnLog.push({ cmd, args, env: opts.env })
    const behavior = spawnQueue.shift() ?? { stdout: "", exitCode: 0 }
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    // Defer events to the next microtask so `on()` listeners are attached.
    queueMicrotask(() => {
      if (behavior.errorOnSpawn) {
        child.emit("error", behavior.errorOnSpawn)
        return
      }
      if (behavior.stdout) child.stdout.emit("data", behavior.stdout)
      if (behavior.stderr) child.stderr.emit("data", behavior.stderr)
      child.emit("close", behavior.exitCode ?? 0)
    })
    return child
  },
}))

// Import AFTER vi.mock is registered.
import { Clock } from "../clock.js"
import { SecretProvider } from "./secret-provider.js"
import { OnePasswordSecretProvider } from "./onepassword-backend.js"

const baseClock = Clock.Test(1_000_000)

const buildLayer = (overrides?: Parameters<typeof OnePasswordSecretProvider.make>[0]) =>
  OnePasswordSecretProvider.make(overrides ?? { vault: "Test Vault" }).pipe(
    Layer.provide(baseClock),
  )

beforeEach(() => {
  spawnQueue.length = 0
  spawnLog.length = 0
  delete process.env.OP_SERVICE_ACCOUNT_TOKEN
})

describe("OnePasswordSecretProvider", () => {
  it("valid op:// ref → invokes `op read --no-newline` and returns Redacted", async () => {
    spawnQueue.push({ stdout: "my-secret\n", exitCode: 0 })
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("op://VAULT/ITEM/FIELD")
      }).pipe(Effect.provide(buildLayer())),
    )
    expect(Redacted.value(got)).toBe("my-secret")
    expect(spawnLog).toHaveLength(1)
    expect(spawnLog[0]?.cmd).toBe("op")
    expect(spawnLog[0]?.args).toEqual([
      "read",
      "--no-newline",
      "--",
      "op://VAULT/ITEM/FIELD",
    ])
  })

  it("non-op:// ref → ConfigError, no spawn", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("env:FOO")
      }).pipe(Effect.provide(buildLayer())),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("ConfigError")
      expect(JSON.stringify(exit.cause)).toContain("not an op://")
    }
    expect(spawnLog).toHaveLength(0)
  })

  it("ENOENT (missing op binary) → ConfigError mentioning PATH/install", async () => {
    const err = Object.assign(new Error("spawn op ENOENT"), {
      code: "ENOENT",
    }) as NodeJS.ErrnoException
    spawnQueue.push({ errorOnSpawn: err })
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("op://VAULT/ITEM/FIELD")
      }).pipe(Effect.provide(buildLayer())),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("ConfigError")
      expect(j).toContain("PATH")
    }
  })

  it("non-zero exit → ConfigError with stderr tail", async () => {
    spawnQueue.push({
      stdout: "",
      stderr: "auth failed: bad token",
      exitCode: 1,
    })
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("op://VAULT/ITEM/FIELD")
      }).pipe(Effect.provide(buildLayer())),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("exited with code 1")
      expect(j).toContain("auth failed")
    }
  })

  it("empty stdout (after trim) → ConfigError 'empty secret'", async () => {
    spawnQueue.push({ stdout: "\n\n", exitCode: 0 })
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("op://VAULT/ITEM/FIELD")
      }).pipe(Effect.provide(buildLayer())),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("empty secret")
    }
  })

  it("OP_SERVICE_ACCOUNT_TOKEN is forwarded when token option omitted", async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "from-process-env"
    spawnQueue.push({ stdout: "v", exitCode: 0 })
    await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("op://VAULT/ITEM/FIELD")
      }).pipe(Effect.provide(buildLayer())),
    )
    expect(spawnLog[0]?.env.OP_SERVICE_ACCOUNT_TOKEN).toBe("from-process-env")
  })

  it("explicit token option overrides process env", async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "from-process-env"
    spawnQueue.push({ stdout: "v", exitCode: 0 })
    await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("op://VAULT/ITEM/FIELD")
      }).pipe(
        Effect.provide(
          buildLayer({ vault: "Test Vault", token: "explicit-token" }),
        ),
      ),
    )
    expect(spawnLog[0]?.env.OP_SERVICE_ACCOUNT_TOKEN).toBe("explicit-token")
  })
})
