/**
 * Browser harness for the multiroute client slice acceptance proof.
 *
 * Renders TWO panels side-by-side:
 *   - Panel A: luna-local  (WS → Luna stub)  — server-emitted descriptor
 *   - Panel B: hermes-local (HTTP → Hermes stub) — client-projected descriptor
 *
 * Visual differentiator (the slice acceptance criterion):
 *   Panel A shows a "Rollback" button because update.revertible === true
 *   Panel B has NO rollback button because update.revertible === false
 *
 * The stubs are started by serve.ts and inject their URLs+tokens as a
 * JSON config on window.__HARNESS_CONFIG__ before this module runs.
 */

import { ConnectionManager } from "../../pool/connection-manager.js"
import { LunaWsAdapter } from "../../adapters/luna-ws.js"
import { HermesHttpSseAdapter } from "../../adapters/hermes-http-sse.js"
import type { RouteConfig, AttachResult, ConnectionState, ChatSession } from "../../contract.js"
import type { ServerDescriptor } from "../../contract.js"

// ── Config injected by serve.ts ────────────────────────────────────────────────

interface HarnessConfig {
  lunaUrl: string
  lunaToken: string
  hermesUrl: string
  hermesToken: string
}

declare global {
  interface Window {
    __HARNESS_CONFIG__?: HarnessConfig
  }
}

function getConfig(): HarnessConfig {
  const cfg = window.__HARNESS_CONFIG__
  if (!cfg) {
    throw new Error(
      "Missing window.__HARNESS_CONFIG__ — was the page served via serve.ts?",
    )
  }
  return cfg
}

// ── Route map builder ─────────────────────────────────────────────────────────

function buildRoutes(cfg: HarnessConfig): ReadonlyMap<string, RouteConfig> {
  return new Map<string, RouteConfig>([
    [
      "luna-local",
      {
        routeKey: "luna-local",
        endpoints: [cfg.lunaUrl],
        tokenRef: cfg.lunaToken,
        label: "Luna (local stub)",
      },
    ],
    [
      "hermes-local",
      {
        routeKey: "hermes-local",
        endpoints: [cfg.hermesUrl],
        tokenRef: cfg.hermesToken,
        label: "Hermes (local stub)",
      },
    ],
  ])
}

// ── Adapter factory (browser-safe — no wsFactory injection needed here) ───────

function browserAdapterFactory(route: RouteConfig) {
  const firstEndpoint = route.endpoints[0] ?? ""
  const scheme = new URL(firstEndpoint).protocol
  if (scheme === "ws:" || scheme === "wss:") {
    // Browser WebSocket uses ?token= query string (defaultWsFactory in luna-ws.ts)
    return new LunaWsAdapter(route)
  }
  if (scheme === "http:" || scheme === "https:") {
    return new HermesHttpSseAdapter(route)
  }
  throw new Error(`No adapter for scheme: ${scheme}`)
}

// ── DOM helpers ────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const elem = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      elem.setAttribute(k, v)
    }
  }
  for (const child of children) {
    if (typeof child === "string") {
      elem.appendChild(document.createTextNode(child))
    } else {
      elem.appendChild(child)
    }
  }
  return elem
}

// ── Connection state dot ──────────────────────────────────────────────────────

function connectionDot(state: ConnectionState["status"]): HTMLElement {
  const dot = el("span", { class: `dot dot--${state}` })
  dot.title = state
  return dot
}

// ── Capabilities list ─────────────────────────────────────────────────────────

function capabilitiesList(descriptor: ServerDescriptor): HTMLElement {
  const ul = el("ul", { class: "caps-list" })
  for (const cap of descriptor.capabilities) {
    const available = cap.available ? "✓" : "✗"
    const scope = cap.authz.scope ? ` [${cap.authz.scope}]` : ""
    const li = el(
      "li",
      { class: cap.available ? "cap--available" : "cap--unavailable" },
      `${available} ${cap.operation}${scope}`,
    )
    if (cap.title) {
      li.title = cap.title
    }
    ul.appendChild(li)
  }
  return ul
}

// ── Panel class ────────────────────────────────────────────────────────────────

