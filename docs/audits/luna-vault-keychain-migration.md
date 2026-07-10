# Luna Vault architecture and operations

Last verified against the implementation: 2026-07-10.

Luna Vault is a credential registry plus a tiered secret-storage system. The
registry stores metadata and opaque refs only. Credential values live in macOS
Keychain, Luna's encrypted file vault, `.env`, an op-token store, or 1Password.

## Security invariants

- `vault_items` never stores credential values. Its `ref` column is a pointer
  such as `env:OPENAI_API_KEY` or
  `luna-op://primary/Personal/item-id/credential`.
- Server-to-client `vault-list` frames contain metadata, refs, and derived
  status flags only. Values travel upward only in `vault-put` and
  `vault-import` requests and are never echoed in status frames or logs.
- `UI_WS_TOKEN` and every case-insensitive `LUNA_*` name are reserved. They
  remain in `.env` and cannot be added, adopted, migrated, or removed through
  Vault credential mutations.
- Explicit env-secret deletion scrubs every possible storage tier, not only
  the current write tier. This prevents a value written under an older mode
  from reappearing after a restart or mode switch.
- A present but undecryptable Luna vault is an integrity failure, not a cache
  miss. `auto` mode refuses boot; runtime resolution stops before the `.env`
  fallback so stale plaintext cannot silently win.

Authoritative implementation:

- Registry, reconciliation, mutations, and 1Password sync:
  `packages/vault/src/`
- Encrypted file format and provider:
  `packages/core/src/secret-provider/luna-vault-file.ts` and
  `luna-vault-backend.ts`
- Read-chain composition and boot integrity gate:
  `apps/ui-web/scripts/secret-chain.ts`
- Write/delete routing: `apps/ui-web/scripts/vault-secret-store.ts`
- Production assembly and websocket handle:
  `apps/ui-web/scripts/chat-server.ts`
- Wire validation and broadcast behavior: `packages/ui-ws/src/server.ts`

## Storage modes

`LUNA_VAULT_STORAGE` is read once at server boot.

| Effective mode | Env-secret read order | New env-secret writes |
| --- | --- | --- |
| unset, `auto`, or unknown | Routed 1Password, file refs, Keychain on Darwin, Luna encrypted vault, environment | Keychain on Darwin; Luna encrypted vault elsewhere |
| `env` | Routed 1Password, file refs, environment | `~/.luna/.env` |
| `keychain-preferred` or `keychain-only` on Darwin | Routed 1Password, file refs, Keychain, environment | Keychain |
| either keychain mode off Darwin | Normalized to `auto` | Luna encrypted vault |

`auto` is the default. `env` is the explicit plaintext escape hatch. The two
keychain modes remain migration states; their read chains are intentionally
the same. Their operational difference is whether migrated rollback copies
still remain in `.env`.

Every successful env-secret write is also mirrored into `process.env`, so the
running process can resolve it immediately. Reserved names always route to
`.env` regardless of mode.

### Encrypted Luna vault

On non-Darwin `auto` writes to:

- `~/.luna/vault/vault.key`
- `~/.luna/vault/secrets.enc`

The store uses AES-256-GCM with a fresh IV per write, authenticated ciphertext,
owner-only permissions, atomic rename, directory fsync, in-process mutation
serialization, and a cross-process lock. Key rotation stages `vault.key.new`
and the read path recovers an interrupted rotation.

Back up `vault.key` and `secrets.enc` together. Neither file is independently
useful, and restoring only one creates an intentional boot-time integrity
failure. Preserve directory mode `0700` and file modes `0600`.

```bash
tar -czf luna-vault-backup.tar.gz -C ~/.luna vault

mkdir -p ~/.luna
tar -xzf luna-vault-backup.tar.gz -C ~/.luna
chmod 700 ~/.luna/vault
chmod 600 ~/.luna/vault/vault.key ~/.luna/vault/secrets.enc
```

Exclude only the legacy plaintext file from Time Machine, never all of
`~/.luna`:

