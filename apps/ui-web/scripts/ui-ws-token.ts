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