class Panel {
  readonly routeKey: string
  readonly #container: HTMLElement
  #handle: Awaited<ReturnType<ConnectionManager["acquire"]>> | null = null
  #session: ChatSession | null = null
  #connState: ConnectionState["status"] = "connecting"
  #connDotEl: HTMLElement
  #descriptorEl: HTMLElement
  #chatLog: HTMLElement
  #input: HTMLInputElement
  #sendBtn: HTMLButtonElement
  #rollbackBtnContainer: HTMLElement
  #originBadgeEl: HTMLElement

  constructor(routeKey: string, label: string) {
    this.routeKey = routeKey

    this.#connDotEl = connectionDot("connecting")
    this.#descriptorEl = el("div", { class: "descriptor-placeholder" }, "Connecting…")
    this.#chatLog = el("div", { class: "chat-log" })
    this.#input = el("input", {
      type: "text",
      placeholder: "Type a message…",
      disabled: "true",
      class: "chat-input",
    }) as HTMLInputElement
    this.#sendBtn = el("button", { disabled: "true", class: "send-btn" }, "Send") as HTMLButtonElement
    this.#rollbackBtnContainer = el("div", { class: "rollback-container" })
    this.#originBadgeEl = el("span", { class: "origin-badge" }, "–")

    const closeBtn = el("button", { class: "close-btn" }, "Close Panel")
    closeBtn.addEventListener("click", () => this.close())

    this.#sendBtn.addEventListener("click", () => this.#sendMessage())
    this.#input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault()
        this.#sendMessage()
      }
    })

    this.#container = el(
      "div",
      { class: "panel", id: `panel-${routeKey}` },
      el(
        "div",
        { class: "panel-header" },
        this.#connDotEl,
        el("span", { class: "panel-label" }, label),
        this.#originBadgeEl,
        closeBtn,
      ),
      el("div", { class: "panel-descriptor" }, this.#descriptorEl),
      this.#rollbackBtnContainer,
      el(
        "div",
        { class: "panel-chat" },
        this.#chatLog,
        el(
          "div",
          { class: "chat-controls" },
          this.#input,
          this.#sendBtn,
        ),
      ),
    )
  }

  get element(): HTMLElement {
    return this.#container
  }

  async connect(manager: ConnectionManager): Promise<void> {
    try {
      this.#handle = await manager.acquire(this.routeKey)
      this.#renderDescriptor(this.#handle.attachResult)
      this.#enableChat()

      // Monitor connection state changes
      void this.#watchConnectionState()
    } catch (err) {
      this.#descriptorEl.textContent = `Connection failed: ${err instanceof Error ? err.message : String(err)}`
      this.#descriptorEl.className = "descriptor-error"
    }
  }

  async #watchConnectionState(): Promise<void> {
    if (!this.#handle) return
    try {
      for await (const state of this.#handle.adapter.connection) {
        this.#connState = state.status
        const newDot = connectionDot(state.status)
        this.#connDotEl.replaceWith(newDot)
        this.#connDotEl = newDot
      }
    } catch {
      // Connection watcher terminated (panel closed)
    }
  }

  #renderDescriptor(result: AttachResult): void {
    const d = result.descriptor
    const origin = result.origin

    // Update origin badge
    this.#originBadgeEl.textContent = origin
    this.#originBadgeEl.className = `origin-badge origin-badge--${origin.replace(/[^a-z]/g, "-")}`

    // Build descriptor display
    const kindBadge = el("span", { class: `kind-badge kind-badge--${d.identity.kind}` }, d.identity.kind)
    const displayName = el("h2", { class: "server-name" }, d.identity.displayName ?? d.identity.name)
    const versionEl = el("div", { class: "server-version" }, `v${d.identity.version}`)
    const capsEl = capabilitiesList(d)
    const healthEl = el(
      "div",
      { class: `health health--${d.health.status}` },
      `Health: ${d.health.status}`,
    )

    this.#descriptorEl = el(
      "div",
      { class: "descriptor-content" },
      el("div", { class: "descriptor-top" }, displayName, kindBadge, versionEl),
      healthEl,
      el("h4", {}, "Capabilities"),
      capsEl,
    )

    const placeholder = this.#container.querySelector(".descriptor-placeholder, .descriptor-content, .descriptor-error")
    if (placeholder) {
      placeholder.replaceWith(this.#descriptorEl)
    }

    // ── THE DIFFERENTIATOR ───────────────────────────────────────────────────
    // Rollback button: PRESENT if update.revertible === true (Luna)
    //                  ABSENT  if update.revertible === false or update missing (Hermes)
    this.#renderRollbackButton(d)
  }

  #renderRollbackButton(d: ServerDescriptor): void {
    while (this.#rollbackBtnContainer.firstChild) {
      this.#rollbackBtnContainer.removeChild(this.#rollbackBtnContainer.firstChild)
    }

    if (d.update?.revertible === true) {
      const btn = el("button", { class: "rollback-btn" }, "⏪ Rollback")
      btn.title = `Rollback ${d.identity.displayName ?? d.identity.name} to previous version`
      btn.addEventListener("click", () => {
        this.#addChatLine("system", "[Rollback requested — stub only, no-op]")
      })
      this.#rollbackBtnContainer.appendChild(btn)
    }
    // If revertible is false or update is absent: no button rendered (no trace in DOM)
  }

  #enableChat(): void {
    this.#input.removeAttribute("disabled")
    this.#sendBtn.removeAttribute("disabled")
  }

  async #sendMessage(): Promise<void> {
    const text = this.#input.value.trim()
    if (!text || !this.#handle) return
    this.#input.value = ""
    this.#addChatLine("user", text)

    try {
      if (!this.#session) {
        this.#session = await this.#handle.adapter.openSession({})
        void this.#consumeSession(this.#session)
      }
      await this.#session.send({ text })
    } catch (err) {
      this.#addChatLine("error", `Send failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async #consumeSession(session: ChatSession): Promise<void> {
    let currentText = ""
    let currentEl: HTMLElement | null = null

    try {
      for await (const frame of session.messages) {
        if (frame.t === "delta") {
          if (!currentEl) {
            currentEl = el("div", { class: "chat-msg chat-msg--assistant" })
            this.#chatLog.appendChild(currentEl)
          }
          currentText += frame.text
          currentEl.textContent = currentText
          this.#chatLog.scrollTop = this.#chatLog.scrollHeight
        } else if (frame.t === "done") {
          currentText = ""
          currentEl = null
        } else if (frame.t === "error") {
          this.#addChatLine("error", `Error: ${frame.message}`)
          currentText = ""
          currentEl = null
        } else if (frame.t === "thread-snapshot") {
          // Render snapshot messages
          for (const msg of frame.messages) {
            this.#addChatLine(msg.role as "user" | "assistant", msg.content)
          }
        }
      }
    } catch {
      // Session terminated cleanly (panel closed)
    }
  }

  #addChatLine(
    role: "user" | "assistant" | "system" | "error",
    text: string,
  ): void {
    const div = el("div", { class: `chat-msg chat-msg--${role}` }, text)
    this.#chatLog.appendChild(div)
    this.#chatLog.scrollTop = this.#chatLog.scrollHeight
  }

  async close(): Promise<void> {
    // Close session first
    if (this.#session) {
      this.#session.close()
      this.#session = null
    }

    // Release the connection handle (decrements refcount; may dispose adapter)
    if (this.#handle) {
      await this.#handle.release()
      this.#handle = null
    }

    // Remove panel from DOM
    this.#container.remove()
  }
}

// ── Main harness entry point ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = getConfig()
  const routes = buildRoutes(cfg)
  const manager = new ConnectionManager(routes, browserAdapterFactory)

  const root = document.getElementById("panels-root")
  if (!root) throw new Error("Missing #panels-root in HTML")

  const lunaPanel = new Panel("luna-local", "Luna (WS · server-emitted)")
  const hermesPanel = new Panel("hermes-local", "Hermes (HTTP+SSE · client-projected)")

  root.appendChild(lunaPanel.element)
  root.appendChild(hermesPanel.element)

  // Connect both panels concurrently — proves concurrent multi-route binding
  await Promise.all([
    lunaPanel.connect(manager),
    hermesPanel.connect(manager),
  ])
}

main().catch((err) => {
  document.body.appendChild(
    el("div", { class: "fatal-error" }, `Fatal: ${err instanceof Error ? err.message : String(err)}`),
  )
})
