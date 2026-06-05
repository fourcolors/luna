/**
 * client-info.ts — assembles the `ClientInfo` blob the TUI / readline UI
 * stamps onto every user-message frame.
 *
 * Pure, no IO. Reads from the process / env passed in.
 */
import type { ClientInfo } from "@luna/ui-ws"

export type ClientInfoSource = {
  /** Override the client name (default: "luna-tui" if !legacy, "luna-cli" if legacy). */
  readonly nameOverride?: string
  /** Set to true when the legacy readline UI is calling. */
  readonly legacy?: boolean
  /** Override the version (default: pulled from agent-cli package.json). */
  readonly version?: string
  /** node-style platform string; defaults to process.platform when omitted. */
  readonly platform?: NodeJS.Platform | string
}

/**
 * agent-cli's package.json semver, pinned at build time. Keep this in sync
 * with package.json on bumps. Tested by client-info.test.ts.
 */
export const AGENT_CLI_CLIENT_VERSION = "0.0.1"

export const buildClientInfo = (src: ClientInfoSource = {}): ClientInfo => {
  const name =
    src.nameOverride ?? (src.legacy === true ? "luna-cli-readline" : "luna-tui")
  return {
    name,
    version: src.version ?? AGENT_CLI_CLIENT_VERSION,
    platform: src.platform ?? process.platform,
  }
}
