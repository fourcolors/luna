/**
 * logger.ts - the module-side copy of chat.html's Logger (stack23 S19f).
 *
 * THIS IS DELIBERATE, TIME-BOXED DUPLICATION and the only such copy in the
 * conversion. Logger is read from chat.html's classic TOP LEVEL, so it cannot
 * become a module-published global while chat.html still boots (the
 * BOOT-ORDER RULE). But three converted engines log, and until now
 * main-chat.tsx handed them `{ warn: console.warn }` - which silently dropped
 * the [Luna Warning] prefix that makes Moon's console readable.
 *
 * So: fourteen lines exist twice, with a written expiry. S20 deletes
 * chat.html's script and with it the other copy; nothing else needs to
 * happen for the duplication to resolve.
 *
 * The alternative was publishing Logger on window.LunaChatHost, which is
 * deliberately frozen at nine members - growing a contract that S20 deletes,
 * to carry a console wrapper, is the worse trade.
 */

export interface LunaLogger {
  info: (message?: unknown, ...args: unknown[]) => void
  warn: (message?: unknown, ...args: unknown[]) => void
  error: (message?: unknown, ...args: unknown[]) => void
}

export const Logger: LunaLogger = {
  prefix: "%c[Luna Companion]",
  style:
    "color: #8ab4f8; font-weight: bold; background: rgba(138, 180, 248, 0.08); padding: 2px 6px; border-radius: 4px;",

  info(message, ...args) {
    console.log(this.prefix, this.style, message, ...args)
  },
  warn(message, ...args) {
    console.warn("%c[Luna Warning]", "color: #f59e0b; font-weight: bold;", message, ...args)
  },
  error(message, ...args) {
    console.error("%c[Luna Error]", "color: #ef4444; font-weight: bold;", message, ...args)
  },
} as LunaLogger & { prefix: string; style: string }
