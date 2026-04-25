/**
 * Dev-only: boot a ui-ws server with a fixed token and emit a stream of
 * synthetic ObsEvents on a tick. Lets you poke at the web UI without
 * standing up the full agent runtime.
 *
 * Run:
 *   bun run dev:server
 *
 * The token is printed on startup; copy it into the web UI's Token
 * field (or set VITE_UI_WS_TOKEN in apps/ui-web/.env.local before
 * `bun run dev`).
 */
import { Effect, Layer, ManagedRuntime } from "effect"
import {
  Clock,
  DEFAULT_UI_KINDS,
  ObservabilityService,
  UIService,
} from "@experiment-agent/core"
import { startUIWebSocketServer } from "@experiment-agent/ui-ws"

const TOKEN = "dev-ui-ws-token-do-not-ship"

const baseLayer = (() => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  return Layer.mergeAll(uiL, obsL, clockL)
})()

class ServerHandle extends Effect.Tag("dev/ServerHandle")<
  ServerHandle,
  { readonly port: number; readonly host: string }
>() {}

const serverLayer = Layer.scoped(
  ServerHandle,
  startUIWebSocketServer({
    port: 4753,
    token: TOKEN,
    advertisedKinds: DEFAULT_UI_KINDS,
    pingIntervalMs: 5000,
  }),
).pipe(Layer.provide(baseLayer))

const runtime = ManagedRuntime.make(Layer.mergeAll(serverLayer, baseLayer))

const synthEvent = (n: number) => {
  const ts = new Date().toISOString()
  const pick = n % 5
  if (pick === 0) {
    return {
      kind: "ToolCall" as const,
      ts,
      level: "info" as const,
      sessionId: `s-${Math.floor(n / 10)}`,
      toolName: ["bash", "edit", "read", "grep"][n % 4]!,
      durationMs: Math.floor(Math.random() * 500),
      status: "success" as const,
    }
  }
  if (pick === 1) {
    return {
      kind: "CostAccrued" as const,
      ts,
      level: "info" as const,
      sessionId: `s-${Math.floor(n / 10)}`,
      tokensIn: 100 + n,
      tokensOut: 50 + n,
      cacheRead: 0,
      cacheWrite: 0,
      estimatedUsd: 0.0001 * n,
    }
  }
  if (pick === 2) {
    return {
      kind: "WorkflowTransition" as const,
      ts,
      level: "info" as const,
      workflowId: `w-${n}`,
      from: "running",
      to: "complete",
    }
  }
  if (pick === 3) {
    return {
      kind: "TeammateStart" as const,
      ts,
      level: "info" as const,
      team: "alpha",
      teammate: `m-${n}`,
    }
  }
  return {
    kind: "Error" as const,
    ts,
    level: "error" as const,
    errorTag: "SyntheticError",
    message: `synthetic error #${n}`,
  }
}

const main = Effect.gen(function* () {
  const handle = yield* ServerHandle
  console.log(`✅ ui-ws dev server: ws://${handle.host}:${handle.port}/ui`)
  console.log(`🔑 token: ${TOKEN}`)
  console.log(`💡 web UI: cd apps/ui-web && bun run dev`)
  console.log(`   then paste the token into the UI`)

  const obs = yield* ObservabilityService

  // Tick: emit a synthetic event every 750ms.
  let n = 0
  yield* Effect.forever(
    Effect.gen(function* () {
      yield* obs.emit(synthEvent(n))
      n += 1
      yield* Effect.sleep("750 millis")
    }),
  )
})

runtime.runFork(Effect.scoped(main))

// Keep the process alive; ManagedRuntime owns the http listener.
process.on("SIGINT", async () => {
  console.log("\n👋 shutting down")
  await runtime.dispose()
  process.exit(0)
})
