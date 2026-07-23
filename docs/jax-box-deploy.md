# jax-box Deployment

This is the intended operator flow for the Luna stable/dev split on jax-box.

Branch policy:

- `master` is the only long-lived branch. The main Luna agent runs it.
- The dev container is a staging runtime, not a branch — point it at whatever
  ref you want to stage (a feature branch or a `moon-v*` tag).
- Land work on `master` via a PR (squash-merge). Stable **auto-updates by
  default** - the host-side guardian verifies health and redeploys it while idle (see
  [autodeploy](./autodeploy.md)); the manual promotion below is the override
  for forcing a deploy or when auto-update is opted out. There is no
  `dev`→`master` promotion.

## Local Client

On the MacBook:

```bash
bash install.sh \
  --stable-url ws://jax-box:4753/ui \
  --stable-fallback-url ws://jax-box.local:4753/ui \
  --dev-url ws://jax-box:5753/ui \
  --dev-fallback-url ws://jax-box.local:5753/ui \
  --enable-ssh-recovery \
  --ssh-host jax-box \
  --fallback-ssh-host jax-box.local \
  --stable-token '<stable-ui-ws-token>' \
  --dev-token '<dev-ui-ws-token>'
```

Use:

```bash
luna chat
luna chat --dev
```

## Stable Runtime

Stable runs from:

```text
/root/luna/stable/repo
/root/.luna
```

Install or repair the service:

```bash
ssh root@jax-box
cd /root/luna/stable/repo
git pull --ff-only origin master
incus exec luna-stable -- /root/luna/scripts/luna-server-install \
  --profile stable \
  --repo-dir /root/luna \
  --luna-home /root/.luna
scripts/luna-guardian adopt stable
```

If this is the first install and no token exists yet:

```bash
incus exec luna-stable -- /root/luna/scripts/luna-server-install \
  --profile stable \
  --repo-dir /root/luna \
  --luna-home /root/.luna \
  --token '<stable-ui-ws-token>'
```

## Dev Runtime

### Shared Ollama Embedder

Luna can use a real local embedding model for memory by pointing the container
at an Ollama daemon on the host. This keeps model downloads out of each
container and lets stable/dev share the same embedding service.

On jax-box:

```bash
ssh root@jax-box
ollama pull embeddinggemma

INCUS_GW="$(incus exec luna-dev -- ip route | awk '/default/ {print $3; exit}')"
systemctl edit ollama
```

Use this systemd override, replacing the IP with `$INCUS_GW` if different:

```ini
[Service]
Environment="OLLAMA_HOST=<ollama-host>:11434"
```

Then restart and verify from inside the container:

```bash
systemctl daemon-reload
systemctl restart ollama
incus exec luna-dev -- curl -fsS http://<ollama-host>:11434/api/tags
```

Existing containers can opt into the real embedder by writing these values to
their Luna state `.env`, then restarting the chat server:

```bash
incus exec luna-dev -- bash -lc '
  cd /root/luna
  scripts/luna-server-install \
    --profile dev \
    --repo-dir /root/luna \
    --luna-home /root/.luna \
    --skip-deps \
    --embedder ollama \
    --ollama-base-url http://<ollama-host>:11434 \
    --ollama-embed-model embeddinggemma \
    --ollama-embed-dimension 768 \
    --ollama-probe-timeout-ms 3000 \
    --ollama-probe-attempts 3 \
    --ollama-probe-backoff-ms 200
'
```

Optional Ollama probe knobs (written to `.env` as `LUNA_OLLAMA_*`):
`--ollama-embed-dimension`, `--ollama-probe-timeout-ms`,
`--ollama-probe-attempts` (default 3, clamped to 5),
`--ollama-probe-backoff-ms` (default 200).

Create the dev container:

