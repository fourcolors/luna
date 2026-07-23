/**
 * Google Workspace — the flagship connector (PRD A, derisked 2026-06-10).
 *
 * Transport: a LOCALLY-RUN google_workspace_mcp (taylorwilsdon) in
 * streamable-HTTP + EXTERNAL_OAUTH21_PROVIDER + stateless mode — built
 * precisely for "the orchestrator owns OAuth": it expects
 * `Authorization: Bearer <google-access-token>` on every request and
 * validates it against Google. Luna mints those tokens from the stored
 * refresh token (ConnectorService access-token cache). Start it with:
 *
 *   MCP_ENABLE_OAUTH21=true EXTERNAL_OAUTH21_PROVIDER=true \
 *   WORKSPACE_MCP_STATELESS_MODE=true \
 *   GOOGLE_OAUTH_CLIENT_ID=<your client id> \
 *   uvx workspace-mcp --transport streamable-http --port 8765
 *
 * Auth: PER-OPERATOR Google OAuth client (PRD §23 - Google policy forbids
 * shipping client credentials in a public repo, and shared clients get
 * quota-throttled; the rclone lesson). One-time setup, ~10 minutes:
 *   1. console.cloud.google.com → new project
 *   2. Enable the Gmail, Calendar and Drive APIs
 *   3. OAuth consent screen → External → PUBLISH TO PRODUCTION
 *      (skipping this leaves the app in "Testing" where refresh tokens
 *      die every 7 days - the verified trap)
 *   4. Credentials → OAuth client ID → Desktop app
 *   5. Put GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in
 *      ~/.luna/.env (or paste into the Moon Connectors form)
 * First Connect shows Google's "unverified app" warning once -
 * Advanced → "Go to <app>" is the sanctioned personal-use path.
 * Operator guide: docs/connectors-google-oauth-setup.md (issue #107).
 *
 * Scopes (verified classifications): gmail.readonly + drive.readonly are
 * RESTRICTED (work unverified for personal use), calendar is sensitive,
 * drive.file is non-sensitive. Defaults follow the PRD §09 blessing:
 * mail read + calendar read/write + app-created Drive files; everything
 * else is an explicit opt-up in the consent sheet.
 */
import type { ConnectorDefinition } from "../types.js"

export const GOOGLE_WORKSPACE_CONNECTOR: ConnectorDefinition = {
  id: "google-workspace",
  name: "Google Workspace",
  blurb:
    "Gmail, Calendar and Drive. Luna can read your mail, manage events, and work with files — scoped to exactly what you grant.",
  category: "productivity",
  auth: {
    kind: "oauth2",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    clientIdEnvVar: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecretEnvVar: "GOOGLE_OAUTH_CLIENT_SECRET",
    // offline → refresh token; prompt=consent → re-issued even when the
    // operator reconnects (otherwise Google omits it on repeat grants).
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  transport: {
    kind: "mcp-remote",
    url: "http://127.0.0.1:8765/mcp/",
  },
  capabilities: [
    {
      id: "gmail-read",
      label: "Read your email",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      defaultGranted: true,
    },
    {
      id: "gmail-send",
      label: "Send email as you",
      scopes: ["https://www.googleapis.com/auth/gmail.send"],
      defaultGranted: false,
    },
    {
      id: "calendar",
      label: "Read & manage calendar events",
      scopes: ["https://www.googleapis.com/auth/calendar"],
      defaultGranted: true,
    },
    {
      id: "drive-app-files",
      label: "Files Luna creates or you open with it",
      scopes: ["https://www.googleapis.com/auth/drive.file"],
      defaultGranted: true,
    },
    {
      id: "drive-read-all",
      label: "Read ALL your Drive files",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      defaultGranted: false,
    },
  ],
  serverKey: "google_workspace",
}
