---
name: luna-agent-cli-testing
description: How to run and smoke-test the `luna` agent-cli (account/memory commands) against a throwaway database without touching the real ~/.luna/luna.db.
---

# Testing the `luna` agent-cli

## Invoke the CLI

From `apps/agent-cli` in the repo:

```sh
cd apps/agent-cli
bun run src/luna.ts <command>   # e.g. `account list`, `account add ...`, `doctor`
```

`bin: luna` points at `src/luna.ts` (shebang `#!/usr/bin/env bun`); there is also
`bun run luna -- ...` via the package.json script. Requires bun (uses `bun:sqlite`).

## Isolate the database

- `account add` and `account rm` accept `--db-path <path>`.
- `account list` takes NO args — point it at a temp db with the `LUNA_DB_PATH`
  env var, which `defaultDbPath()` (src/db.ts) honors for every command:

```sh
export LUNA_DB_PATH=/tmp/luna-test/test.db
bun run src/luna.ts account list          # -> "no accounts", exit 0 (db auto-created)
```

The db's parent dir is auto-created; the `accounts` schema is applied via the
`schema_versions` migration ladder on `openDb`, so a fresh path is fully usable.

## Expected outputs / exit codes (happy-path reference)

- `account list` empty: `no accounts`, exit 0
- `account add --id X --label L --kind anthropic --secret-ref env:FOO`:
  `added account id=X kind=anthropic`, exit 0
- `account list` non-empty: TSV with header `id\tlabel\tkind\tsecret_ref`
- `account rm --id X`: `removed account id=X`, exit 0
- `account rm --id <missing>`: `error: no such account: <id>` on stderr, exit 1
- `--secret-ref file:...` is rejected: `error: file: refs are not resolvable...`, exit 1
  (file refs never resolve in the server's SecretProvider chain)
- Valid secret-ref forms: `op://...`, `luna-op://<label>/<rest>`, `env:<VAR>`,
  `claude-code:login`

## Notes

- Command implementations return a `CmdResult` ({exitCode, stdout, stderr}); the
  citty wrappers in `src/commands/account/index.ts` write them and call
  `process.exit`. Testing the exported functions directly (e.g. in a bun REPL)
  is an alternative when arg-parsing isn't what's under test.
- `bun run src/luna.ts` can be slow to print on first invocation (workspace
  resolution); give the first run ~30s before assuming a hang.

## Devin Secrets Needed

None — the account commands never resolve secrets (pointer-mover only).
