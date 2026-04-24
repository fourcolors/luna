/**
 * FileBackend Tier-1 tests — JSONL persistence + index behavior.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { Effect, Stream } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { FileBackend } from "../src/backends/file.js"
import { makeRecord } from "../src/types.js"

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-file-"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const fp = () => path.join(dir, "mem.jsonl")

const run = <A, E>(eff: Effect.Effect<A, E, FileBackend>, p = fp()) =>
  Effect.runPromise(eff.pipe(Effect.provide(FileBackend.fromPath(p))))

describe("FileBackend", () => {
  it("persists records as JSONL and reads them back", async () => {
    const out = await run(
      Effect.gen(function* () {
        const be = yield* FileBackend
        yield* be.put(
          makeRecord({ id: "a", namespace: "n", kind: "k", content: { x: 1 } }),
        )
        yield* be.put(
          makeRecord({ id: "b", namespace: "n", kind: "k", content: { x: 2 } }),
        )
        const got = yield* be.get("a")
        return got?.id
      }),
    )
    expect(out).toBe("a")

    // File must actually contain JSONL lines.
    const raw = fs.readFileSync(fp(), "utf8")
    const lines = raw.trim().split("\n")
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const line of lines) {
      expect(JSON.parse(line).op).toBe("put")
    }
  })

  it("reloads index from disk on fresh layer", async () => {
    const p = fp()
    await run(
      Effect.gen(function* () {
        const be = yield* FileBackend
        yield* be.put(makeRecord({ id: "persist", namespace: "n", kind: "k", content: {} }))
      }),
      p,
    )
    // Fresh layer pointing at the same file.
    const found = await run(
      Effect.gen(function* () {
        const be = yield* FileBackend
        return yield* be.get("persist")
      }),
      p,
    )
    expect(found?.id).toBe("persist")
  })

  it("delete writes a tombstone and removes from index", async () => {
    const p = fp()
    await run(
      Effect.gen(function* () {
        const be = yield* FileBackend
        yield* be.put(makeRecord({ id: "x", namespace: "n", kind: "k", content: {} }))
        yield* be.delete("x")
      }),
      p,
    )
    const reloaded = await run(
      Effect.gen(function* () {
        const be = yield* FileBackend
        return yield* be.get("x")
      }),
      p,
    )
    expect(reloaded).toBeNull()
  })

  it("skips malformed lines without crashing on reload", async () => {
    const p = fp()
    fs.writeFileSync(
      p,
      `not-json\n{"op":"put","rec":{"id":"ok","namespace":"n","kind":"k","content":1,"schemaVersion":1,"createdAt":1,"updatedAt":1,"tags":[]}}\n{broken\n`,
    )
    const found = await run(
      Effect.gen(function* () {
        const be = yield* FileBackend
        const got = yield* be.get("ok")
        const list = yield* Stream.runCollect(be.query({}))
        return { got: got?.id, count: Array.from(list).length }
      }),
      p,
    )
    expect(found).toEqual({ got: "ok", count: 1 })
  })
})
