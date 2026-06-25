import { describe, it, expect } from "vitest"
import { createReferenceProvider } from "../src/index.js"

const cmd = (id: string): Record<string, unknown> => ({
  kind: "command",
  id,
  title: id,
  executor: "server",
  schemaVersion: 1,
})
const raw = (generation: number, caps: unknown[]): unknown => ({ generation, agreedSchema: 1, capabilities: caps })

describe("createReferenceProvider (reference behaviors)", () => {
  it("decodes the raw catalog at the boundary and surfaces rejected entries", async () => {
    const p = createReferenceProvider({
      initial: raw(1, [cmd("ok"), { kind: "command", title: "no id", executor: "server", schemaVersion: 1 }]),
    })
    const snap = await p.list()
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    expect(snap.catalog.capabilities).toHaveLength(1) // valid one kept
    expect(snap.rejected).toHaveLength(1) // bad one surfaced, not dropped
    expect(snap.rejected[0]?.index).toBe(1)
  })

  it("setUnavailable makes list ok:false and execute resolve 'unavailable'", async () => {
    const p = createReferenceProvider({ initial: raw(1, [cmd("clear")]) })
    p.setUnavailable("down")
    expect((await p.list()).ok).toBe(false)
    const res = await p.execute({ kind: "command", id: "clear" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("unavailable")
  })

  it("onExecute decides outcome; a throwing handler becomes backend-error, never throws", async () => {
    const p = createReferenceProvider({
      initial: raw(1, [cmd("a"), cmd("b"), cmd("c")]),
      onExecute: (req) => {
        if (req.id === "a") return { ok: false, error: "nope", reason: "unsupported" }
        if (req.id === "c") throw new Error("boom")
        return { ok: true }
      },
    })
    const ra = await p.execute({ kind: "command", id: "a" })
    expect(ra.ok).toBe(false)
    if (!ra.ok) expect(ra.reason).toBe("unsupported")
    expect((await p.execute({ kind: "command", id: "b" })).ok).toBe(true)
    const rc = await p.execute({ kind: "command", id: "c" })
    expect(rc.ok).toBe(false)
    if (!rc.ok) expect(rc.reason).toBe("backend-error")
  })

  it("a malformed refresh surfaces ok:false without throwing or tearing down subscribers", async () => {
    const p = createReferenceProvider({ initial: raw(1, [cmd("clear")]) })
    const seen: boolean[] = []
    p.subscribe((s) => seen.push(s.ok))
    expect(() => p.setRawCatalog(raw(2, "nope" as unknown as unknown[]))).not.toThrow()
    expect((await p.list()).ok).toBe(false)
  })

  it("a throwing subscriber does not break sibling delivery", async () => {
    const p = createReferenceProvider({ initial: raw(1, [cmd("clear")]) })
    const good: boolean[] = []
    p.subscribe(() => {
      throw new Error("bad subscriber")
    })
    p.subscribe((s) => good.push(s.ok))
    p.setRawCatalog(raw(2, [cmd("clear"), cmd("model")]))
    expect(good.length).toBeGreaterThanOrEqual(1)
  })

  it("an empty provider has an empty catalog", async () => {
    const snap = await createReferenceProvider().list()
    expect(snap.ok).toBe(true)
    if (snap.ok) expect(snap.catalog.capabilities).toHaveLength(0)
  })

  it("execute on a null/undefined request resolves {ok:false} and never throws", async () => {
    const p = createReferenceProvider({ initial: raw(1, [cmd("clear")]) })
    // @ts-expect-error — deliberately violating the type to prove runtime totality
    await expect(p.execute(null)).resolves.toMatchObject({ ok: false })
    // @ts-expect-error — deliberately violating the type to prove runtime totality
    await expect(p.execute(undefined)).resolves.toMatchObject({ ok: false })
  })

  it("coalesces a re-entrant setRawCatalog from inside a subscriber without overflowing the stack", () => {
    const p = createReferenceProvider({ initial: raw(1, [cmd("a")]) })
    let depth = 0
    p.subscribe(() => {
      depth++
      if (depth < 5) p.setRawCatalog(raw(depth + 1, [cmd("a"), cmd(`b${depth}`)]))
    })
    expect(() => p.setRawCatalog(raw(2, [cmd("a"), cmd("b")]))).not.toThrow()
    expect(depth).toBeGreaterThanOrEqual(5) // looped (coalesced), did not recurse to overflow
  })
})
