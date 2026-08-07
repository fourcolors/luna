/**
 * resultToasts.ts - the background-result toast (#124, stack23 S19a).
 *
 * "Luna finished X", BROADCAST to every window rather than scoped to one
 * thread's subscribers, so a finished background job surfaces even when its
 * thread is not on screen. Lazily mounts its own `#result-toasts` container,
 * auto-dismisses after ~6.5s, and dismisses on click.
 *
 * THE FIRST S19 EXTRACTION BECAUSE IT HAS NO OUTBOUND EDGES. Unlike
 * ThreadCache, which needed chat.html to hand over `ThreadDrawerEngine.render`
 * (see the OUTBOUND-EDGE RULE in docs/next/stack23-slices.md), this reaches
 * nothing but `document` and timers - so it needs no ctx at all and the shim in
 * chat.html is a bare `var`.
 *
 * A FACTORY, NOT A SINGLETON: the toast list owns real per-instance state
 * (_host, _timers, _seq), and a module-level singleton would leak timers
 * across test files sharing a jsdom global.
 *
 * SAFE DOM THROUGHOUT: label and preview arrive from a server frame and are
 * written with `textContent` onto elements built by `createElement`. There is
 * no innerHTML here at all, which is why a hostile label cannot become markup.
 */

export interface ResultNotification {
  readonly label?: unknown
  readonly preview?: unknown
}

export interface ResultToastsApi {
  /** Show a toast; returns its id so a caller (or a test) can dismiss it. */
  show: (notification: ResultNotification | null | undefined) => string
  dismiss: (id: string) => void
  /** Test/harness hook: the live container, or null before the first show. */
  readonly _host: HTMLElement | null
}

/** Auto-dismiss delay. Long enough to read a one-line result, short enough
 *  that a burst of finished jobs does not stack up on screen. */
const AUTO_DISMISS_MS = 6500

/** Matches the CSS leave transition; the node is removed only after it. */
const LEAVE_MS = 220

export function createResultToasts(): ResultToastsApi {
  let host: HTMLElement | null = null
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let seq = 0

  function container(): HTMLElement {
    // Re-resolve when the previous host left the document: a test (or a
    // window teardown) can wipe document.body, and a cached detached node
    // would silently swallow every later toast.
    if (host && document.body.contains(host)) return host
    let el = document.getElementById("result-toasts")
    if (!el) {
      el = document.createElement("div")
      el.id = "result-toasts"
      document.body.appendChild(el)
    }
    host = el as HTMLElement
    return host
  }

  const api: ResultToastsApi = {
    get _host() {
      return host
    },

    show(notification) {
      const n = notification || {}
      const hostEl = container()
      const id = "rt-" + ++seq
      const toast = document.createElement("div")
      toast.className = "result-toast"
      toast.dataset["id"] = id

      const title = document.createElement("div")
      title.className = "rt-title"
      const star = document.createElement("span")
      star.textContent = "✓"
      const titleText = document.createElement("span")
      titleText.textContent = "Luna finished" + (n.label ? ": " + String(n.label) : "")
      title.appendChild(star)
      title.appendChild(titleText)
      toast.appendChild(title)

      if (n.preview) {
        const preview = document.createElement("div")
        preview.className = "rt-preview"
        preview.textContent = String(n.preview)
        toast.appendChild(preview)
      }

      const dismiss = () => api.dismiss(id)
      toast.addEventListener("click", dismiss)
      hostEl.appendChild(toast)
      timers.set(id, setTimeout(dismiss, AUTO_DISMISS_MS))
      return id
    },

    dismiss(id) {
      if (!host) return
      const toast = host.querySelector('.result-toast[data-id="' + id + '"]')
      const timer = timers.get(id)
      // Clear the timer even when the node is already gone, or a dismissed
      // toast leaves a pending callback behind.
      if (timer) {
        clearTimeout(timer)
        timers.delete(id)
      }
      if (!toast) return
      toast.classList.add("leaving")
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast)
      }, LEAVE_MS)
    },
  }
  return api
}
