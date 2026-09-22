# Server v0.5.2

Dream reasoner prompt fix (PR #651). `UI_WS_PROTOCOL_VERSION` remains 2;
no wire-version bump is required.

## Highlights

**Dream reasoner.** The reasoner prompt's worked example referenced a belief
domain that is not valid; the example now uses a valid belief domain. No
behavioral change to the reasoner itself — the fix keeps the prompt's
documentation consistent with the domains the reasoner actually accepts.

## Migrations

No schema changes. No manual migration step is required.

## Verifying the update

```bash
systemctl status luna-chat-server        # active, no chdir errors
luna doctor                              # clean
```

Your server version is reported by `control.version`, sourced from
`server.version.json`.