```bash
tmutil addexclusion ~/.luna/.env
```

## Registry lifecycle

At boot the reconciler adopts non-reserved `.env` names and live op-token
labels that do not already have registry rows. It reads names only, never env
values. Manual saves, agent `request_secret`, settings token capture, and
1Password sync also update the registry.

Display names are unique case-insensitively. On automatic collision handling,
Vault tries the source name, then `Name (origin)`, then numbered forms such as
`Name (origin) #2`. A manual rename onto a name owned by another ref is rejected
before the backing credential is written.

Deletion validates that the row kind agrees with its ref before touching
either metadata or the backing credential. Invalid rows fail closed and remain
available for operator repair.

## 1Password behavior

1Password service-account tokens are discovered per configured account label.
Secret refs use explicit account routing (`luna-op://<label>/...`) when more
than one account exists. Tokens are passed to `op` only through the child
environment. Outbound values are passed to `op item create -` through stdin,
never argv.

The optional sync engine lists item metadata, adopts or refreshes registry
rows, clears vanished outbound links, and applies bounded backoff. It does not
copy 1Password item values into `vault_items`. Removing a 1Password-backed row
from Luna does not delete the 1Password item; the UI warns that it can reappear
on the next sync.

## Migrating legacy `.env` secrets

The migration CLI chooses Keychain on Darwin and the encrypted Luna vault on
every other platform. Reserved names are always skipped, and output contains
names only.

```bash
# Preview the target and names. No writes.
bun run vault:migrate-keychain:dry-run

# Copy eligible values; the required guard keeps .env intact.
bun run vault:migrate-keychain:apply

# After verifying normal operation and taking a backup, remove only values
# confirmed readable from the secure target at that moment.
bun apps/ui-web/scripts/vault-migrate-keychain.ts --prune-env
```

`--prune-env` is deliberately separate and destructive. Do not run it until
the secure target is backed up and both normal operation and rollback have
been verified. Roll back to legacy reads/writes with:

```bash
LUNA_VAULT_STORAGE=env bun run --filter '@luna/ui-web' server:chat
```

## Verification checklist

Automated regression:

```bash
bun run test -- \
  packages/vault/test \
  packages/core/src/secret-provider \
  apps/ui-web/scripts/secret-chain.test.ts \
  apps/ui-web/scripts/vault-secret-store.test.ts \
  apps/ui-web/scripts/vault-migrate-keychain.test.ts \
  packages/ui-ws/test/vault-frames.protocol.test.ts \
  packages/ui-ws/test/vault-routing.server.test.ts \
  packages/ui-ws/test/secret-request-bridge.test.ts \
  packages/ui-ws/test/vault-changes-hook.server.test.ts \
  apps/ui-web/src/studio/vault-panel.test.jsx \
  packages/ui-shared-solid/test/vault-panel.test.tsx \
  packages/ui-shared-solid/test/vault-panel-sync.test.tsx \
  packages/ui-shared/test/vault-reducer.test.ts \
  apps/ui-moon-tauri/test/panel-vault.test.ts
```

Live canary:

1. Start the chat server in the intended mode and connect Moon or the web UI.
2. Confirm `vault-list` shows metadata only and reports the expected storage
   mode/write tier.
3. Add a disposable env-secret, resolve it without restarting, and confirm it
   landed in the expected tier rather than `.env`.
4. Delete it and confirm it stays absent after restart and after switching
   modes.
5. If sync is enabled, run one inbound pass and verify collision-renamed rows
   remain stable across a second no-change pass.
6. Before pruning, restart once with `LUNA_VAULT_STORAGE=env` to prove the
   rollback copy still works.

## 2026-07-10 audit fixes

The audit added regression coverage and fixes for:

- manual same-ref rename onto another credential's occupied name;
- kind/ref mismatch deletion that previously removed metadata without deleting
  the backing credential;
- second-level display-name collisions across capture, boot reconciliation,
  inbound sync, and imports;
- repeated 1Password churn of numbered collision names; and
- malformed optional `vault-sync-config` websocket fields.
