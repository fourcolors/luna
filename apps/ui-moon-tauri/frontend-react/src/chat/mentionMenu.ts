/**
 * mentionMenu.ts - the composer's "@agent" popover (agent sidebar S4).
 *
 * WHY A NEW MODULE AND NOT A SlashMenu EDIT: the slash menu opens only
 * when the ENTIRE input starts with "/" and contains no space
 * (SlashMenu.tsx onInput) - a whole-input parser. A mention lands
 * MID-SENTENCE, so this module scans BACKWARDS from the caret instead:
 * the nearest "@" opens a token only when it starts the input or follows
 * whitespace (the email guard - "sterling@gmail" never opens), and the
 * token dies the moment its fragment contains whitespace. Sharing code
 * would mean rewriting SlashMenu's trigger, which is load-bearing product
 * surface; the two menus instead share only the popover CHROME (the
 * container reuses the .slash-menu CSS class) and the wiring contract
 * (isOpen/move/accept/complete/close/onInput - see wiring.ts's composer
 * keydown, which drives whichever menu is open; they are mutually
 * exclusive by trigger).
 *
 * IMPERATIVE DOM, NOT REACT, deliberately: rows are textContent-only
 * paints of server-provided metadata ({name, description} - the ui-ws
 * projection guarantees nothing else ever arrives), rebuilt whole on each
 * filter pass. No drag, no persistence, no cross-module DOM ownership -
 * the React-mount ceremony (a main-chat.tsx graph slot + a store) would
 * outweigh the ~40 lines it replaces. Mirrors the threadStrip.ts
 * discipline: build rows, wire them, attach.
 *
 * ACCEPT inserts `@name ` at the token, preserving the tail (and not
 * doubling a space the tail already starts with), then dispatches a
 * synthetic 'input' event so autoGrow and both menus' onInput re-run
 * through the ONE existing listener path (wiring.ts) rather than a side
 * channel.
 *
 * Gated on `capabilities.agents` (State.serverSupportsAgents, set by the
 * hello handler): an old server never opens the menu, and a bare "@"
 * stays ordinary text - the additive-degradation story every other
 * capability follows.
 */

/** One mentionable agent, as the agent-list frame delivers it. */
export interface MentionAgent {
  readonly name: string
  readonly description: string
}

/** The live @-token under the caret, or null. */
export interface MentionToken {
  /** Index of the "@" itself. */
  readonly from: number
  /** Caret position (exclusive end of the fragment). */
  readonly to: number
  /** Text between "@" and the caret, lowercased for filtering. */
  readonly fragment: string
}

/**
 * Scan backwards from the caret for an open mention token.
 * Pure - exported for direct unit testing.
 */
export function findMentionToken(value: string, caret: number): MentionToken | null {
  const upto = value.slice(0, caret)
  const at = upto.lastIndexOf("@")
  if (at === -1) return null
  // Token must OPEN a word: start of input, or preceded by whitespace.
  // Anything else ("sterling@gmail", "a@b") is prose, not a mention.
  if (at > 0 && !/\s/.test(upto.charAt(at - 1))) return null
  const fragment = upto.slice(at + 1)
  // Whitespace closes the token - "@advisor " is done being a mention.
  if (/\s/.test(fragment)) return null
  return { from: at, to: caret, fragment: fragment.toLowerCase() }
}

/** Filter the roster against a token fragment (prefix match, case-insensitive). */
export function matchAgents(
  agents: ReadonlyArray<MentionAgent>,
  fragment: string,
): ReadonlyArray<MentionAgent> {
  return agents.filter((a) => a.name.toLowerCase().startsWith(fragment))
}

/**
 * Insert an accepted mention over the token, returning the new value and
 * caret. Appends a trailing space only when the tail does not already
 * start with one (the mid-sentence double-space guard). Pure - exported
 * for direct unit testing.
 */
export function insertMention(
  value: string,
  token: MentionToken,
  name: string,
): { readonly value: string; readonly caret: number } {
  const tail = value.slice(token.to)
  const inserted = `@${name}${/^\s/.test(tail) ? "" : " "}`
  return {
    value: value.slice(0, token.from) + inserted + tail,
    caret: token.from + inserted.length,
  }
}

export interface MentionMenuCtx {
  readonly Logger: {
    info: (m?: unknown, ...a: unknown[]) => void
    warn: (m?: unknown, ...a: unknown[]) => void
    error: (m?: unknown, ...a: unknown[]) => void
  }
  /** The chat window's DOM registry - uses messageInput + mentionMenu. */
  readonly DOM: Record<string, HTMLElement | null>
  /** The LIVE State object, never a copy. */
  readonly State: Record<string, unknown>
}