```bash
ssh root@jax-box
cd /root/luna/stable/repo
scripts/luna-container-create \
  --profile dev \
  --name luna-dev \
  --repo git@github.com:fourcolors/luna.git \
  --branch <feature-branch-or-tag> \
  --repo-path /root/luna/dev/repo \
  --state-path /root/.luna-dev \
  --host jax-box \
  --host-ws-port 5753 \
  --host-control-port 5754 \
  --embedder ollama \
  --ollama-base-url http://<ollama-host>:11434 \
  --ollama-embed-model embeddinggemma \
  --ollama-embed-dimension 768 \
  --token '<dev-ui-ws-token>'
```


Use `--dry-run` first to inspect the Incus commands. Use `--replace` only when
you intend to delete and recreate the existing dev container. If `luna-dev`
already exists and `--replace` is not passed, the script exits successfully
without changing the existing container.

## Development And Promotion

Develop against dev:

```bash
luna chat --dev
```

Code flow (trunk-based — work lands on `master` via a PR, squash-merged):

```bash
git checkout master
git pull --ff-only origin master
git checkout -b <feature-branch>
bun run test
bun run typecheck
git push origin <feature-branch>
gh pr create --base master --fill   # review, then squash-merge
```

Update the dev runtime on jax-box. Point it at whatever ref you want to stage —
a feature branch or a `moon-v*` tag (substitute `<feature-branch-or-tag>` below):

```bash
ssh root@jax-box
cd /root/luna/dev/repo
git fetch origin
git checkout <feature-branch-or-tag>
git pull --ff-only origin <feature-branch-or-tag>   # skip for a tag (detached)
incus exec luna-dev -- bash -lc 'cd /root/luna && /root/.bun/bin/bun install --frozen-lockfile'
# Restart as stop -> settle -> start, NOT a fast `systemctl restart`: a fast restart
# can start the new chat-server before the outgoing one releases its DuckDB/SQLite
# WAL/SHM handles, crashing the boot with SQLITE_CANTOPEN. The settle covers that.
# Or run the guarded operator tool, which does this with a connection guard:
#   scripts/restart-channel.sh dev [--yes]
incus exec luna-dev -- systemctl stop luna-dev-chat-server.service
sleep 6
incus exec luna-dev -- systemctl start luna-dev-chat-server.service
curl -fsS http://127.0.0.1:5753/healthz
```

After testing through the dev runtime, land the work on `master` by opening a
PR and squash-merging it. There is no `dev`→`master` promotion:

```bash
gh pr create --base master --fill   # review, then squash-merge
```

Promote stable on jax-box. Stable normally updates through the guardian; this
drives the same connect-aware rollback path immediately and then proves live
completion:

```bash
ssh root@jax-box
cd /root/luna/stable/repo
git fetch origin master
EXPECTED_SHA="$(git rev-parse origin/master)"
scripts/luna-autodeploy stable
scripts/luna-guardian adopt stable
/usr/local/lib/luna-guardian/current-stable/luna-guardian accept stable \
  --expected-sha "$EXPECTED_SHA" --min-cycles 2
```

If active sessions defer the update or `Type=notify` reconciliation, leave the
promotion pending and retry when idle. Do not replace this with raw `git pull`,
dependency installation, and restart commands; that bypasses transaction
journaling, rollback, exact-SHA readiness, and the acceptance gate.

If stable needs to roll back:

```bash
ssh root@jax-box
cd /root/luna/stable/repo
git log --oneline -5
git checkout <known-good-commit>
/root/.bun/bin/bun install --frozen-lockfile
incus exec luna-stable -- bash -lc 'cd /root/luna && /root/.bun/bin/bun install --frozen-lockfile'
# Restart as stop -> settle -> start, NOT a fast `systemctl restart`: a fast restart
# can start the new chat-server before the outgoing one releases its DuckDB/SQLite
# WAL/SHM handles, crashing the boot with SQLITE_CANTOPEN. The settle covers that.
incus exec luna-stable -- systemctl stop luna-chat-server.service
sleep 6
incus exec luna-stable -- systemctl start luna-chat-server.service
curl -fsS http://127.0.0.1:4753/healthz
```

Rollback should be a temporary recovery step. Follow it with a revert commit or
fix-forward commit on `master`.
