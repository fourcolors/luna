/**
 * SDKClient — the thin, swappable interface to the real SDK.
 *
 * Per DESIGN.md §12 + advisor amendment (landmine): the `Query` object
 * returned by `query()` is both an async iterable AND a control handle
 * (interrupt, setPermissionMode, setModel, supplyToolPermissionResponse,
 * etc.). We retain the handle; `Stream.fromAsyncIterable` alone would lose it.
 *
 * We abstract the SDK behind a Service so Tier-1 tests can provide a fake
 * implementation without needing a real OAuth token. `SDKClient.Default`
 * uses the real SDK; `SDKClient.fake(...)` supplies an in-memory stub.
 */
import { Context, Effect, Layer } from "effect"
import { query as realQuery } from "@anthropic-ai/claude-agent-sdk"
import type {
  SDKMessage,
  SDKUserMessage,
  Options,
  Query,
} from "@anthropic-ai/claude-agent-sdk"

export type { SDKMessage, SDKUserMessage, Options, Query }
export type {
  HookEvent,
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  PermissionMode,
  PermissionBehavior,
} from "@anthropic-ai/claude-agent-sdk"

export { HOOK_EVENTS } from "@anthropic-ai/claude-agent-sdk"

export interface QueryParams {
  readonly prompt: string | AsyncIterable<SDKUserMessage>
  readonly options?: Options
}

export interface SDKClientService {
  /** Invoke the SDK's `query()`. Synchronous; SDK lazily spawns its subprocess. */
  readonly query: (params: QueryParams) => Effect.Effect<Query, never>
}

export class SDKClient extends Context.Service<SDKClient, SDKClientService>()(
  "luna/SDKClient",
) {
  /** Real SDK-backed layer. */
  static readonly Default: Layer.Layer<SDKClient> = Layer.succeed(SDKClient, {
    query: (params) => Effect.sync(() => realQuery(params)),
  })

  /**
   * Fake factory for tests. Takes a function that builds a `Query` for each
   * invocation, giving the test full control over the message stream and
   * the control-method stubs.
   */
  static fake(
    build: (params: QueryParams) => Query,
  ): Layer.Layer<SDKClient> {
    return Layer.succeed(SDKClient, {
      query: (params) => Effect.sync(() => build(params)),
    })
  }
}
