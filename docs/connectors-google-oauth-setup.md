# Google Workspace connector: set up your OAuth client

Luna uses a **per-operator** Google OAuth client.
Google forbids shipping shared client credentials in a public repo, and shared clients get quota-throttled (the rclone lesson).
This is the industry pattern for unverified open-source tools (GAM, `gws auth setup`, rclone's "make your own client_id").

One-time setup.
About 10 minutes.

## Steps

1. Open [Google Cloud Console](https://console.cloud.google.com/projectcreate) and create a project (any name).
2. Enable the APIs Luna needs:
   - [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
   - [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
3. **OAuth consent screen** → User type **External** → fill the required app name / support email.
4. **Publish to Production.**
   Skipping this leaves the app in Testing mode, where refresh tokens die every 7 days.
   That is the most common "it worked last week and now needs reconnect" trap.
5. **Credentials** → Create credentials → OAuth client ID → Application type **Desktop app**.
6. Copy the Client ID and Client secret.
7. In Moon → Settings → Connectors → Google Workspace, paste both into the inline form and click **Save client**.
   You can also put `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` in `~/.luna/.env`.

## First Connect

1. Click **Connect**, pick the scopes you want, then confirm.
2. Moon opens Google's consent page in your system browser and waits on a loopback callback.
3. Google shows an **unverified app** warning once.
   Click **Advanced** → **Go to \<app\>** (the sanctioned personal-use path for unverified Desktop clients).
4. Grant the scopes.
   Moon captures the redirect and finishes the connection.

## Common failures

| What you see | What it usually means | What to do |
| --- | --- | --- |
| `access_denied` / "consent was declined" | Testing-mode app, account not on the test-user list; or you hit Deny | Add the account as a test user, or Publish to Production; retry Connect |
| `admin_policy_enforced` / org policy / "Access blocked" | A Google Workspace org blocks unverified third-party apps | Use a personal Gmail account, or ask the Workspace admin to allow the client |
| "Something went wrong" on Google's page, then a 5-minute timeout in Moon | Transient publish race, or the account chooser picked a blocked Workspace account | Close the tab, click Connect again, pick a personal Gmail in the account chooser |
| Timed out waiting for browser consent | Consent tab closed, hung, or never completed | Keep the consent tab open until grant completes, then retry |
| Connected last week, now "needs reauth" every few days | Consent screen still in **Testing** | Publish the consent screen to Production |

## Multi-account labels

You can connect more than one Google account under the same connector definition.
Each connection needs a distinct **label** (e.g. `personal`, `work`, `flowstay`).
Labels key the mount names the agent sees (`mcp__google_workspace__*` vs `mcp__google_workspace_<label>__*`) and the per-account token storage.
If you leave the second account on the default label, Luna rejects the duplicate before opening the browser.

## Distribution paths (tracking)

- **Today:** per-operator Desktop OAuth client + local `google_workspace_mcp` (streamable-HTTP, external OAuth 2.1 bearer).
- **Future:** a connector definition for Google's hosted Workspace MCP endpoints when they reach GA (transport already matches client-brokered bearer).
- **Maybe later:** a verified shared client (CASA assessment) only if distribution volume warrants the annual review cost.
  Thunderbird/K-9 are the rare exceptions that go this route.

## References

- Catalog definition: `packages/connectors/src/catalog/google-workspace.ts`
- Client-brokered OAuth: `packages/connectors/src/service.ts`, `packages/oauth`
- Moon loopback: `apps/ui-moon-tauri/src-tauri/src/main.rs` (`oauth_loopback_*`)
- Issue: [#107](https://github.com/fourcolors/luna/issues/107)
