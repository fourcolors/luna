# luna-journal

A Claude Code mod that sends Luna a short journal of each coding session: a
2-4 line summary, the repo, branch and commit, and the files that changed.
Luna stores it as an episodic memory marked as external and untrusted, plus one
row in its notes ledger (`kind: claude_code_journal`).

Tested with Claude Code 2.1.291 (CLI, and the Desktop app Code tab from 2.1.286
on). Mods do not run in WSL sessions.

## When a journal arrives

**A journal reaches Luna when the next Claude Code session starts, not when
the session ends.** The mod never slows down a session. When a session ends it
only queues the entry on your Mac, because Claude Code gives all `session.end`
hooks 1.5 seconds in total before it exits. About 15 seconds after the next
session starts, the mod writes the summary with a small model and posts it.
The journal for the last session before a long break arrives when you next open
Claude Code.

Undelivered entries are kept and retried at each session start. An entry is
dropped after 5 failed attempts or 7 days, or straight away if Luna rejects it
as malformed (400, 413, 422). A `401`, `403` or `503` means the setup is not
right yet (wrong token, or the server has no token), so it does not count as an
attempt: the entry waits, up to 7 days, until the setup is fixed. A session that never ended cleanly (a crash or
`kill -9`) is picked up after 6 hours of inactivity and sent with the end
reason `crash-recovered`.

## What is sent, and what is not

Sent:
- the summary (at most 4 lines, secrets redacted);
- repo name, path, branch and commit, start and end times, host name, client
  and version;
- changed file paths, relative to the repo, with names such as `.env`, `*.pem`
  and `id_*` masked.

Never sent: the transcript, your prompts, or tool output. The summary model
sees only Claude's final answer from each turn, redacted at capture, capped at
600 characters per turn and 40 turns, and it runs on the same account the
session uses. Luna redacts again and builds the stored text itself.

The token travels only in the `Authorization` header. It is never logged, never
put in a URL and never written to the mod's store.

## 1. Set up the token on the Luna server

The route `POST /v1/journal` is off until the server has its own token. It
never accepts the main ui-ws token, because that token can drive the shell
bridge.

1. Generate a token (64 hex characters; the server refuses anything under 32):
   ```bash
   openssl rand -hex 32
   ```
2. Store it as `LUNA_JOURNAL_TOKEN` wherever the Luna server reads its
   environment (Luna's secret store, or the env file of the systemd unit). It
   must differ from `UI_WS_TOKEN` / `LUNA_UI_WS_TOKEN`.
3. Restart the Luna server. Without the token the route answers `503`.
4. Smoke test from the Mac (replace the host and token):
   ```bash
   curl -sS -X POST http://<luna-host>:4753/v1/journal \
     -H "Authorization: Bearer $LUNA_JOURNAL_TOKEN" -H "Content-Type: application/json" \
     -d '{"v":1,"source":"claude-code","session_id":"smoke-0001","entry_id":"smoke-entry-1","repo":"luna","repo_path":"/x","branch":"master","started_at":"2026-10-06T10:00:00Z","ended_at":"2026-10-06T10:05:00Z","summary":"Smoke test.","host":"mac","client":"claude-code-cli","client_version":"2.1.291"}'
   ```
   Expect `{"ok":true,"id":"ccj_...","deduped":false}`, and `"deduped":true`
   when you send it again. Then delete the smoke record from Luna's memory.

## 2. Get the mod onto the Mac

```bash
git clone <luna repo> ~/luna        # or: git -C ~/luna pull
```

The mod is `~/luna/integrations/claude-code/luna-journal`, and
`~/luna/integrations/claude-code` is a local plugin marketplace named
`luna-local` that lists it.

## 3a. Install it (recommended: local marketplace, CLI and Desktop)

```bash
claude plugin marketplace add ~/luna/integrations/claude-code
claude plugin install luna-journal@luna-local \
  --config luna_url=http://<luna-host>:4753/v1/journal
```

Then store the token as the mod's sensitive option. Claude Code keeps sensitive
options in the macOS Keychain, not in `settings.json`. Either run
`/plugin configure luna-journal@luna-local` inside Claude Code and paste it into
the masked field, or from a shell (this reads the token from your clipboard so
it never lands in shell history):

```bash
printf '{"luna_token":"%s"}' "$(pbpaste)" | claude plugin configure luna-journal@luna-local --values-stdin
claude plugin configure luna-journal@luna-local     # shows which options are set
```

Restart Claude Code. For the Desktop app, fully quit it (Cmd+Q) and reopen
it; its Code tab loads the same user-scope plugins. After you change the mod,
bump `version` in `.claude-plugin/plugin.json`, then run
`claude plugin marketplace update luna-local` and
`claude plugin install luna-journal@luna-local` again, because Claude Code
caches an installed plugin by version.

An installed plugin also avoids one network restriction: in
essential-traffic-only mode Claude Code refuses network calls from plugins
that have no marketplace, which includes `--plugin-dir` mods.

## 3b. Or load it from the folder (development)

For one session:

```bash
claude --plugin-dir ~/luna/integrations/claude-code/luna-journal
```

Saving a file in the folder reloads the mod in the running session; the
journal recorded so far for that session is kept. On load, Claude Code writes the
type declarations for your exact build into `.claude-plugin/types/`, which is
git-ignored; check them if a Claude Code update changes an API.

To load the folder in every CLI and Desktop session, add it to
`~/.claude/settings.json` (absolute path):

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/Users/<you>/luna/integrations/claude-code/luna-journal" },
  "pluginConfigs": {
    "luna-journal@inline": {
      "options": { "luna_url": "http://<luna-host>:4753/v1/journal", "model": "haiku", "enabled": true }
    }
  }
}
```

`claude plugin configure` only works on installed plugins, so a folder-loaded
mod cannot hold the token as a sensitive option. Put it in the Keychain
instead, which the mod reads with `security`:

```bash
security add-generic-password -s luna-journal -a "$USER" -U -w
# prompts for the token
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `luna_url` | none | Full URL of the route. Falls back to the `LUNA_JOURNAL_URL` env var. |
| `luna_token` | none | Sensitive. Falls back to the Keychain item `luna-journal`, then the `LUNA_JOURNAL_TOKEN` env var. |
| `model` | `haiku` | Model for the summary. If it fails or is not allowed, a plain summary is built from the turn and file counts. |
| `enabled` | `true` | `false` stops all capture and sending. |

## Check it end to end

1. Run a short session with one edit, then exit.
2. Start a new session and wait about 20 seconds.
3. In Luna, search memory for `External session journal`, or list recent notes
   of kind `claude_code_journal`.
4. If nothing arrives, the mod keeps a local log of its last 50 failures (status
   codes and short messages only) under the `log` key of its store in
   `~/.claude/plugins/store/`. Common causes: no URL or token configured (`config`),
   `401` (wrong token), `503` (token not set on the server), or a network
   policy refusing plugin network access.

## Develop

```bash
claude plugin validate --strict integrations/claude-code/luna-journal
claude plugin test integrations/claude-code/luna-journal
```

`hooks/lib.js` holds the pure helpers (redaction, file cleaning, prompt and
body building); `hooks/register.js` holds the hooks. The secret patterns are
kept in step with `apps/server/src/journal/journal-sink.ts`.
