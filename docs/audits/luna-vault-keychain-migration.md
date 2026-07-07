# Luna Vault Keychain Migration Runbook

Moves Vault **env-secret values** out of plaintext `~/.luna/.env` and into a platform-appropriate secure store: the macOS Keychain (`luna.vault.<VARNAME>`) on Darwin, or Luna's own encrypted vault (`~/.luna/vault/*`) on Linux and every other non-Darwin platform (see "Linux migration" below).
Neither target changes the public `env:*` ref format, the `vault_items` pointer schema, or 1Password sync.
Roll-out is **dual-read → copy-only migration → (later) prune**, so every step is reversible with one env var until the explicit prune release.

## Storage modes

Selected by `LUNA_VAULT_STORAGE` (read once at server boot). Non-Darwin always
normalizes to `env` - Linux/non-Darwin never shells out to `security`.

| Mode | Read order (`env:*`) | Write target | When |
| --- | --- | --- | --- |
| `env` (default) | RoutedOp → `.env` | `.env` | current behavior; default for first release |
| `keychain-preferred` | RoutedOp → **Keychain** → `.env` | Keychain (+ `process.env` mirror) | Darwin canary; `.env` kept as rollback |
| `keychain-only` | RoutedOp → **Keychain** → `.env`* | Keychain (+ `process.env` mirror) | only after a successful canary + prune |

`process.env` is mirrored on every write, so a newly-saved secret resolves
live in the running process - no restart needed for the write itself.

\* **Why `keychain-only` still reads `.env`:** reserved names are **never**
migrated to the Keychain - connector OAuth tokens (`env:LUNA_CONNECTOR_*`) and
`UI_WS_TOKEN` live only in `.env`. The two keychain modes therefore share a
read chain (`RoutedOp → Keychain → .env`); the difference is operational, not
in the reader. In `keychain-preferred` the migrated values still sit in `.env`
as the rollback copy. In `keychain-only` the **prune** step has removed those
migrated (non-reserved) values from `.env`, so they resolve from the Keychain
only - and the `.env` tail then serves the reserved refs alone and can never
resurrect a migrated secret. Dropping the `.env` reader entirely would strand
every connector, so it stays.

## Backups: what to exclude, what must travel together

Only exclude the plaintext env file from Time Machine, **not** the whole `~/.luna` directory:

```bash
tmutil addexclusion ~/.luna/.env
```

Why narrowed to `.env` specifically: on non-Darwin (and after a Darwin machine migrates to Luna's own vault tier), the secret store lives at `~/.luna/vault/vault.key` and `~/.luna/vault/secrets.enc`.
These two files **must** be backed up - `vault.key` is the only thing that makes `secrets.enc` decryptable, and `secrets.enc` alone is useless ciphertext.
Excluding all of `~/.luna` would silently stop backing up the vault key too, turning a routine backup restore into permanent secret loss.

**Moving to a new machine:** copy `vault.key` and `secrets.enc` **together, in the same operation**, preserving the `0600`/`0700` permissions on `~/.luna/vault/`.
Never copy one without the other - a store with a mismatched or missing key throws a `LunaVaultIntegrityError` at boot rather than silently losing secrets, so a partial copy is a boot-time discovery, not a silent one, but the correct fix is still to always move both files as a pair:

```bash
# on the old machine
tar -czf luna-vault-backup.tar.gz -C ~/.luna vault

# on the new machine
mkdir -p ~/.luna
tar -xzf luna-vault-backup.tar.gz -C ~/.luna
chmod 700 ~/.luna/vault
chmod 600 ~/.luna/vault/vault.key ~/.luna/vault/secrets.enc
```

The Keychain (Darwin) is backed up by macOS's own Keychain sync/backup mechanisms and is out of scope for this file-level guidance.

## Migration (copy-only, non-destructive)

The migration CLI is platform-aware: on Darwin it targets the macOS Keychain (as always); on Linux and every other non-Darwin platform it targets Luna's own encrypted vault instead of refusing.
The flag surface (`--dry-run` / `--apply --keep-env` / `--prune-env`) is identical on every platform - only the target differs, and `--dry-run` always prints which target it would use.
This script has no bearing on which tier `auto` storage mode writes new secrets to; it only relocates values still sitting in `.env`.

```bash
# 1. Keep the plaintext env file out of Time Machine backups.
tmutil addexclusion ~/.luna/.env

# 2. See what would move - read-only, prints NAMES only (and the target), writes nothing.
bun run vault:migrate-keychain:dry-run

# 3. Copy eligible .env values into the target. Leaves .env intact.
#    (--keep-env is required in this version as a destructive-migration guard.)
bun run vault:migrate-keychain:apply

# 4. Restart the server in dual-read mode.
LUNA_VAULT_STORAGE=keychain-preferred bun apps/ui-web/scripts/chat-server.ts
```

Reserved names (`UI_WS_TOKEN`, `LUNA_*`, case-insensitive - including
`LUNA_CONNECTOR_*`) are **never** migrated; they stay in `.env`. Connector
OAuth secrets keep using the `.env` path unchanged.

## Linux migration (Luna encrypted vault target)

Same three-step flow as Darwin, same flags, but targeting `~/.luna/vault/{vault.key,secrets.enc}` instead of the Keychain:

```bash
# 1. Preview - prints "target: Luna encrypted vault" plus toCopy/alreadyCopied/skippedReserved.
bun run vault:migrate-keychain:dry-run

# 2. Copy eligible .env values into the Luna vault. Leaves .env intact.
bun run vault:migrate-keychain:apply

# 3. Verify: restart the server and confirm existing accounts still resolve
#    secrets (auto mode reads the vault tier on non-Darwin), then re-run
#    --dry-run and confirm the previously-copied names now show under
#    alreadyCopied instead of toCopy.

# 4. Once verified, prune the now-redundant plaintext copies from .env.
#    Only removes a name that is confirmed readable back from the vault
#    right now - never removes a value it cannot re-resolve.
bun apps/ui-web/scripts/vault-migrate-keychain.ts --prune-env
```

Back up `~/.luna/vault/` (both files together, see above) before pruning.

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

## Prune (separate, explicit, post-canary - NOT part of this release)

```bash
bun apps/ui-web/scripts/vault-migrate-keychain.ts --prune-env
```

Removes a `.env` line **only** for a name that is confirmed readable from the
migration target right now (Keychain on Darwin, Luna's encrypted vault
elsewhere) and is not reserved. On Darwin, run prune only after at least one
normal day of `keychain-preferred` usage and a successful rollback drill, then
switch to `keychain-only`. On Linux, `LUNA_VAULT_STORAGE` server-side modes
are unaffected by this flag (it is unconditionally forced to `env` there
today) - prune is purely a `.env`-hygiene step once the vault copy is
confirmed, per "Linux migration" above.

## Platform notes

- **Darwin**: full read/write/delete against the login Keychain via the
  `security` CLI. Values pass as `execFile` argv (no shell), never logged.
  The migration CLI targets the Keychain here, unchanged since the original
  release of this runbook.
- **Linux/non-Darwin**: `LUNA_VAULT_STORAGE` is forced to `env` for the server's
  read chain (unchanged) - the Keychain helpers still fail closed without
  shelling out. The migration CLI, however, targets Luna's own encrypted
  vault (`~/.luna/vault/{vault.key,secrets.enc}`) rather than refusing:
  `--dry-run`, `--apply --keep-env`, and `--prune-env` all work, with the
  same copy-only / readability-checked-prune discipline as Darwin. See
  "Linux migration" above.
