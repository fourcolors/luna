// @vitest-environment jsdom
/**
 * mention-menu.test.ts — pins for the composer's "@agent" popover
 * (agent sidebar S4).
 *
 * Two layers, mirroring the module's own split:
 *   1. The PURE token grammar + insertion (findMentionToken / matchAgents /
 *      insertMention) — the whole defense against "@ is not a reserved
 *      character" (emails, code blocks, closed tokens).
 *   2. The ENGINE against real DOM nodes: open/filter/keyboard/accept/
 *      capability gating, driven exactly the way wiring.ts drives it.
 */
import { beforeEach, describe, expect, it } from "vitest"
import {
  createMentionMenu,
  findMentionToken,
  insertMention,
  matchAgents,
  type MentionMenuEngine,
} from "../frontend-react/src/chat/mentionMenu"

// ── 1. Pure grammar ─────────────────────────────────────────────────────────

describe("findMentionToken", () => {
  const at = (value: string, caret?: number) =>
    findMentionToken(value, caret ?? value.length)

  it("opens on a bare @ and mid-sentence after whitespace", () => {
    expect(at("@")).toEqual({ from: 0, to: 1, fragment: "" })
    expect(at("can you ask @adv")).toEqual({ from: 12, to: 16, fragment: "adv" })
  })

  it("never opens inside an email or a compound word (the email guard)", () => {
    expect(at("mail sterling@gmail")).toBeNull()
    expect(at("a@b")).toBeNull()
  })

  it("closes when the fragment hits whitespace", () => {
    expect(at("@advisor ")).toBeNull()
    expect(at("@advisor please")).toBeNull()
  })

  it("scans from the CARET, not the end (mid-string edits)", () => {
    //        0123456789012345
    const s = "please @aud review"
    expect(findMentionToken(s, 11)).toEqual({ from: 7, to: 11, fragment: "aud" })
    // Caret past the closing space → no token.
    expect(findMentionToken(s, 12)).toBeNull()
  })

  it("lowercases the fragment for filtering", () => {
    expect(at("@ADV")?.fragment).toBe("adv")
  })
})

describe("matchAgents / insertMention", () => {
  const roster = [
    { name: "advisor", description: "critiques" },
    { name: "auditor", description: "audits" },
    { name: "dev-agent", description: "ships" },
  ]

  it("prefix-matches case-insensitively", () => {
    expect(matchAgents(roster, "a").map((a) => a.name)).toEqual(["advisor", "auditor"])
    expect(matchAgents(roster, "dev").map((a) => a.name)).toEqual(["dev-agent"])
    expect(matchAgents(roster, "z")).toEqual([])
  })

  it("inserts over the token with a trailing space at end-of-input", () => {
    const token = findMentionToken("@adv", 4)!
    expect(insertMention("@adv", token, "advisor")).toEqual({
      value: "@advisor ",
      caret: 9,
    })
  })

  it("does NOT double the space when accepting mid-sentence", () => {
    const s = "please @aud review this"
    const token = findMentionToken(s, 11)!
    const res = insertMention(s, token, "auditor")
    expect(res.value).toBe("please @auditor review this")
    expect(res.value).not.toContain("  ")
    // Caret lands after the inserted name, before the existing space.
    expect(res.value.slice(res.caret)).toBe(" review this")
  })
})

// ── 2. Engine against real DOM ──────────────────────────────────────────────

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

interface Rig {
  readonly engine: MentionMenuEngine
  readonly ta: HTMLTextAreaElement
  readonly menu: HTMLElement
  readonly type: (value: string, caret?: number) => void
  readonly State: Record<string, unknown>
}