export function createMentionMenu(ctx: MentionMenuCtx) {
  const { DOM, State } = ctx

  let open = false
  let index = 0
  let matches: ReadonlyArray<MentionAgent> = []
  let token: MentionToken | null = null

  const input = (): HTMLTextAreaElement | null =>
    (DOM["messageInput"] as HTMLTextAreaElement | null) ?? null
  const host = (): HTMLElement | null => DOM["mentionMenu"] ?? null

  const agents = (): ReadonlyArray<MentionAgent> =>
    (State["agents"] as ReadonlyArray<MentionAgent> | undefined) ?? []

  const enabled = (): boolean => State["serverSupportsAgents"] === true

  const paint = (): void => {
    const el = host()
    if (!el) return
    el.textContent = ""
    const hint = document.createElement("div")
    hint.className = "slash-menu-hint"
    hint.textContent =
      matches.length === 1
        ? `Enter brings in @${matches[0]!.name}`
        : "Type to filter · Enter accepts · Esc dismisses"
    el.appendChild(hint)
    matches.forEach((agent, i) => {
      const row = document.createElement("div")
      row.className = "slash-menu-item mention-item" + (i === index ? " active" : "")
      row.setAttribute("role", "option")
      row.id = `mention-item-${agent.name}`
      row.setAttribute("aria-selected", i === index ? "true" : "false")
      const name = document.createElement("span")
      name.className = "cmd"
      name.textContent = `@${agent.name}`
      row.appendChild(name)
      if (agent.description) {
        const desc = document.createElement("span")
        desc.className = "desc"
        desc.textContent = agent.description
        row.appendChild(desc)
      }
      // mousedown, not click - the composer must not blur before accept
      // (same contract as SlashMenu's mousedownAccept).
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault()
        acceptAt(i)
      })
      el.appendChild(row)
    })
    const ta = input()
    if (ta && matches[index]) {
      ta.setAttribute("aria-activedescendant", `mention-item-${matches[index]!.name}`)
    }
  }

  const close = (): void => {
    if (!open) return
    open = false
    token = null
    const el = host()
    if (el) {
      el.classList.remove("open")
      el.setAttribute("aria-hidden", "true")
      el.textContent = ""
    }
    const ta = input()
    if (ta) ta.removeAttribute("aria-activedescendant")
  }

  const onInput = (): void => {
    if (!enabled()) return close()
    const ta = input()
    if (!ta) return close()
    // Mutually exclusive with the slash menu by construction (a slash
    // input's "@" can never open a word after whitespace at position 0),
    // but keep the guard explicit and cheap: a whole-input "/" prefix is
    // SlashMenu territory.
    if (ta.value.startsWith("/")) return close()
    const found = findMentionToken(ta.value, ta.selectionStart ?? ta.value.length)
    if (!found) return close()
    const next = matchAgents(agents(), found.fragment)
    if (next.length === 0) return close()
    token = found
    matches = next
    if (index >= next.length) index = 0
    if (!open) {
      open = true
      index = 0
      const el = host()
      if (el) {
        el.classList.add("open")
        el.setAttribute("aria-hidden", "false")
      }
    }
    paint()
  }

  const acceptAt = (i: number): boolean => {
    const ta = input()
    const agent = matches[i]
    if (!open || !ta || !agent || !token) return false
    const res = insertMention(ta.value, token, agent.name)
    ta.value = res.value
    ta.setSelectionRange(res.caret, res.caret)
    close()
    ta.focus()
    // One canonical re-entry: wiring.ts's input listener runs autoGrow and
    // both menus' onInput off this event, exactly as if the user had typed.
    ta.dispatchEvent(new Event("input", { bubbles: true }))
    return true
  }

  return {
    isOpen: (): boolean => open,
    onInput,
    close,
    move: (delta: number): void => {
      if (!open || matches.length === 0) return
      index = (index + delta + matches.length) % matches.length
      paint()
    },
    /** Enter. Returns true when it consumed the key. */
    accept: (): boolean => acceptAt(index),
    /** Tab. Same accept semantics; separate name mirrors SlashMenu's API. */
    complete: (): boolean => acceptAt(index),
    /** hello: capability gate. Closing on downgrade keeps aria honest. */
    applyCapability: (on: unknown): void => {
      State["serverSupportsAgents"] = on === true
      if (on !== true) close()
    },
    /** agent-list frame: refresh the roster; re-filter if open. */
    applyAgents: (list: unknown): void => {
      State["agents"] = Array.isArray(list)
        ? list.filter(
            (a): a is MentionAgent =>
              !!a && typeof a.name === "string" && typeof a.description === "string",
          )
        : []
      if (open) onInput()
    },
  }
}

export type MentionMenuEngine = ReturnType<typeof createMentionMenu>
