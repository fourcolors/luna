# Server v0.5.3

Local-shell client fixes (PR #654) and a dream/wake reasoner fix (#655).
`UI_WS_PROTOCOL_VERSION` remains 2; no wire-version bump is required.

## Highlights

**Local shell (agent-cli).** `local-shell-result` frames now carry the
responding client's `clientId`. The server only accepts results from a
clientId the connection registered via `local-shell-capability`, so CLI
results without it were dropped — a `local_shell_run` targeted at the CLI
hung until timeout. Denied results carry it too. (PR #654)

**Local shell (Moon).** The `homeDir` fallback advertised in the capability
frame and used by cwd-less commands is now actually populated at boot via a
new `get_home_dir` Tauri command; with no attached root it previously stayed
empty and the command ran at the app process cwd. (PR #654)

**Dream/wake reasoner.** The single-shot reasoner turns no longer get
built-in tools; they are pure text turns, matching how the reasoner is
prompted. (PR #655)

## Migrations

No schema changes. No manual migration step is required.

## Verifying the update

```bash
systemctl status luna-chat-server        # active, no chdir errors
luna doctor                              # clean
```

Your server version is reported by `control.version`, sourced from
`server.version.json`.
