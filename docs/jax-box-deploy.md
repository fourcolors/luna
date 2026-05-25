# jax-box Deployment

This is the intended operator flow for the Luna stable/dev split on jax-box.

Branch policy:

- `master` is stable. The main Luna agent runs this branch.
- `dev` is integration. The dev container runs this branch.
- Promote by testing `dev`, merging `dev` into `master`, then restarting the
  stable runtime.

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
  --branch dev \
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
git checkout dev
git pull --ff-only origin dev
git checkout -b <feature-branch>
bun run test
bun run typecheck
git push origin <feature-branch>
git checkout dev
git merge --ff-only <feature-branch>
git push origin dev
```

Update the dev runtime on jax-box:

```bash
ssh root@jax-box
cd /root/luna/dev/repo
git fetch origin dev
git checkout dev
git pull --ff-only origin dev
incus exec luna-dev -- bash -lc 'cd /root/luna && /root/.bun/bin/bun install --frozen-lockfile'
incus exec luna-dev -- systemctl restart luna-dev-chat-server.service
curl -fsS http://jax-box:5753/healthz
```

After testing through the dev runtime, merge `dev` to `master`. Use a normal
merge or PR if the branches have diverged:

```bash
git checkout master
git pull --ff-only origin master
git merge --ff-only origin/dev
git push origin master
```

Promote stable on jax-box:

```bash
ssh root@jax-box
cd /root/luna/stable/repo
git fetch origin master
git checkout master
git pull --ff-only origin master
/root/.bun/bin/bun install --frozen-lockfile
systemctl --user restart luna-chat-server.service
curl -fsS http://jax-box:4753/healthz
```

If stable needs to roll back:

```bash
ssh root@jax-box
cd /root/luna/stable/repo
git log --oneline -5
git checkout <known-good-commit>
/root/.bun/bin/bun install --frozen-lockfile
systemctl --user restart luna-chat-server.service
curl -fsS http://jax-box:4753/healthz
```

Rollback should be a temporary recovery step. Follow it with a revert commit or
fix-forward commit on `master`.
