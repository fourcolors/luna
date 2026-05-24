# jax-box Deployment

This is the intended operator flow for the Luna stable/dev split on jax-box.

## Local Client

On the MacBook:

```bash
bash install.sh \
  --stable-url ws://jax-box:4753/ui \
  --dev-url ws://jax-box:5753/ui \
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
scripts/luna-server-install \
  --profile stable \
  --repo-dir /root/luna/stable/repo \
  --luna-home /root/.luna
```

If this is the first install and no token exists yet:

```bash
scripts/luna-server-install \
  --profile stable \
  --repo-dir /root/luna/stable/repo \
  --luna-home /root/.luna \
  --token '<stable-ui-ws-token>'
```

## Dev Runtime

Create the dev container:

```bash
ssh root@jax-box
cd /root/luna/stable/repo
scripts/luna-container-create \
  --profile dev \
  --name luna-dev \
  --repo git@github.com:fourcolors/luna.git \
  --branch master \
  --repo-path /root/luna/dev/repo \
  --state-path /root/.luna-dev \
  --host jax-box \
  --host-ws-port 5753 \
  --host-control-port 5754 \
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

Code flow:

```bash
git checkout -b <feature-branch>
bun run test
bun run typecheck
git push origin <feature-branch>
```

After testing through the dev runtime, merge to `master`. Promote stable on
jax-box:

```bash
ssh root@jax-box
cd /root/luna/stable/repo
git fetch origin master
git checkout master
git pull --ff-only origin master
bun install --frozen-lockfile
systemctl restart luna-chat-server.service
curl -fsS http://127.0.0.1:4753/healthz
```

If stable needs to roll back:

```bash
ssh root@jax-box
cd /root/luna/stable/repo
git log --oneline -5
git checkout <known-good-commit>
bun install --frozen-lockfile
systemctl restart luna-chat-server.service
curl -fsS http://127.0.0.1:4753/healthz
```

Rollback should be a temporary recovery step. Follow it with a revert commit or
fix-forward commit on `master`.