const makeRig = (opts?: {
  readonly capability?: boolean
  readonly agents?: ReadonlyArray<{ name: string; description: string }>
}): Rig => {
  document.body.innerHTML =
    '<textarea id="message-input"></textarea>' +
    '<div id="mention-menu" class="slash-menu" role="listbox" aria-hidden="true"></div>'
  const ta = document.getElementById("message-input") as HTMLTextAreaElement
  const menu = document.getElementById("mention-menu") as HTMLElement
  const State: Record<string, unknown> = {
    serverSupportsAgents: opts?.capability ?? true,
    agents: opts?.agents ?? [
      { name: "advisor", description: "critiques plans" },
      { name: "auditor", description: "audits results" },
    ],
  }
  const engine = createMentionMenu({
    Logger: noopLogger,
    DOM: { messageInput: ta, mentionMenu: menu },
    State,
  })
  const type = (value: string, caret?: number) => {
    ta.value = value
    const c = caret ?? value.length
    ta.setSelectionRange(c, c)
    engine.onInput()
  }
  return { engine, ta, menu, type, State }
}

describe("createMentionMenu (DOM engine)", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  it("opens on @, paints rows via textContent, filters, and closes on no-match", () => {
    const rig = makeRig()
    rig.type("@")
    expect(rig.engine.isOpen()).toBe(true)
    expect(rig.menu.classList.contains("open")).toBe(true)
    expect(rig.menu.querySelectorAll(".mention-item").length).toBe(2)

    rig.type("@adv")
    expect(rig.menu.querySelectorAll(".mention-item").length).toBe(1)
    expect(rig.menu.textContent).toContain("@advisor")

    rig.type("@zzz")
    expect(rig.engine.isOpen()).toBe(false)
    expect(rig.menu.classList.contains("open")).toBe(false)
  })

  it("stays closed without the capability, and closes on a capability downgrade", () => {
    const rig = makeRig({ capability: false })
    rig.type("@")
    expect(rig.engine.isOpen()).toBe(false)

    rig.State["serverSupportsAgents"] = true
    rig.type("@")
    expect(rig.engine.isOpen()).toBe(true)
    rig.engine.applyCapability(false)
    expect(rig.engine.isOpen()).toBe(false)
  })

  it("never opens for emails or on slash-command input", () => {
    const rig = makeRig()
    rig.type("mail sterling@gmail")
    expect(rig.engine.isOpen()).toBe(false)
    rig.type("/model @a") // slash territory — mutually exclusive
    expect(rig.engine.isOpen()).toBe(false)
  })

  it("move wraps and accept inserts the highlighted agent at the caret", () => {
    const rig = makeRig()
    rig.type("@a")
    rig.engine.move(1) // advisor → auditor
    expect(rig.engine.accept()).toBe(true)
    expect(rig.ta.value).toBe("@auditor ")
    expect(rig.ta.selectionStart).toBe(9)
    expect(rig.engine.isOpen()).toBe(false)
  })

  it("escaped/typed-but-unaccepted state clears aria and rows on close", () => {
    const rig = makeRig()
    rig.type("@a")
    expect(rig.ta.getAttribute("aria-activedescendant")).toBe("mention-item-advisor")
    rig.engine.close()
    expect(rig.ta.hasAttribute("aria-activedescendant")).toBe(false)
    expect(rig.menu.getAttribute("aria-hidden")).toBe("true")
    expect(rig.menu.textContent).toBe("")
  })

  it("applyAgents refreshes an OPEN menu and drops malformed rows", () => {
    const rig = makeRig()
    rig.type("@")
    expect(rig.menu.querySelectorAll(".mention-item").length).toBe(2)
    rig.engine.applyAgents([
      { name: "advisor", description: "v2" },
      { bogus: true },
      "garbage",
    ])
    expect(rig.menu.querySelectorAll(".mention-item").length).toBe(1)
    expect(rig.menu.textContent).toContain("v2")
  })

  it("mousedown-accept works without blurring the composer (wiring contract)", () => {
    const rig = makeRig()
    rig.type("@aud")
    const row = rig.menu.querySelector(".mention-item") as HTMLElement
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    row.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true) // focus never leaves the textarea
    expect(rig.ta.value).toBe("@auditor ")
  })
})
