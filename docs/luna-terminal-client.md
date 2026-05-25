# Luna Terminal Client

`luna chat` connects a terminal session to the Luna WebSocket server. It uses
the same chat transport as the web UI, so the CLI can create threads, subscribe
to existing threads, send messages, interrupt an active turn, and optionally
advertise a local-shell capability for the current machine.

## Required configuration

Set the WebSocket URL and bearer token in the environment or in
`~/.luna/.env`:

```bash
LUNA_WS_URL=ws://127.0.0.1:4753/ui
LUNA_UI_WS_TOKEN=<token>
```

`LUNA_WS_URL` defaults to `ws://127.0.0.1:4753/ui` when omitted.
`LUNA_UI_WS_TOKEN` is required unless you pass `--token`.

Profiles let one `luna` binary switch between stable and development runtimes:

```bash
LUNA_STABLE_WS_URL=ws://jax-box:4753/ui
LUNA_STABLE_FALLBACK_WS_URL=ws://jax-box.local:4753/ui
LUNA_STABLE_UI_WS_TOKEN=<stable-token>

LUNA_DEV_WS_URL=ws://jax-box:5753/ui
LUNA_DEV_FALLBACK_WS_URL=ws://jax-box.local:5753/ui
LUNA_DEV_UI_WS_TOKEN=<dev-token>
```

Use the stable profile by default:

```bash
luna chat
```

Use the dev profile with either flag:

```bash
luna chat --dev
luna chat --profile dev
```

Profile-specific variables are read before legacy variables. Explicit flags
such as `--url` and `--token` still win over profile configuration. When a
fallback URL is configured, Luna tries the primary URL first and then the
fallback URL before running recovery.

The chat server itself reads `UI_WS_TOKEN` or `LUNA_UI_WS_TOKEN`. Use the same
token value on both sides. The terminal client checks token values in this order:

1. `--token <token>`
2. `LUNA_<PROFILE>_UI_WS_TOKEN` from the process environment
3. `LUNA_<PROFILE>_UI_WS_TOKEN` from `~/.luna/.env`
4. `LUNA_UI_WS_TOKEN` from the process environment
5. `UI_WS_TOKEN` from the process environment
6. `LUNA_UI_WS_TOKEN` from `~/.luna/.env`
7. `UI_WS_TOKEN` from `~/.luna/.env`

## Optional recovery configuration

Recovery is off by default. When enabled, `luna chat` first tries to connect to
`LUNA_WS_URL`; if that connection fails, it runs the configured recovery command
and then retries the connection.

```bash
LUNA_START_MODE=local|ssh|none
LUNA_START_COMMAND=<command>
LUNA_START_SSH=<ssh-target>
LUNA_START_TIMEOUT_MS=30000
```

Profile-specific recovery variables use the same prefix:

```bash
LUNA_DEV_START_MODE=ssh
LUNA_DEV_START_COMMAND="systemctl --user restart luna-dev-chat-server.service"
LUNA_DEV_START_SSH=root@jax-box
LUNA_DEV_FALLBACK_START_SSH=root@jax-box.local
LUNA_DEV_START_TIMEOUT_MS=30000
```

Modes:

- `none`: do not run recovery. This is the default.
- `local`: run `LUNA_START_COMMAND` on the machine running the CLI.
- `ssh`: run `ssh "$LUNA_START_SSH" "$LUNA_START_COMMAND"`.

`LUNA_START_COMMAND` is required for `local` and `ssh` mode.
`LUNA_START_SSH` is required for `ssh` mode.
`LUNA_START_TIMEOUT_MS` must be a positive integer and defaults to `30000`.
When `LUNA_FALLBACK_START_SSH` or `LUNA_<PROFILE>_FALLBACK_START_SSH` is set,
Luna tries the primary SSH target first and then the fallback target.

For remote-host recovery:

```bash
LUNA_START_MODE=ssh
LUNA_START_COMMAND="incus exec agent-lab-1 -- systemctl restart jax-agent-lab.service"
LUNA_START_SSH=root@remote-host
```

The same recovery settings can also be passed as flags:

```bash
luna chat \
  --start-mode ssh \
  --start-command "incus exec agent-lab-1 -- systemctl restart jax-agent-lab.service" \
  --start-ssh root@remote-host \
  --fallback-start-ssh root@lan-host.local
```

## Common commands

```bash
luna chat
luna chat --dev
luna chat --url ws://127.0.0.1:4753/ui
luna chat --thread <thread-id>
luna chat --local-shell
```

`luna chat` creates a new thread by default. Use `--thread <thread-id>` to
resume an existing thread. Use `--local-shell` to start with local shell enabled.

## In-session commands

Type these commands at the `luna chat` prompt:

| Command | Effect |
| --- | --- |
| `/help` | Show in-session help. |
| `/threads` | List recent threads. |
| `/new` | Create and switch to a new thread. |
| `/switch <thread-id>` | Subscribe to an existing thread. |
| `/interrupt` | Interrupt the active assistant turn for the current thread. |
| `/local-shell on` | Enable local-shell capability for the current CLI session. |
| `/local-shell off` | Disable local-shell capability for the current CLI session. |
| `/local-shell status` | Print whether local shell is currently on or off. |
| `/quit` | Close the terminal client. |

## Local shell safety

Local shell capability is off by default. While it is off, the CLI denies local
command requests without prompting. When enabled, Luna may request commands on
the machine running the CLI, and each received command request still requires
explicit approval before execution.

Enable it at startup:

```bash
luna chat --local-shell
```

Or toggle it during a session:

```text
/local-shell on
/local-shell off
/local-shell status
```

Use local shell only when you intend Luna to operate on the current CLI host.
