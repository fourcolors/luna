// @vitest-environment jsdom
/**
 * Attachments.test.tsx - focused unit coverage for mountAttachments and the
 * legacy bridge it returns, independent of chat.html's classic-script eval
 * (that integration path is covered by test/chat-window.test.ts's "Feature:
 * attachments composer" describe block and test/slash-menu.test.ts's
 * attachment-preservation cases, both via test/helpers/chat-harness.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mountAttachments, type AttachmentsMount } from "./Attachments"

let strip: HTMLDivElement
let error: HTMLDivElement
let mount: AttachmentsMount | null

beforeEach(() => {
  strip = document.createElement("div")
  strip.id = "attachments-strip"
  error = document.createElement("div")
  error.id = "attach-error"
  document.body.append(strip, error)
  mount = mountAttachments({ strip, error })
})

afterEach(() => {
  strip.remove()
  error.remove()
  mount = null
})

function chips(): HTMLElement[] {
  return Array.from(strip.querySelectorAll(".attachment-chip"))
}

describe("mountAttachments", () => {
  it("degrades to null when either container is missing", () => {
    expect(mountAttachments({ strip: null, error })).toBeNull()
    expect(mountAttachments({ strip, error: null })).toBeNull()
    expect(mountAttachments({ strip: null, error: null })).toBeNull()
  })

  it("mounts with both trays hidden and empty", () => {
    expect(strip.hidden).toBe(true)
    expect(error.hidden).toBe(true)
    expect(chips()).toHaveLength(0)
  })
})

describe("Attachments bridge - classify (pure)", () => {
  it("routes images / text / pdf / binary correctly", () => {
    const A = mount!.Attachments
    expect(A.classify({ type: "image/png", name: "shot.png" })).toBe("image")
    expect(A.classify({ type: "", name: "main.ts" })).toBe("text")
    expect(A.classify({ type: "text/plain", name: "notes" })).toBe("text")
    expect(A.classify({ type: "application/pdf", name: "doc.pdf" })).toBe("pdf")
    expect(A.classify({ type: "", name: "paper.pdf" })).toBe("pdf")
    expect(A.classify({ type: "application/octet-stream", name: "blob.bin" })).toBe("binary")
  })
})

describe("Attachments bridge - addFiles", () => {
  it("stages a text file: chip appears, strip un-hides, error stays hidden", async () => {
    const A = mount!.Attachments
    await A.addFiles([new File(["const x = 1"], "snippet.ts", { type: "text/plain" })])
    expect(A.items).toHaveLength(1)
    expect(strip.hidden).toBe(false)
    expect(chips()).toHaveLength(1)
    expect(strip.textContent).toContain("snippet.ts")
    expect(error.hidden).toBe(true)
  })

  it("declines an unsupported binary with a visible error and no staged item", async () => {
    const A = mount!.Attachments
    await A.addFiles([new File(["x"], "blob.bin", { type: "application/octet-stream" })])
    expect(A.items).toHaveLength(0)
    expect(error.hidden).toBe(false)
    expect(error.textContent).toContain("can't read blob.bin")
    // Product copy carries no em dash (plain dash only).
    expect(error.textContent).not.toContain("\u2014")
  })

  it("the per-turn cap (8) rejects a 9th file with a visible error", async () => {
    const A = mount!.Attachments
    A.items = Array.from({ length: 8 }, (_, i) => ({
      id: "att_" + i,
      kind: "text" as const,
      name: i + ".txt",
      text: "x",
    }))
    await A.addFiles([new File(["y"], "ninth.txt", { type: "text/plain" })])
    expect(A.items).toHaveLength(8)
    expect(error.textContent).toContain("Max 8 attachments")
  })
})

describe("Attachments bridge - remove/clear", () => {
  it("remove(id) drops exactly that item and clears the error", async () => {
    const A = mount!.Attachments
    A.items = [
      { id: "a", kind: "text", name: "a.txt", text: "1" },
      { id: "b", kind: "text", name: "b.txt", text: "2" },
    ]
    A.render()
    expect(chips()).toHaveLength(2)
    A.remove("a")
    expect(A.items.map((i) => i.id)).toEqual(["b"])
    expect(chips()).toHaveLength(1)
  })

  it("clicking a chip's × button removes that attachment", () => {
    const A = mount!.Attachments
    A.items = [{ id: "att_1", kind: "text", name: "a.txt", text: "hi" }]
    A.render()
    expect(chips()).toHaveLength(1)
    ;(strip.querySelector(".att-remove") as HTMLButtonElement).click()
    expect(A.items).toHaveLength(0)
    expect(strip.hidden).toBe(true)
  })

  it("clear() empties items and re-hides the strip", () => {
    const A = mount!.Attachments
    A.items = [{ id: "a", kind: "text", name: "a.txt", text: "1" }]
    A.render()
    expect(strip.hidden).toBe(false)
    A.clear()
    expect(A.items).toHaveLength(0)
    expect(strip.hidden).toBe(true)
  })
})

describe("Attachments bridge - items get/set (direct-property back-compat)", () => {
  it("setting .items directly does NOT auto-repaint; render() forces the repaint", () => {
    const A = mount!.Attachments
    A.items = [{ id: "att_x", kind: "text", name: "notes.txt", text: "notes" }]
    // Matches the vanilla plain-field semantics: a bare write has no
    // immediate DOM effect until render() (or a mutating method) runs.
    expect(chips()).toHaveLength(0)
    A.render()
    expect(chips()).toHaveLength(1)
    expect(A.items).toHaveLength(1)
  })
})

describe("Attachments bridge - wireAttachments / textBlock / previews", () => {
  it("wireAttachments carries images/PDFs; textBlock folds text files in XML tags; previews describes all three", () => {
    const A = mount!.Attachments
    A.items = [
      { id: "1", kind: "image", name: "p.png", mediaType: "image/png", data: "AAAA" },
      { id: "2", kind: "pdf", name: "d.pdf", mediaType: "application/pdf", data: "BBBB" },
      { id: "3", kind: "text", name: "n.md", text: "# hi" },
    ]
    expect(A.wireAttachments()).toEqual([
      { mediaType: "image/png", data: "AAAA" },
      { mediaType: "application/pdf", data: "BBBB" },
    ])
    expect(A.textBlock()).toBe('<attached-file name="n.md">\n# hi\n</attached-file>')
    expect(A.previews()).toEqual([
      { kind: "image", name: "p.png", src: "data:image/png;base64,AAAA" },
      { kind: "pdf", name: "d.pdf", src: null },
      { kind: "text", name: "n.md", src: null },
    ])
  })

  it("wireAttachments returns undefined (not an empty array) when nothing wire-eligible is staged", () => {
    const A = mount!.Attachments
    A.items = [{ id: "1", kind: "text", name: "n.md", text: "hi" }]
    expect(A.wireAttachments()).toBeUndefined()
  })
})

describe("Attachments bridge - setError", () => {
  it("setError paints synchronously and independent of items/render()", () => {
    const A = mount!.Attachments
    A.setError("boom")
    expect(error.hidden).toBe(false)
    expect(error.textContent).toBe("boom")
    A.setError(null)
    expect(error.hidden).toBe(true)
    expect(error.textContent).toBe("")
  })
})

describe("Attachments bridge - hasAny", () => {
  it("reflects whether any item is staged", () => {
    const A = mount!.Attachments
    expect(A.hasAny()).toBe(false)
    A.items = [{ id: "a", kind: "text", name: "a.txt", text: "1" }]
    expect(A.hasAny()).toBe(true)
  })
})
