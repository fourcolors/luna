/**
 * machineAccessPrompt.ts - the one-time machine-access consent banner.
 *
 * WHY: 0.0.73 flipped `fullAccess` from false to ON-by-default, keyed on
 * `luna_machine_access` in localStorage - a key that did not exist before
 * 0.0.73. So every user upgrading from 0.0.72 was switched on silently: the
 * release notes carried a warning, but the in-app updater shows no notes, so
 * the people auto-updating - the ones most affected - never saw it. This
 * banner is the in-app half of that consent: shown once, above the composer,
 * until the user answers.
 *
 * SEMANTICS, stated so nobody re-litigates them by accident:
 * - Shown only while `luna_machine_access` is ABSENT (never answered). Both
 *   settings-panel writes and this banner's writes end that state forever.
 * - While unanswered, the default stays ON (state.ts's DEFAULT ON is
 *   unchanged). This is consent SURFACING, not a gate: flipping to
 *   closed-until-answered would break every existing flow the default-on
 *   decision was made for. The banner exists so the state is now INFORMED.
 * - The dismiss x means "not now": the key stays absent, so the banner
 *   returns next launch. Only the two real buttons persist an answer.
 *
 * Wears the `.update-banner` skin (same anchor, same tokens) - it is the same
 * kind of surface: a calm one-shot nudge above the textarea. Not red, not an
 * alarm: machine access is a feature the user may well want; the banner's job
 * is telling them it is on and where the switch lives.
 *
 * Applying a choice mirrors the settings-connection toggle exactly: persist,
 * update State.localShell, recompute + re-announce the capability, and ping
 * the hub so OTHER windows re-read (the same `machine-access-changed` event
 * wiring.ts already handles).
 */

export interface MachineAccessPromptDeps {
  readonly Logger: { warn: (...a: unknown[]) => void }
  readonly State: { localShell: { fullAccess: boolean; enabled: boolean } }
  readonly LocalShell: {
    recomputeEnabled: () => void
    updateUI: () => void
    sendCapability: () => void
  }
}

export const MACHINE_ACCESS_KEY = "luna_machine_access"

/** True when the user has never answered - the only state that prompts. */
export function machineAccessUnanswered(storage: Pick<Storage, "getItem">): boolean {
  try {
    return storage.getItem(MACHINE_ACCESS_KEY) === null
  } catch (_) {
    return false // sandboxed storage: never prompt, never crash boot
  }
}

export function createMachineAccessPrompt(deps: MachineAccessPromptDeps) {
  const { Logger, State, LocalShell } = deps
  return {
    _el: null as HTMLElement | null,

    /** Same anchor as the update banner: directly before the composer's
     *  input wrap, so it lands where the eye already is. Null in stripped
     *  test DOMs, and callers degrade silently. */
    _anchor(): Element | null {
      return (
        document.querySelector(".chat-input-area .composer-input-wrap") ||
        document.querySelector(".composer-input-wrap")
      )
    },

    /** Show the banner iff the question has never been answered. */
    maybeShow(): void {
      if (this._el) return
      if (!machineAccessUnanswered(localStorage)) return
      const anchor = this._anchor()
      if (!anchor || !anchor.parentElement) return

      const el = document.createElement("div")
      el.className = "update-banner ma-consent"
      el.setAttribute("role", "region")
      el.setAttribute("aria-label", "Machine access notice")
      el.innerHTML =
        '<span class="ub-dot" aria-hidden="true"></span>' +
        '<div class="ub-text">' +
        '<div class="ub-title">Machine access is on</div>' +
        '<div class="ub-sub">Luna can read and run things on this Mac. Change anytime in Settings &gt; Connection.</div>' +
        "</div>" +
        '<div class="ub-actions">' +
        '<button type="button" class="ub-btn primary" data-ma="on">Keep on</button>' +
        '<button type="button" class="ub-btn" data-ma="off">Turn off</button>' +
        "</div>" +
        '<button type="button" class="ub-dismiss" aria-label="Not now">&times;</button>'

      el.addEventListener("click", (e) => {
        const t = e.target as HTMLElement
        const choice = t.closest("[data-ma]")?.getAttribute("data-ma")
        if (choice === "on" || choice === "off") {
          this._answer(choice)
        } else if (t.closest(".ub-dismiss")) {
          // Not now: no key write, so the question returns next launch.
          this._remove()
        }
      })

      anchor.parentElement.insertBefore(el, anchor)
      this._el = el
    },

    /** Persist the answer and apply it NOW, exactly like the settings toggle. */
    _answer(choice: "on" | "off"): void {
      try {
        localStorage.setItem(MACHINE_ACCESS_KEY, choice)
      } catch (_) {
        /* sandboxed - the in-memory apply below still holds for this session */
      }
      try {
        State.localShell.fullAccess = choice === "on"
        LocalShell.recomputeEnabled()
        LocalShell.updateUI()
        LocalShell.sendCapability()
      } catch (err) {
        Logger.warn("machine-access prompt apply failed:", err)
      }
      // Other windows re-read via the same hub event the settings panel uses.
      try {
        const w = window as unknown as {
          __TAURI__?: { core?: { invoke?: (cmd: string, args: unknown) => Promise<unknown> } }
        }
        w.__TAURI__?.core?.invoke?.("hub_event", { name: "machine-access-changed" })?.catch(() => {})
      } catch (_) {
        /* off-Tauri */
      }
      this._remove()
    },

    _remove(): void {
      const el = this._el
      this._el = null
      if (!el) return
      el.classList.add("leaving")
      // Match the update banner's leave animation; remove on either signal so
      // a test DOM without animation events still cleans up.
      const drop = () => el.remove()
      el.addEventListener("animationend", drop, { once: true })
      setTimeout(drop, 400)
    },
  }
}
