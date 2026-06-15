# Luna Vault Keychain Migration Runbook

Moves Vault **env-secret values** out of plaintext `~/.luna/.env` and into the
macOS Keychain (`luna.vault.<VARNAME>`), without changing the public `env:*`
ref format, the `vault_items` pointer schema, Linux/non-Darwin behavior, or 1Password
sync. Roll-out is **dual-read → copy-only migration → (later) prune**, so every
step is reversible with one env var until the explicit prune release.

## Storage modes

Selected by `LUNA_VAULT_STORAGE` (read once at server boot). Non-Darwin always
normalizes to `env` — Linux/non-Darwin never shells out to `security`.

| Mode | Read order (`env:*`) | Write target | When |
| --- | --- | --- | --- |
| `env` (default) | RoutedOp → `.env` | `.env` | current behavior; default for first release |
| `keychain-preferred` | RoutedOp → **Keychain** → `.env` | Keychain (+ `process.env` mirror) | Darwin canary; `.env` kept as rollback |
| `keychain-only` | RoutedOp → **Keychain** → `.env`* | Keychain (+ `process.env` mirror) | only after a successful canary + prune |

`process.env` is mirrored on every write, so a newly-saved secret resolves
live in the running process — no restart needed for the write itself.

\* **Why `keychain-only` still reads `.env`:** reserved names are **never**
migrated to the Keychain — connector OAuth tokens (`env:LUNA_CONNECTOR_*`) and
`UI_WS_TOKEN` live only in `.env`. The two keychain modes therefore share a
read chain (`RoutedOp → Keychain → .env`); the difference is operational, not
in the reader. In `keychain-preferred` the migrated values still sit in `.env`
as the rollback copy. In `keychain-only` the **prune** step has removed those
migrated (non-reserved) values from `.env`, so they resolve from the Keychain
only — and the `.env` tail then serves the reserved refs alone and can never
resurrect a migrated secret. Dropping the `.env` reader entirely would strand
every connector, so it stays.

## Migration (copy-only, non-destructive)

```bash
# 1. Keep plaintext .env (and Keychain) out of Time Machine backups.
tmutil addexclusion ~/.luna

# 2. See what would move — read-only, prints NAMES only, writes nothing.
bun run vault:migrate-keychain:dry-run

# 3. Copy eligible .env values into the Keychain. Leaves .env intact.
#    (--keep-env is required in this version as a destructive-migration guard.)
bun run vault:migrate-keychain:apply

# 4. Restart the server in dual-read mode.
LUNA_VAULT_STORAGE=keychain-preferred bun apps/ui-web/scripts/chat-server.ts
```

Reserved names (`UI_WS_TOKEN`, `LUNA_*`, case-insensitive — including
`LUNA_CONNECTOR_*`) are **never** migrated; they stay in `.env`. Connector
OAuth secrets keep using the `.env` path unchanged.

## Verification

After starting in `keychain-preferred`:

1. Moon connects to the server; an existing account answers a chat turn
   (`env:ANTHROPIC_API_KEY` resolves from Keychain, else falls through to `.env`).
2. Vault list still shows metadata only (no values in DOM / frames / logs).
3. Add a new env-secret in the Vault UI → it resolves immediately after save
   and lands in `luna.vault.<NAME>` (not `.env`).
4. Delete that test secret → it disappears from the Keychain and the UI.
5. If 1Password sync is configured, run it and confirm no values appear in logs.

## Rollback

```bash
LUNA_VAULT_STORAGE=env bun apps/ui-web/scripts/chat-server.ts
```

Because migration was copy-only, every value is still in `.env`. Rollback is
just dropping the Keychain provider from the read chain. **This must pass
before any prune work.**

## Prune (separate, explicit, post-canary — NOT part of this release)

```bash
bun apps/ui-web/scripts/vault-migrate-keychain.ts --prune-env
```

Removes a `.env` line **only** for a name that is confirmed readable from the
Keychain right now (and is not reserved). Run prune only after at least one
normal day of `keychain-preferred` usage and a successful rollback drill. After
prune, switch to `keychain-only`.

## Platform notes

- **Darwin**: full read/write/delete against the login Keychain via the
  `security` CLI. Values pass as `execFile` argv (no shell), never logged.
- **Linux/non-Darwin**: `LUNA_VAULT_STORAGE` is forced to `env`. The Keychain helpers
  fail closed without shelling out; the migration CLI's `--apply`/`--prune-env`
  refuse on non-Darwin. `--dry-run` works everywhere (preview only).
