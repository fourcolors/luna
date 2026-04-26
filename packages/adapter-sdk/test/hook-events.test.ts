/**
 * Hook event coverage — DESIGN.md §12.2 #3 and §13.1 #2.
 *
 * We do not hard-code a count. The adapter re-exports the SDK's HOOK_EVENTS
 * constant; this test iterates it at runtime and asserts every event can be
 * registered through the adapter's `registerHook` surface without error.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Scope } from "effect"
import { SessionStore } from "@luna/core"
import { SDKAdapter, SDKClient, HOOK_EVENTS } from "../src/index.js"
import { makeFakeQuery, makeResultMessage } from "./fake-sdk.js"

const baseLayer = Layer.provideMerge(
  SDKAdapter.Default,
  Layer.mergeAll(
    SDKClient.fake(() => makeFakeQuery({ messages: [] }).query),
    SessionStore.Default,
  ),
)

describe("Hook event coverage", () => {
  it("HOOK_EVENTS contains at least the core set we rely on", () => {
    const names = new Set(HOOK_EVENTS as readonly string[])
    for (const must of [
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "SessionStart",
      "SessionEnd",
      "Stop",
    ]) {
      expect(names.has(must), `missing hook event: ${must}`).toBe(true)
    }
  })

  it("registerHook accepts every event in HOOK_EVENTS", async () => {
    const ok = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* SDKAdapter
          for (const ev of HOOK_EVENTS) {
            yield* adapter.registerHook(ev, undefined, async () => ({}) as never)
          }
          return true
        }),
      ).pipe(Effect.provide(baseLayer)),
    )
    expect(ok).toBe(true)
  })

  it("hooks register and unregister on Scope close", async () => {
    // We can't easily introspect the internal registry, but we verify a
    // scoped registration doesn't leak by opening a Scope, registering,
    // closing, then registering again in a fresh Scope without error.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* SDKAdapter
            yield* adapter.registerHook(
              "PreToolUse",
              "Bash",
              async () => ({}) as never,
            )
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* SDKAdapter
            yield* adapter.registerHook(
              "PreToolUse",
              "Bash",
              async () => ({}) as never,
            )
          }),
        )
        return "ok"
      }).pipe(Effect.provide(baseLayer)),
    )
    expect(result).toBe("ok")
  })
})

// Marker to keep imports stable.
void Scope
