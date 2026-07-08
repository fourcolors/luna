/**
 * FilePathSecretProvider tests — hardened file: and file-json: secret backend.
 *
 * All file fixtures use tmp directories (os.tmpdir() + fs.mkdtempSync).
 * No hardcoded /root/ paths.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Exit, Redacted } from "effect"
import { SecretProvider } from "./secret-provider.js"
import {
  FilePathSecretProvider,
  FILE_SIZE_CAP_BYTES,
} from "./file-path-backend.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "fp-secret-test-"))

const run = <A>(prog: Effect.Effect<A, never, never>) => Effect.runPromise(prog)

const runExit = <A, E>(prog: Effect.Effect<A, E, never>) =>
  Effect.runPromiseExit(prog)

const withProvider = <A, E>(
  prog: Effect.Effect<A, E, SecretProvider>,
): Effect.Effect<A, E, never> =>
  prog.pipe(Effect.provide(FilePathSecretProvider.Default)) as Effect.Effect<
    A,
    E,
    never
  >

const get = (ref: string) =>
  withProvider(
    Effect.gen(function* () {
      const sp = yield* SecretProvider
      return yield* sp.get(ref)
    }),
  )

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("FilePathSecretProvider — happy paths", () => {
  it("file: returns trimmed file contents", async () => {
    const dir = tmpDir()
    const p = path.join(dir, "secret.txt")
    fs.writeFileSync(p, "hello\n")
    const val = await run(get(`file:${p}`))
    expect(Redacted.value(val)).toBe("hello")
  })

  it("file: strips UTF-8 BOM", async () => {
    const dir = tmpDir()
    const p = path.join(dir, "bom.txt")
    // Write BOM + content + trailing newline.
    fs.writeFileSync(p, "\xEF\xBB\xBFhello\n")
    const val = await run(get(`file:${p}`))
    expect(Redacted.value(val)).toBe("hello")
  })

  it("file-json: extracts a top-level field", async () => {
    const dir = tmpDir()
    const p = path.join(dir, "creds.json")
    fs.writeFileSync(p, JSON.stringify({ token: "tok-abc123" }))
    const val = await run(get(`file-json:${p}#token`))
    expect(Redacted.value(val)).toBe("tok-abc123")
  })

  it("file-json: extracts a nested dotted field", async () => {
    const dir = tmpDir()
    const p = path.join(dir, "nested.json")
    fs.writeFileSync(p, JSON.stringify({ a: { b: "nested-value" } }))
    const val = await run(get(`file-json:${p}#a.b`))
    expect(Redacted.value(val)).toBe("nested-value")
  })

  it("re-reads on every get() (rotation support)", async () => {
    const dir = tmpDir()
    const p = path.join(dir, "rotating.txt")
    fs.writeFileSync(p, "first-value\n")

    const first = await run(get(`file:${p}`))
    expect(Redacted.value(first)).toBe("first-value")

    fs.writeFileSync(p, "second-value\n")
    const second = await run(get(`file:${p}`))
    expect(Redacted.value(second)).toBe("second-value")
  })
})

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("FilePathSecretProvider — error cases", () => {
  it("rejects a relative path", async () => {
    const exit = await runExit(get("file:relative/path.txt"))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = JSON.stringify(exit.cause)
      expect(cause).toContain("ConfigError")
      expect(cause).toContain("absolute")
    }
  })

  it("rejects a path with '..'", async () => {
    const exit = await runExit(get("file:/tmp/../etc/passwd"))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = JSON.stringify(exit.cause)
      expect(cause).toContain("ConfigError")
    }
  })

  it("rejects an empty path", async () => {
    const exit = await runExit(get("file:"))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = JSON.stringify(exit.cause)
      expect(cause).toContain("ConfigError")
      expect(cause).toContain("empty")
    }
  })

  it("rejects a missing file (ConfigError)", async () => {
    const exit = await runExit(
      get("file:/tmp/__fp_test_definitely_not_here_abc123.txt"),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("ConfigError")
    }
  })

  it("rejects an oversized file (> FILE_SIZE_CAP_BYTES)", async () => {
    const dir = tmpDir()
    const p = path.join(dir, "big.txt")
    // Write FILE_SIZE_CAP_BYTES + 1 bytes.
    fs.writeFileSync(p, Buffer.alloc(FILE_SIZE_CAP_BYTES + 1, 0x61))
    const exit = await runExit(get(`file:${p}`))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = JSON.stringify(exit.cause)
      expect(cause).toContain("ConfigError")
      expect(cause).toContain("cap")
    }
  })

  it("rejects a directory (lstat → not isFile())", async () => {
    const dir = tmpDir()
    const exit = await runExit(get(`file:${dir}`))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = JSON.stringify(exit.cause)
      expect(cause).toContain("ConfigError")
      expect(cause).toContain("regular file")
    }
  })

  it("file-json: rejects non-string JSON value (number)", async () => {
    const dir = tmpDir()
    const p = path.join(dir, "num.json")
    fs.writeFileSync(p, JSON.stringify({ count: 42 }))
    const exit = await runExit(get(`file-json:${p}#count`))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = JSON.stringify(exit.cause)
      expect(cause).toContain("ConfigError")
      expect(cause).toContain("not a string")
    }
  })

  it("file-json: rejects empty-string JSON value", async () => {
    const dir = tmpDir()
    const p = path.join(dir, "empty.json")
    fs.writeFileSync(p, JSON.stringify({ token: "" }))
    const exit = await runExit(get(`file-json:${p}#token`))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = JSON.stringify(exit.cause)
      expect(cause).toContain("ConfigError")
      expect(cause).toContain("empty string")
    }
  })

  it("file-json: rejects missing field", async () => {
    const dir = tmpDir()
    const p = path.join(dir, "nofield.json")
    fs.writeFileSync(p, JSON.stringify({ other: "value" }))
    const exit = await runExit(get(`file-json:${p}#token`))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = JSON.stringify(exit.cause)
      expect(cause).toContain("ConfigError")
      expect(cause).toContain("not found")
    }
  })

  it("file-json: rejects malformed JSON (ConfigError with 'malformed JSON')", async () => {
    const dir = tmpDir()
    const p = path.join(dir, "bad.json")
    fs.writeFileSync(p, "{not valid json")
    const exit = await runExit(get(`file-json:${p}#token`))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = JSON.stringify(exit.cause)
      expect(cause).toContain("ConfigError")
      expect(cause).toContain("malformed JSON")
    }
  })

  it("file-json: rejects ref missing '#' field separator", async () => {
    const dir = tmpDir()
    const p = path.join(dir, "ok.json")
    fs.writeFileSync(p, JSON.stringify({ token: "x" }))
    const exit = await runExit(get(`file-json:${p}`))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = JSON.stringify(exit.cause)
      expect(cause).toContain("ConfigError")
      expect(cause).toContain("separator")
    }
  })

  it("non-file ref is rejected (ConfigError — passes through for firstOf)", async () => {
    const exit = await runExit(get("env:SOME_VAR"))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("ConfigError")
    }
  })
})
