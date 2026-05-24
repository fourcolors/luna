/**
 * Sentinel secret_ref for accounts that should use the Claude Code login
 * already present in CLAUDE_CONFIG_DIR instead of a broker-injected token.
 */
export const CLAUDE_CODE_LOGIN_SECRET_REF = "claude-code:login" as const

export const isClaudeCodeLoginSecretRef = (ref: string): boolean =>
  ref === CLAUDE_CODE_LOGIN_SECRET_REF
