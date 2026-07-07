/**
 * commands.ts — built-in channel slash commands.
 *
 * Transport-agnostic command interception for the inbound pipeline: a small
 * built-in verb set is handled at the CHANNEL level (before the message ever
 * reaches the LLM), while every unknown "/verb" falls through to Luna
 * unchanged — Luna's own skills answer those, exactly as they do for Moon.
 *
 * Parsing reuses @luna/capabilities' parseCommandLine, so a "/name args"
 * line means the same thing in Telegram as it does in Moon's slash menu and
 * agent-cli. Command ids follow Telegram's BotCommand constraints (1-32
 * chars, lowercase a-z, 0-9, underscore) so the same specs can be registered
 * verbatim via setMyCommands — but nothing here is Telegram-specific.
 *
 * Built-ins:
 *   /start — Telegram's first-contact convention: a greeting + what I can do.
 *   /help  — same content as /start, discoverable name.
 *   /new   — forget the channel↔thread mapping; next message starts a fresh
 *            Luna thread (old thread history is preserved server-side).
 *   /stop  — interrupt the in-flight turn on this channel's thread.
 *
 * Platform-mention handling ("/new@MyBot" in Telegram groups) is the
 * ADAPTER's job — by the time a ChannelMessage reaches handleChannelCommand
 * its text must already be normalized to a bare "/verb args" line.
 */
import { Effect } from "effect"
import { parseCommandLine } from "@luna/capabilities"
import { ChatService } from "@luna/chat-service"
import type { ChannelMessage } from "./types.js"
import { ChannelSessionStore, normalizeThreadingKey } from "./session-map.js"

/* -------------------------------------------------------------------------- */
/* Command catalog                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One built-in channel command. `id` is the verb without the leading "/"
 * (the @luna/capabilities canonical-prefix rule) and doubles as the Telegram
 * BotCommand `command` field; `description` doubles as its menu description
 * (Telegram limit: 1-256 chars).
 */
export interface ChannelCommandSpec {
  readonly id: string
  readonly description: string
}

/** The built-in command catalog, in menu display order. */
export const channelCommands: ReadonlyArray<ChannelCommandSpec> = [
  { id: "new", description: "Start a fresh conversation" },
  { id: "stop", description: "Stop the current response" },
  { id: "help", description: "What Luna can do here" },
]

const HELP_TEXT = [
  "🌙 **Hi, I'm Luna.**",
  "",
  "Send me anything and I'll get to work. While I'm working you'll see my steps live in the message.",
  "",
  ...channelCommands.map((c) => `/${c.id} - ${c.description}`),
  "",
  "Anything else you type goes straight to me.",
].join("\n")

/* -------------------------------------------------------------------------- */
/* Handler                                                                     */
/* -------------------------------------------------------------------------- */

/** Outcome of command interception for one inbound message. */
export interface ChannelCommandResult {
  /**
   * true — the message was a built-in command; it must NOT reach the LLM.
   * false — not a command (or an unknown "/verb"): continue the normal
   * pipeline so Luna's skills can handle it.
   */
  readonly handled: boolean
  /** Reply to deliver back on the same channel, when handled. */
  readonly reply?: string
}

const notHandled: ChannelCommandResult = { handled: false }

/**
 * Intercept built-in channel commands. Runs BEFORE lookupOrCreate/chat.send
 * in the inbound pipeline (see service.ts handleMessage): /new must be able
 * to drop the mapping without re-creating it, and command replies must not
 * spend an LLM turn.
 */
export const handleChannelCommand = (
  msg: ChannelMessage,
): Effect.Effect<ChannelCommandResult, never, ChannelSessionStore | ChatService> =>
  Effect.gen(function* () {
    const parsed = parseCommandLine(msg.text.trim())
    if (parsed === null || parsed.name.length === 0) return notHandled

    const name = parsed.name.toLowerCase()
    const store = yield* ChannelSessionStore
    const chat = yield* ChatService
    const threadingKey = normalizeThreadingKey(msg)

    switch (name) {
      // /start is Telegram's auto-sent first-contact message; keep it and
      // /help identical so both entry points teach the same things.
      case "start":
      case "help":
        return { handled: true, reply: HELP_TEXT }

      case "new": {
        yield* store.remove(msg.transport, msg.channelId, threadingKey)
        return { handled: true, reply: "✨ Fresh conversation started. What's next?" }
      }

      case "stop": {
        const threadId = yield* store.lookup(msg.transport, msg.channelId, threadingKey)
        if (threadId === null) {
          return { handled: true, reply: "Nothing is running right now." }
        }
        // Best-effort: ChatService.interrupt is a no-op on an idle thread.
        // The in-flight message (if any) also finalizes as "⏹ Stopped." via
        // the assistant-error(interrupted) frame in delivery.ts.
        yield* chat.interrupt(threadId)
        return { handled: true, reply: "⏹ Stopped." }
      }

      default:
        // Unknown verb: NOT handled — flows to Luna as plain text so skills
        // ("/remind …", "/status …") keep working across every channel.
        return notHandled
    }
  })
