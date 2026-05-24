# Luna Terminal Client Design

Date: 2026-05-24
Status: Approved for implementation planning

## Summary

Add a terminal chat client for Luna that feels like opening a direct conversation with Luna. The client connects to the existing Luna chat WebSocket, streams assistant responses, supports interrupt/resume basics, can recover a stopped server, and can temporarily expose the machine running the CLI as a local shell tool for the current chat session.

This is a client for the existing Luna runtime, not a second agent runtime. The Luna server remains the owner of sessions, memory, account routing, model execution, and durable state.

## Goals

- Provide `luna chat` as the primary terminal UX.
- Use the existing `@luna/ui-ws` protocol where possible.
- Move WebSocket token handling out of hardcoded source and into config/env.
- Allow the CLI to connect locally or over Tailscale.
- If the server is unavailable, try a configured start/restart command, then reconnect.
- Support a live-toggle local shell bridge:
  - `/local-shell on`
  - `/local-shell off`
  - `/local-shell status`
- Keep local shell off by default.
- Require per-command approval before executing a local shell command in v1.

## Non-Goals

- No unattended local shell execution in v1.
- No filesystem sandbox in v1.
- No sudo or privilege escalation feature beyond what the current user can already run.
- No second account broker, memory store, or direct SDK runtime inside the CLI.
- No replacement for the web UI.
- No full Agent Zero clone.

## Existing Context

Luna already has `apps/agent-cli`, but it currently ships `luna-account`, a small account-table seed CLI. It is not an interactive agent client.

The chat backend already exposes a WebSocket protocol with:

- `new-thread`
- `subscribe`
- `list-threads`
- `user-message`
- `interrupt`
- `thread-created`
- `thread-list`
- `thread-snapshot`
- `assistant-delta`
- `assistant-done`
- `assistant-error`
- `account-list`

The correct first implementation is to build a terminal client around that protocol and extend the protocol only for the local shell bridge.

## User Experience

Command examples:

```bash
luna chat
luna chat --local-shell
luna chat --url wss://remote-host.tailnet.example.ts.net:43111/ui
luna chat --thread <thread-id>
luna chat --new
```

In-session commands:

```text
/help
/threads
/new
/switch <thread-id>
/interrupt
/local-shell on
/local-shell off
/local-shell status
/quit
```

The terminal should feel like a normal chat session:

- User types a message and presses Enter.
- Luna streams text as it arrives.
- Ctrl-C interrupts the current assistant turn when one is in flight.
- Ctrl-D or `/quit` exits the client without destroying the server session.
- Reconnecting can resume a thread by subscribing and receiving a snapshot.

## Configuration

Configuration precedence:

1. CLI flags
2. Process environment
3. `~/.luna/.env`
4. Built-in defaults

Required/recognized values:

```env
LUNA_WS_URL=ws://127.0.0.1:4753/ui
LUNA_UI_WS_TOKEN=<secret-token>

# Optional recovery.
LUNA_START_MODE=local|ssh|none
LUNA_START_COMMAND=<command>
LUNA_START_SSH=root@remote-host
LUNA_START_TIMEOUT_MS=30000
```

Server token behavior:

- `chat-server.ts` must read `UI_WS_TOKEN` or `LUNA_UI_WS_TOKEN`.
- It must fail closed if no token is configured.
- The development fallback token must not remain the production default.
- The Docker/Incus deployment should inject the same token into the server and the UI build as needed.

Client token behavior:

- `luna chat` reads `LUNA_UI_WS_TOKEN` from env or `~/.luna/.env`.
- The token is never printed.
- If missing, the CLI exits with a clear setup message.

## Server Recovery

On connection failure, `luna chat` should:

1. Try to connect once.
2. If it fails and recovery is configured, run the recovery command.
3. Wait and retry with bounded backoff until timeout.
4. If still failing, print:
   - URL attempted
   - whether token was present, without showing it
   - recovery command mode used
   - final connection error

Recovery modes:

- `none`: never try to start anything.
- `local`: run `LUNA_START_COMMAND` on the client machine.
- `ssh`: run `ssh $LUNA_START_SSH "$LUNA_START_COMMAND"`.

For `remote-host`, an expected recovery command is:

```bash
incus exec agent-lab-1 -- systemctl restart jax-agent-lab.service
```

## Local Shell Bridge

