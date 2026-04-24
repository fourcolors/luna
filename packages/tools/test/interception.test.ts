/**
 * composeInterceptors Tier-1 tests.
 *
 * Invariants exercised:
 *  - denyByName matches → deny; non-match → pass
 *  - allowByName matches → allow; non-match → pass
 *  - redactInput strips keys on match; non-match → pass
 *  - compose: first non-pass wins; later interceptors NOT consulted
 *  - compose [] → default allow with original input
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  allowByName,
  composeInterceptors,
  denyByName,
  redactInput,
  type ToolInterceptor,
} from "../src/interception.js"

const run = <A>(eff: Effect.Effect<A, never>) => Effect.runPromise(eff)

describe("denyByName", () => {
  it("denies on match, passes on non-match", async () => {
    const d = denyByName(["Bash"])
    expect(await run(d("Bash", {}))).toMatchObject({ behavior: "deny" })
    expect(await run(d("Read", {}))).toBe("pass")
  })
})

describe("allowByName", () => {
  it("allows on match with input preserved, passes on non-match", async () => {
    const a = allowByName(["Read"])
    expect(await run(a("Read", { path: "/x" }))).toEqual({
      behavior: "allow",
      updatedInput: { path: "/x" },
    })
    expect(await run(a("Bash", {}))).toBe("pass")
  })
})

describe("redactInput", () => {
  it("strips listed keys on match; passes otherwise", async () => {
    const r = redactInput(["Fetch"], ["token", "password"])
    const hit = await run(
      r("Fetch", { url: "https://x", token: "sk-…", password: "p" }),
    )
    expect(hit).toEqual({
      behavior: "allow",
      updatedInput: { url: "https://x" },
    })
    expect(await run(r("Read", { token: "sk" }))).toBe("pass")
  })
})

describe("composeInterceptors", () => {
  it("empty list → default allow with original input", async () => {
    const fn = composeInterceptors([])
    const res = await run(fn("X", { a: 1 }))
    expect(res).toEqual({ behavior: "allow", updatedInput: { a: 1 } })
  })

  it("first non-pass wins; later interceptors not consulted", async () => {
    const calls: string[] = []
    const spy = (label: string, out: "pass" | "deny"): ToolInterceptor =>
      (toolName) =>
        Effect.sync(() => {
          calls.push(label)
          return out === "deny"
            ? { behavior: "deny", message: label }
            : "pass"
        })

    const fn = composeInterceptors([
      spy("first", "pass"),
      spy("second", "deny"),
      spy("third", "pass"),
    ])
    const res = await run(fn("Tool", {}))
    expect(res).toEqual({ behavior: "deny", message: "second" })
    // third must NOT run
    expect(calls).toEqual(["first", "second"])
  })

  it("deny-before-allow: deny applies, allow never consulted", async () => {
    const calls: string[] = []
    const track = (label: string, inner: ToolInterceptor): ToolInterceptor =>
      (n, i) =>
        Effect.sync(() => calls.push(label)).pipe(
          Effect.zipRight(inner(n, i)),
        )

    const fn = composeInterceptors([
      track("deny", denyByName(["Bash"])),
      track("allow", allowByName(["Bash"])),
    ])
    const res = await run(fn("Bash", {}))
    expect(res).toMatchObject({ behavior: "deny" })
    expect(calls).toEqual(["deny"])
  })

  it("all pass → default allow with original input", async () => {
    const fn = composeInterceptors([
      denyByName(["Other"]),
      allowByName(["Other"]),
    ])
    const res = await run(fn("Neither", { k: "v" }))
    expect(res).toEqual({ behavior: "allow", updatedInput: { k: "v" } })
  })
})
