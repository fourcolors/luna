# @experiment-agent/ui-ws

WebSocket transport adapter for `UIService`. Streams whitelisted
`ObsEvent`s to UI clients (Tauri, web, CLI dashboards).

## Why a separate package

`UIService` (in `@experiment-agent/core`) is transport-agnostic — it
exposes a filtered `Stream<ObsEvent>` and nothing else. A real client
needs a wire protocol. This package adds that wire protocol over
WebSockets without baking it into the core.

## Security defaults (do not relax without thought)

- **Bind: `127.0.0.1`** by default. Don't expose this server to the
  network — run it behind an SSH tunnel, a Unix socket reverse proxy,
  or TLS-terminating reverse proxy.
- **Bearer token required.** Refuses to start if `token` is unset or
  shorter than 16 chars. Tokens should come from 1Password
  (`op://Mr Bot/UI_WS_TOKEN`) — never check them into source.
- **No client→server commands** in this phase. The protocol is
  push-only; clients are pure subscribers.

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
} from "@experiment-agent/core"
import { startUIWebSocketServer } from "@experiment-agent/ui-ws"

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
TOKEN=$(op item get UI_WS_TOKEN --vault "Mr Bot" --fields label=token --reveal)
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