The local shell bridge exposes the machine running the CLI to the Luna thread. If the CLI runs on the user's Mac, commands run on the Mac. If it runs inside `agent-lab-1`, commands run inside that VM.

Default state:

- Off unless `--local-shell` is passed.
- Can be toggled live with `/local-shell on` and `/local-shell off`.
- Disconnecting the CLI removes the local shell capability.

Approval flow:

```text
Luna wants to run locally:
  git status

Approve? [y/N]
```

If approved:

- CLI runs the command with the user's current shell.
- CLI captures stdout, stderr, exit code, start time, duration, and whether it timed out.
- CLI sends the result back to Luna.

If denied:

- CLI sends a denied result back to Luna.
- Luna can continue the conversation without local command output.

Execution limits:

- Use the current user's privileges.
- No implicit sudo.
- Default timeout should be finite, e.g. 120 seconds.
- Output should be truncated with a clear marker if it exceeds a configured maximum.
- The terminal must show the command before execution.

## Protocol Extension

The existing UI WebSocket protocol should be extended with local-client tool frames.

Server to client:

```ts
interface LocalShellRequestFrame {
  readonly type: "local-shell-request"
  readonly requestId: string
  readonly threadId: string
  readonly command: string
  readonly cwd?: string
  readonly timeoutMs?: number
}
```

Client to server:

```ts
interface LocalShellCapabilityFrame {
  readonly type: "local-shell-capability"
  readonly enabled: boolean
  readonly clientId: string
  readonly platform: string
  readonly cwd: string
}

interface LocalShellResultFrame {
  readonly type: "local-shell-result"
  readonly requestId: string
  readonly threadId: string
  readonly approved: boolean
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
}
```

The server should only advertise/route the local shell tool for a thread when at least one connected client has enabled the capability for that thread. V1 supports one active local shell client per thread. If a second client enables local shell for the same thread, the server rejects it with a clear "local shell already attached" error.

## Runtime Boundary

Server responsibilities:

- Own Luna sessions and durable state.
- Own the Agent SDK call.
- Register a local shell tool only when the client capability is active.
- Forward local shell tool requests to the active CLI client.
- Return approved/denied command results to the agent.
- Remove the capability when the client disconnects or toggles it off.

CLI responsibilities:

- Load config.
- Connect/recover/reconnect.
- Create or attach to a thread.
- Render chat.
- Send user messages and interrupts.
- Toggle local shell state.
- Prompt for shell command approval.
- Execute approved commands locally.
- Return command results.

## Error Handling

- Missing token: fail before connecting with setup guidance.
- Invalid token: surface auth failure without printing token.
- Server unavailable: attempt configured recovery once per connection attempt cycle.
- Unknown thread: show the server's error and suggest `/threads` or `/new`.
- Local shell request while disabled: server should return a tool error saying local shell is unavailable.
- Local command timeout: return a timed-out result with partial output if available.
- CLI disconnect during local command: terminate the child process and return no result because the client bridge is gone.

## Testing

Unit tests:

- Config precedence and `.env` parsing.
- WebSocket frame encoding/decoding for new frames.
- Slash command parser.
- Local shell state machine.
- Command approval deny path.
- Command execution success, non-zero exit, timeout, and output truncation.

Integration tests:

- Fake WebSocket server: connect, hello, new thread, user message, streaming delta, done.
- Recovery command path: initial connect fails, recovery command invoked, reconnect succeeds.
- Local shell bridge: fake server sends request, CLI prompts, approved result returns.
- Ctrl-C maps to `interrupt` when assistant turn is active.

Manual smoke:

```bash
luna chat --url ws://127.0.0.1:4753/ui
/local-shell on
```

Then ask Luna to inspect the current directory and confirm that the CLI prompts before running a command.

## Rollout

Phase 1:

- Add config loader.
- Add `luna chat` command.
- Connect to existing WebSocket protocol.
- Support create/attach/send/stream/interrupt.
- Move server token to env/config.

Phase 2:

- Add recovery mode.
- Add local and SSH start commands.

Phase 3:

- Add local shell protocol frames and server-side routing.
- Add CLI approval and command execution.

Phase 4:

- Polish terminal UX, docs, and deployment config for `remote-host`.

## Implementation Decisions

- Reuse `apps/agent-cli` for v1, adding a `luna` bin alongside `luna-account`.
- Reject a second local shell client for the same thread in v1.
- `luna chat` creates a new thread unless `--thread` is supplied; `/threads` and `/switch` handle resuming.
