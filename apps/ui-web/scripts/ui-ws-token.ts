// Resolves the chat server's OWN UI WebSocket secret.
//
// Finding #6 naming map:
//   UI_WS_TOKEN      = the canonical single-box server secret (preferred name).
//   LUNA_UI_WS_TOKEN = legacy/generic alias, kept ONLY for back-compat so older
//                      ~/.luna/.env files on disk keep authenticating.
// Never drop a name from this fallback chain — existing installs depend on it.
export const resolveUiWsToken = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const token = env.UI_WS_TOKEN ?? env.LUNA_UI_WS_TOKEN
  if (token === undefined || token.trim().length === 0) {
    throw new Error("UI_WS_TOKEN or LUNA_UI_WS_TOKEN must be set")
  }
  if (token.length < 16) {
    throw new Error("UI_WS_TOKEN or LUNA_UI_WS_TOKEN must be at least 16 characters")
  }
  return token
}
