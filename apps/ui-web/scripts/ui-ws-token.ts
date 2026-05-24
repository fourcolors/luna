export const resolveUiWsToken = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const token = env.UI_WS_TOKEN?.trim() || env.LUNA_UI_WS_TOKEN?.trim()
  if (!token) {
    throw new Error("UI_WS_TOKEN or LUNA_UI_WS_TOKEN must be set")
  }
  if (token.length < 16) {
    throw new Error("UI_WS_TOKEN or LUNA_UI_WS_TOKEN must be at least 16 characters")
  }
  return token
}
