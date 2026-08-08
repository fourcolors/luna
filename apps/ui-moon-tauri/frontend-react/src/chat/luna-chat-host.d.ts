/**
 * luna-chat-host.d.ts - the ambient type for `window.LunaChatHost`, the
 * classic-script -> ES-module PRODUCTION contract chat.html's inline script
 * publishes (see chat.html's own construction-site comment for the publish
 * side and chat-host.ts for the single reader).
 *
 * NOT `__MoonInternals`: index.html's hub (hub/MoonHubApp.tsx) owns a real
 * `declare global` for `Window.__MoonInternals` with its own, unrelated
 * shape, and `declare global` merging requires every declaration of a
 * property to agree on one type - chat can therefore never give
 * `__MoonInternals` members an honest ambient type. A distinct name is the
 * only way to get a `.d.ts` plus a drift guard.
 *
 * Membership is pinned in TWO directions: this interface, checked at
 * compile time by chat-host.ts's `CHAT_HOST_MEMBERS` manifest (`bun run
 * typecheck`), and the runtime object chat.html actually constructs,
 * checked at test time by test/luna-chat-host.parity.test.ts. A member added
 * to or removed from one without the other fails one gate or the other.
 *
 * Grouped by LIFETIME, not by feature - that grouping is what makes later
 * deletions mechanical: Group A (the wire) is deleted as a unit by S18;
 * Group B (state reads) is retired per-field as owners convert; Group C
 * (imperative engine calls) is deleted by S19/S20 as those engines convert.
 */
import type { CapabilityDescriptor, ExecuteRequest, ExecuteResult } from "@luna/capabilities"
// @luna/ui-ws publishes only the "." export, which re-exports server.js plus
// every node-side bridge module alongside protocol.js - see
// packages/ui-shared/src/wire.ts's header for why that barrel is normally
// kept out of browser bundles. `import type` erases before bundling, so this
// is safe ONLY as long as it stays type-only: do not drop `type` here
// without first adding a `./protocol` subpath export to
// packages/ui-ws/package.json. (Same warning, verbatim, as
// src/chat/chat-ctx.ts's own note on its identical import.)
import type { ClientFrame } from "@luna/ui-ws"
import type { Delivery } from "./chatModel"

/** The live, mutable `State` object chat.html shares with its React modules
 * - the same object every frame handler mutates, never a copy. Names only
 * the fields the module side reads; `State` itself carries many more. */
export interface ChatHostState {
  activeThreadId: string | null
  threadModels: Record<string, string>
  threadEfforts: Record<string, string>
  serverSupportsEffort: boolean
  serverSupportsWorkflows: boolean
  serverSupportsTurnComplete: boolean
  selectedEffort: string | null
  pinnedThread: string | null
}

export interface LunaChatHostApi {
  // ── Group B - reads of classic-script state. Retired per-field as owners convert.
  readonly state: () => ChatHostState
  /** SYNCHRONOUS snapshot of `_backendCatalog.capabilities`. Deliberately NOT
   * the provider's own async `list()`/`subscribe()`: (1) buildCommands()
   * must resolve on every keystroke, and (2) chat.html clears this mirror on
   * EVERY hello (chat.html's own construction-site comment, server-swap
   * safety) while the provider's internal snapshot is untouched, because
   * `hello` is not one of the two frame types the provider subscribes to. */
  readonly backendCapabilities: () => readonly CapabilityDescriptor[]
  /** ENGINE-AWARE connectivity. Never derive this from a raw socket: PoolEngine,
   *  the default since #489, does not assign `State.ws` at all, so a readyState
   *  check reads "offline" while the pool is connected - which is exactly how
   *  secure secret entry silently died (#500). chat.html patches its own
   *  isConnected() to delegate to the active engine; this exposes that one. */
  readonly isConnected: () => boolean

  // ── Group A - the wire. S18 deletes BOTH of these together.
  readonly send: (frame: ClientFrame) => void
  readonly executeCapability: (req: ExecuteRequest) => Promise<ExecuteResult>

  // ── Group C - imperative calls into vanilla engines. S19/S20 delete these.
  readonly appendMessage: (role: string, text: string) => void
  readonly newConversation: () => void
  readonly autoGrowMessageInput: () => void
  readonly closeLocalShellMenu: () => void
  readonly buildMessageMeta: (text: string, ts: number | undefined, delivery: Delivery | null) => HTMLElement
}

declare global {
  interface Window {
    /** Published by chat.html's classic script. Optional on purpose: a
     * module evaluated outside chat.html, or before that script runs
     * (test/helpers/chat-harness.ts mounts React FIRST), must not assume it
     * is set - every reader goes through chat-host.ts's `getChatHost()`. */
    LunaChatHost?: LunaChatHostApi
  }
}
