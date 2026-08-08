/**
 * chat-host.ts - the single reader of `window.LunaChatHost` (see
 * luna-chat-host.d.ts for the ambient type and chat.html's construction-site
 * comment for the publish side), plus the two ctx factories every React
 * component in this directory mounts with.
 *
 * `CHAT_HOST_MEMBERS` is the compile-time half of the membership drift
 * guard: a member added to or removed from `LunaChatHostApi` without a
 * matching edit here is a missing/excess-property error under `bun run
 * typecheck` (a CI gate). test/luna-chat-host.parity.test.ts is the runtime
 * half, asserting the real object chat.html constructs against
 * `CHAT_HOST_MEMBER_NAMES` - together they catch drift in both directions,
 * because chat.html's own classic-script block sits outside this app's
 * tsconfig (`include: ["frontend-react/src/**\/*"]`).
 *
 * Every accessor below reads `window.LunaChatHost` at CALL time, never at
 * module-load or mount time - load-bearing for two reasons: (1) the shipped
 * page's load order (classic script, then this module) is INVERTED in
 * test/helpers/chat-harness.ts (React mounts first, the classic script
 * evaluates after), so an eager read would see `undefined` there; (2)
 * chat.html's PoolEngine dark flag patches `WebSocketEngine.send` in place
 * AFTER construction, and several tests spy on `internals().WebSocketEngine.
 * send` after the host is built - a captured reference would miss both the
 * patch and the spy.
 */
import type { ExecuteResult } from "@luna/capabilities"
import type { ComposerConfigBridge, ComposerConfigCtx } from "./ComposerConfig"
import type { LunaChatHostApi } from "./luna-chat-host"
import type { SlashMenuCtx } from "./SlashMenu"

export function getChatHost(): LunaChatHostApi | null {
  return window.LunaChatHost ?? null
}

/** Compile-time member manifest - see this file's module doc. */
export const CHAT_HOST_MEMBERS: Record<keyof LunaChatHostApi, true> = {
  state: true,
  backendCapabilities: true,
  isConnected: true,
  send: true,
  executeCapability: true,
  appendMessage: true,
  newConversation: true,
  autoGrowMessageInput: true,
  closeLocalShellMenu: true,
  buildMessageMeta: true,
}
export const CHAT_HOST_MEMBER_NAMES: readonly string[] = Object.keys(CHAT_HOST_MEMBERS).sort()

/** What every SlashMenuCtx call resolves when the whole host is unavailable
 * (module evaluated before chat.html's classic script ran) - the ctx-level
 * counterpart of chat.html's own per-member absent-provider degrade (see
 * luna-chat-host.d.ts's `executeCapability` doc). */
const HOST_ABSENT: ExecuteResult = { ok: false, error: "chat host unavailable", reason: "unavailable" }

export function chatHostComposerCtx(): ComposerConfigCtx {
  return {
    getState: () => getChatHost()?.state() ?? null,
    send: (frame) => getChatHost()?.send(frame),
  }
}

export function chatHostSlashMenuCtx(peers: {
  getComposerConfig: () => ComposerConfigBridge | null
  clearAttachments: () => void
}): SlashMenuCtx {
  return {
    getState: () => getChatHost()?.state() ?? null,
    getComposerConfig: peers.getComposerConfig,
    clearAttachments: peers.clearAttachments,
    getBackendCommands: () => getChatHost()?.backendCapabilities() ?? [],
    executeCapability: (req) => getChatHost()?.executeCapability(req) ?? Promise.resolve(HOST_ABSENT),
    appendMessage: (role, text) => getChatHost()?.appendMessage(role, text),
    newConversation: () => getChatHost()?.newConversation(),
    closeLocalShellMenu: () => getChatHost()?.closeLocalShellMenu(),
    autoGrowMessageInput: () => getChatHost()?.autoGrowMessageInput(),
  }
}
