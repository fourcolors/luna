#!/usr/bin/env bun
/**
 * demo-session-limit-rotation.ts — Runnable simulation demonstrating Luna Session Limit Fallback Rotation.
 *
 * Demonstrates:
 * 1. Primary target (Anthropic) encountering a "session limit reached" error.
 * 2. Throttle classification recognizing `kind: "session_limit"`.
 * 3. AccountBroker cooling the primary account.
 * 4. Effect v3 `executeWithOverflowChain` rotating seamlessly to the secondary target (Google).
 * 5. Successful completion of query on secondary target.
 */
import { Effect, Layer, Redacted } from "effect"
import {
  AccountBroker,
  AccountBrokerLayer,
  Clock,
  SecretProvider,
  SessionLimitError,
  executeWithOverflowChain,
} from "@luna/core"
import { classifyThrottle } from "../src/throttle.js"

async function runDemo() {
  console.log("==========================================================================")
  console.log("🚀 LUNA SESSION LIMIT FALLBACK ROTATION SIMULATION DEMO")
  console.log("==========================================================================")

  // Configure overflow chain in environment: chat lane -> [Anthropic primary, Google secondary]
  process.env["LUNA_OVERFLOW_CHAINS"] = JSON.stringify({
    chains: {
      chat: [
        { model: "claude-sonnet-4-5", kind: "anthropic" },
        { model: "gemini-2.5-flash", kind: "google" },
      ],
    },
  })

  // Create dependency layers for in-memory AccountBroker
  const secretProviderLayer = Layer.succeed(SecretProvider, {
    get: (_ref) => Effect.succeed(Redacted.make("demo-api-secret")),
  } as any)

  const clockLayer = Layer.succeed(Clock, {
    nowMs: () => Effect.succeed(Date.now()),
  } as any)

  const brokerLayer = AccountBrokerLayer.fromAccounts([
    { id: "account-anthropic-primary", kind: "anthropic", label: "Anthropic Primary (OAuth)" },
    { id: "account-google-secondary", kind: "google", label: "Google Secondary (API Key)" },
  ]).pipe(
    Layer.provideMerge(secretProviderLayer),
    Layer.provideMerge(clockLayer),
  )

  const simulationProgram = Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* AccountBroker

      console.log("\n[1] Initial Account Status:")
      const initialAccounts = yield* broker.list()
      for (const acc of initialAccounts) {
        console.log(`    - Account ID: ${acc.id} (${acc.kind}) | Health: ${acc.health}`)
      }

      console.log("\n[2] Executing query on lane 'chat' with Effect v3 executeWithOverflowChain...")

      let attemptNum = 0
      const result = yield* executeWithOverflowChain({
        broker,
        lane: "chat",
        execute: (acq) =>
          Effect.gen(function* () {
            attemptNum++
            console.log(`\n    --> Attempt #${attemptNum}: Acquired account [${acq.credential.accountId}] (${acq.credential.kind}) for model [${acq.model}]`)

            if (acq.credential.accountId === "account-anthropic-primary") {
              const errorMessage = "API Error 429: Session limit reached for subscriber account"
              const classification = classifyThrottle(errorMessage)

              console.log(`    ⚠️  Simulating failure on primary account...`)
              console.log(`    🔎  classifyThrottle output: throttled=${classification.throttled}, kind="${classification.kind}"`)
              console.log(`    🛑  Failing attempt with SessionLimitError: "${errorMessage}"`)

              return yield* Effect.fail(
                new SessionLimitError({
                  module: "demo",
                  cause: errorMessage,
                }),
              )
            }

            console.log(`    ✅  Secondary target execution succeeded!`)
            return {
              status: "success",
              response: "Hello from Gemini 2.5 Flash on secondary tree target!",
              servedBy: acq.credential.accountId,
              model: acq.model,
            }
          }),
      })

      console.log("\n[3] Final Execution Result:")
      console.log(`    - Status: ${result.status}`)
      console.log(`    - Served By: ${result.servedBy}`)
      console.log(`    - Model Used: ${result.model}`)
      console.log(`    - Response Text: "${result.response}"`)

      console.log("\n[4] Account Health Status Post-Rotation:")
      const postAccounts = yield* broker.list()
      for (const acc of postAccounts) {
        console.log(`    - Account ID: ${acc.id} (${acc.kind}) | Health: ${acc.health}`)
      }

      console.log("\n==========================================================================")
      console.log("🎉 SIMULATION COMPLETED SUCCESSFULLY: Primary session limit fallback rotated seamlessly.")
      console.log("==========================================================================")
    }),
  )

  await Effect.runPromise(Effect.provide(simulationProgram, brokerLayer))
}

runDemo().catch((err) => {
  console.error("❌ Simulation failed with error:", err)
  process.exit(1)
})
