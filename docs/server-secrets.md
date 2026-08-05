# Server secrets & durable model auth

Luna keeps secret **values** out of the repo entirely. Committed code only ever
references the **name** of a secret or a **pointer** to it; the value lives in the
runtime env file and is resolved at runtime.

## Where secrets live

| Where | Holds | Committed? |
|---|---|---|
| `$LUNA_HOME/.env` (default `/root/.luna/.env`, mode `600`) | the real values (`CLAUDE_CODE_OAUTH_TOKEN`, `UI_WS_TOKEN`) | **no** — `.env*` is gitignored |
| `luna.db` `accounts.secret_ref` | a **pointer** (`env:CLAUDE_CODE_OAUTH_TOKEN`, `claude-code:login`, `op://…`) | no (local DB) |
| Repo (installer, `setup-login.ts`, this doc) | variable **names** + pointer **strings** | yes — none of these is a secret |

Guardrails: `.env*` is gitignored; the CI **secret-scan is a hard gate** (greps
git-tracked files for `sk-ant-` keys + high-entropy runs and blocks the merge);
the autonomous push-through workflow runs the same secret-scan on its diff before
it can push. So a real token cannot reach a public branch by accident.

## The two operator-supplied secrets

- **`CLAUDE_CODE_OAUTH_TOKEN`** — a long-lived `claude setup-token` value
  (`sk-ant-oat01…`). When present, the default account is pointed at
  `env:CLAUDE_CODE_OAUTH_TOKEN`, which is **durable** (it does not idle-expire,
  unlike the interactive `claude-code:login`, which lapses after a few idle hours
  and 401s mid-session).
- **`UI_WS_TOKEN`** — the WebSocket bearer token clients pass in the `ws://` URL.
  On first run the native Luna Studio app reads it (or `LUNA_UI_WS_TOKEN`) directly
  from `~/.luna/.env` via its `load_local_connection` Tauri command to
  auto-provision its loopback connection; the browser build keeps the manual
  Settings flow.

## Making durable auth the install default (without leaking)

`scripts/luna-server-install` takes the Claude token through a **non-public**
channel only — never a command-line value (flags leak into shell history and
`ps`):

```sh
# preferred: a file the installer reads (then you can delete it)
scripts/luna-server-install --profile stable --claude-token-file /run/secrets/claude-token
# or via the environment
CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-…" scripts/luna-server-install --profile stable
```

When a token is supplied the installer writes it to `.env` (mode 600) and seeds
the default account pointed at `env:CLAUDE_CODE_OAUTH_TOKEN` (via
`apps/ui-web/scripts/seed-default-account.ts`), so the server boots straight into
**normal** mode. Omit the token to fall back to the interactive
`claude-code:login` setup flow. The seed writes **only the pointer ref** — never
the token value.
```sh
# seed/repair an existing install (idempotent; no-op if an account already exists)
CLAUDE_CODE_OAUTH_TOKEN="…" bun run apps/ui-web/scripts/seed-default-account.ts /root/.luna/luna.db
```

## Rotating or switching the token

The account stores a **pointer** (`env:CLAUDE_CODE_OAUTH_TOKEN`), not the value, so:

- **Rotating the token value (env → env):** just replace `CLAUDE_CODE_OAUTH_TOKEN`
  in `.env` and restart. The pointer is unchanged; the broker reads the new value.
  No DB change needed.
- **Upgrading an existing `claude-code:login` install to the durable token:** the
  seed is idempotent and **no-ops when any account already exists**, so it will
  NOT flip an existing `claude-code:login` account to the env pointer. Set the
  token in `.env`, then flip the pointer explicitly:
  ```sh
  bun -e "import {Database} from 'bun:sqlite'; const d=new Database('/root/.luna/luna.db'); \
    d.run(\"UPDATE accounts SET secret_ref='env:CLAUDE_CODE_OAUTH_TOKEN' WHERE secret_ref='claude-code:login'\")"
  ```
  then restart. (Equivalent: `luna account rm` the old row, then re-run the seed.)

## If the install seed fails

The installer's seed step is **non-fatal**: if it fails after the token was
written to `.env`, the install completes with a warning and the server starts in
**setup-mode** (safe fallback — it won't use a half-configured account). Recover
by re-running the seed:
```sh
CLAUDE_CODE_OAUTH_TOKEN="…" bun run apps/ui-web/scripts/seed-default-account.ts /root/.luna/luna.db
```

## File permissions

`.env` MUST be mode `600` (owner-only) — it holds the raw token. The installer
enforces this; if you hand-edit `.env`, re-run `chmod 600 /root/.luna/.env`.

## Remote WS ingress and token transport

The daemon no longer serves a web page; its HTTP surface is `/healthz`, `/readyz`, and the `/ui` WebSocket that Moon and remote Moon connect to.
Any remote access therefore means proxying the WebSocket, not a site.

Caddy with real TLS (recommended for remote access):

```caddyfile
your.domain.example {
    reverse_proxy /ui ws://127.0.0.1:4753
}
```

Caddy auto-provisions a Let's Encrypt certificate; use `tls internal` plus `caddy trust` for a LAN host without a public domain.
Tailscale Serve (`scripts/luna-web-ingress.sh`) remains the simplest personal option: it exposes the daemon port on your tailnet over HTTPS, and Moon connects to `wss://<machine>.<tailnet>.ts.net/ui`.
Ad-hoc tunnels (ngrok and similar) expose the same endpoint publicly; use only for short-lived testing.

Token transport rules, regardless of ingress:

- Every `ui-ws` connection authenticates with the single bearer token from `LUNA_UI_WS_TOKEN`; there is no separate per-surface token, so do not invent one (the server does not read `LUNA_UI_WS_TOKEN_WEB`).
- Keep the token inside TLS; never send it over plain HTTP on an untrusted network.
- Keep it out of access logs: configure the proxy to strip the `Authorization` header from logged requests, and prefer the header over the `?token=` query form, which is harder to scrub from logs.
