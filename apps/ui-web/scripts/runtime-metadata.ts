export interface RuntimeMetadataInput {
  readonly env?: Record<string, string | undefined>
  readonly startedAt?: Date
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

  return [
    "# Session Metadata",
    "- **Interface:** Luna WebSocket chat",
    "- **User:** local operator",
    `- **Runtime profile:** ${profile}`,
    `- **Runtime scope:** ${runtimeScope}`,
    `- **Server:** ${serverName}`,
    `- **Started:** ${startedAt.toISOString()}`,
  ].join("\n")
}
