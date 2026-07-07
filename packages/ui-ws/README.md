# @luna/ui-ws

WebSocket transport adapter for `UIService`. Streams whitelisted
`ObsEvent`s to UI clients (Tauri, web, CLI dashboards).

## Why a separate package

`UIService` (in `@luna/core`) is transport-agnostic — it
exposes a filtered `Stream<ObsEvent>` and nothing else. A real client
needs a wire protocol. This package adds that wire protocol over
WebSockets without baking it into the core.

## Security defaults (do not relax without thought)

- **Bind: `127.0.0.1`** by default. Don't expose this server to the
  network — run it behind an SSH tunnel, a Unix socket reverse proxy,
  or TLS-terminating reverse proxy.
- **Bearer token required.** Refuses to start if `token` is unset or
  shorter than 16 chars. Tokens should come from 1Password
  (`op://Example Vault/UI_WS_TOKEN`) — never check them into source.
- **Client→server commands** were added in v2 (chat). Obs frames remain
  push-only and broadcast; chat frames are scoped to a per-connection
  set of subscribed `threadId`s.

## Wire protocol — v2 (current, chat-aware)

`UI_WS_PROTOCOL_VERSION = 2`. The server emits a `hello` frame with
`capabilities: { chat, streamingDeltas }` so older clients can degrade.
When configured, `hello.availableModels` carries the server-owned model
switcher list, each model's valid `efforts`, and an optional
`defaultEffort` (currently Sonnet 5 defaults to `high`).

**Server → client** (additive over v1):

| Type | Trigger |
|------|---------|
| `hello` | sent on connect (carries capabilities) |
| `event` / `drop` / `ping` / `bye` | obs path (unchanged from v1) |
| `thread-list` | response to `list-threads`; sidebar projection |
| `thread-created` | server-side new-thread completion (auto-subscribes) |
| `thread-snapshot` | full replay on first `subscribe(threadId)` (carries `throughSeq`) |
| `user-accepted` | echo of an accepted user-message with persisted `seq` |
| `assistant-delta` | cumulative streaming text for an in-flight turn |
| `assistant-done` | finalized assistant turn with definitive `seq` |
| `assistant-error` | tagged-union error (`sdk` / `idle` / `interrupted` / `unknown-thread`) |
| `artifacts-extracted` | post-`assistant-done` payloads (substantial code fences + Write/Edit tool uses) |

**Client → server** (new in v2):

| Type | Effect |
|------|--------|
| `subscribe` / `unsubscribe` | toggle live forwarding for a `threadId` |
| `list-threads` | request a fresh `thread-list` (sidebar refresh) |
| `new-thread` | create + auto-subscribe (server emits `thread-created` then `thread-snapshot`); omitted `model` routes through the broker default lane (prefers Sonnet 5 when Anthropic is available, else the configured default overflow chain) |
| `user-message` | offer text into the chat queue |
| `interrupt` | stop the current assistant turn |
| `pong` / `bye` | liveness / clean shutdown |

Dedupe: clients drop live frames whose `seq <= throughSeq` of the most
recent snapshot — covers reconnect-during-turn race.

## Wire protocol (v1)

All frames are JSON objects with a `type` discriminant:

```
{ type: "hello",  protocolVersion: 1, kinds: [...] }   // server → client (on connect)
{ type: "event",  event: <ObsEvent> }                  // server → client
{ type: "drop",   n: <number>, since: <iso-ts> }       // server → client (overflow notice)
{ type: "ping",   ts: <iso-ts> }                       // server → client (keep-alive)
{ type: "bye",    reason: <string> }                   // either direction
```

`hello.kinds` is the list of ObsEvent kinds the server advertises as
forwardable. It is purely informational — pass `advertisedKinds` to
`startUIWebSocketServer` to populate it (typically the same array you
passed to `UIService.makeLayer({ kinds: ... })`).

### Drop semantics

The server is a single-fiber forwarder per connection. If the
underlying socket buffer (`ws.bufferedAmount`) exceeds
`perConnectionCapacity * 4096` bytes, the next event is dropped and a
counter is incremented. The next successful send carries a leading
`{type:"drop", n, since}` frame so the client knows exactly how many
events it missed and the timestamp of the oldest. The shared
`UIService` PubSub is never back-pressured, so one slow client can
never starve the others. Drop counting is exact (single-fiber design;
no producer/consumer race).

## Usage

```ts
import { Effect, Layer, ManagedRuntime } from "effect"
import {
  Clock,
  DEFAULT_UI_KINDS,
  ObservabilityService,
  UIService,
} from "@luna/core"
import { startUIWebSocketServer } from "@luna/ui-ws"

const baseLayer = Layer.mergeAll(
  Clock.Default,
  ObservabilityService.makeLayer({}).pipe(Layer.provide(Clock.Default)),
  UIService.makeLayer().pipe(
    Layer.provide(
      ObservabilityService.makeLayer({}).pipe(Layer.provide(Clock.Default)),
    ),
    Layer.provide(Clock.Default),
  ),
)

const program = Effect.gen(function* () {
  const handle = yield* startUIWebSocketServer({
    port: 4753,
    token: process.env["UI_WS_TOKEN"]!, // 1Password-injected
    perConnectionCapacity: 256,
    advertisedKinds: DEFAULT_UI_KINDS,
  })
  console.log(`UI WS listening on ws://${handle.host}:${handle.port}/ui`)
  yield* Effect.never // hold the scope open
})

const runtime = ManagedRuntime.make(baseLayer)
runtime.runPromise(Effect.scoped(program))
```

## Connecting

```bash
TOKEN=$(op item get UI_WS_TOKEN --vault "Example Vault" --fields label=token --reveal)
websocat -H "Authorization: Bearer $TOKEN" ws://127.0.0.1:4753/ui
```

## Health check

```bash
curl -s http://127.0.0.1:4753/healthz
# → ok
```

## Testing

```bash
bunx vitest run packages/ui-ws
```

The integration tests boot a real `node:http` + `ws` server on an
ephemeral port and exercise auth, the hello frame, event forwarding,
fan-out across two clients, path routing, and startup validation.
