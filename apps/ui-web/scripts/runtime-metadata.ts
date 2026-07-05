export interface ChannelContext {
  /** Human-readable interface name, e.g. "Telegram". */
  readonly interface: string
  /** Platform chat/channel id. */
  readonly chatId?: string
  /** Platform user id. */
  readonly userId?: string
  /** Platform username (without leading @). */
  readonly username?: string
}

export interface RuntimeMetadataInput {
  readonly env?: Record<string, string | undefined>
  readonly startedAt?: Date
  /**
   * When present, renders Telegram/channel-specific identity lines instead of
   * the default "Luna WebSocket chat" / "local operator" lines.
   */
  readonly channelContext?: ChannelContext
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

export function inferChatServerName(profile: string): string {
  return profile === "stable"
    ? "luna-chat-server"
    : `luna-${profile}-chat-server`
}

export function buildSessionMetadata(input: RuntimeMetadataInput = {}): string {
  const env = input.env ?? process.env
  const profile = nonEmpty(env["LUNA_PROFILE"]) ?? "stable"
  const serverName =
    nonEmpty(env["LUNA_CHAT_SERVER_NAME"]) ?? inferChatServerName(profile)
  const runtimeScope = nonEmpty(env["LUNA_RUNTIME_SCOPE"]) ?? "host"
  const startedAt = input.startedAt ?? new Date()

  const ctx = input.channelContext

  // Interface + user lines: channel-specific when channelContext is present,
  // otherwise defaults for the WebSocket chat interface.
  const interfaceLine = ctx
    ? `- **Interface:** ${ctx.interface}`
    : "- **Interface:** Luna WebSocket chat"

  const userLine = ctx
    ? buildChannelUserLine(ctx)
    : "- **User:** local operator"

  const channelLines: string[] = []
  if (ctx?.chatId) {
    channelLines.push(`- **${ctx.interface} chat id:** ${ctx.chatId}`)
  }

  return [
    "# Session Metadata",
    interfaceLine,
    userLine,
    ...channelLines,
    `- **Runtime profile:** ${profile}`,
    `- **Runtime scope:** ${runtimeScope}`,
    `- **Server:** ${serverName}`,
    `- **Started:** ${startedAt.toISOString()}`,
  ].join("\n")
}

/** Render the user identity line for a channel context. */
function buildChannelUserLine(ctx: ChannelContext): string {
  if (ctx.username && ctx.userId) {
    return `- **User:** @${ctx.username} (id: ${ctx.userId})`
  }
  if (ctx.username) {
    return `- **User:** @${ctx.username}`
  }
  if (ctx.userId) {
    return `- **User:** id: ${ctx.userId}`
  }
  return "- **User:** unknown"
}
