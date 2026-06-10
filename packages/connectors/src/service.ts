/**
 * ConnectorService — catalog + instance lifecycle + agent mounting
 * (PRD Part A §06–§08).
 *
 * Mounting and the sync constraint: ThreadToolsProvider.decorate() is
 * SYNCHRONOUS, so connector servers cannot be assembled with an Effect at
 * thread-creation time. Same solve as the skills prompt snapshot: the
 * service keeps `mountSnapshotSync()` — a plain object cache rebuilt by
 * `refreshMounts()` (run at boot, after every connect/disconnect, and by
 * the M2 token refresher when it rotates an access token). decorate()
 * spreads the snapshot into the per-thread `mcpServers` dict.
 *
 * Credential handling: `refreshMounts()` resolves each connected
 * instance's `secretRef` through the SecretProvider chain and embeds the
 * value where the transport needs it (bearer header / env var). The
 * snapshot therefore holds live credential MATERIAL in memory — it is
 * never logged, never serialized, and never crosses the WS (the catalog
 * frames carry definition metadata + instance status only). A resolution
 * failure flips the instance to "error" and EXCLUDES it from the snapshot
 * — the agent simply doesn't get those tools that turn (PRD §08).
 *
 * OAuth (begin/complete) is M2: it plugs in via ConnectorServiceOptions.
 */
import { Effect, Layer, Redacted } from "effect"
import { SecretProvider, Clock } from "@luna/core"
import { ConnectorInstanceStore } from "./store.js"
import {
  ConnectorError,
  type ConnectorDefinition,
  type ConnectorDefinitionMeta,
  type ConnectorInstance,
  scopesForCapabilities,
} from "./types.js"

/** Opaque MCP server config (SDK union) — core/connectors stay SDK-free. */
export type McpServerConfigLike = Readonly<Record<string, unknown>>

export interface ConnectorServiceApi {
  /** Wire-safe catalog metadata for the settings UI. */
  readonly catalog: () => Effect.Effect<ReadonlyArray<ConnectorDefinitionMeta>>
  /** Current instances (status only — secretRef is a pointer, safe). */
  readonly list: () => Effect.Effect<ReadonlyArray<ConnectorInstance>>
  /**
   * Connect a non-OAuth definition (auth kind "api-key" or "none").
   * For api-key, `secretRef` must already point at the stored credential
   * (the secure-entry flow stores it first, then connects). OAuth
   * definitions reject here — they go through the M2 begin/complete flow.
   */
  readonly connect: (input: {
    readonly definitionId: string
    readonly label: string
    readonly secretRef?: string
    readonly capabilityIds?: ReadonlyArray<string>
  }) => Effect.Effect<ConnectorInstance, ConnectorError>
  /** Remove an instance (token revocation is the M2 OAuth path's job). */
  readonly disconnect: (
    instanceId: string,
  ) => Effect.Effect<boolean, ConnectorError>
  /** Rebuild the mount snapshot from current instances + secrets. */
  readonly refreshMounts: () => Effect.Effect<void>
  /** Synchronous, never-stale view for decorate(). Keyed by serverKey. */
  readonly mountSnapshotSync: () => Readonly<Record<string, McpServerConfigLike>>
}

export class ConnectorService extends Effect.Tag("luna/ConnectorService")<
  ConnectorService,
  ConnectorServiceApi
>() {}

export interface ConnectorServiceOptions {
  /** The curated, in-repo catalog. */
  readonly definitions: ReadonlyArray<ConnectorDefinition>
}

const toMeta = (d: ConnectorDefinition): ConnectorDefinitionMeta => ({
  id: d.id,
  name: d.name,
  blurb: d.blurb,
  category: d.category,
  authKind: d.auth.kind,
  capabilities: d.capabilities,
})

export const ConnectorServiceLayer = (
  options: ConnectorServiceOptions,
): Layer.Layer<
  ConnectorService,
  never,
  ConnectorInstanceStore | SecretProvider | Clock
> =>
  Layer.effect(
    ConnectorService,
    Effect.gen(function* () {
      const store = yield* ConnectorInstanceStore
      const secrets = yield* SecretProvider
      const clock = yield* Clock
      const definitions = new Map(options.definitions.map((d) => [d.id, d]))

      // The sync mount cache (see header). Plain object; JS single thread.
      let snapshot: Readonly<Record<string, McpServerConfigLike>> = {}

      const buildMount = (
        definition: ConnectorDefinition,
        instance: ConnectorInstance,
      ): Effect.Effect<McpServerConfigLike | null> =>
        Effect.gen(function* () {
          const t = definition.transport
          if (t.kind === "native") {
            return t.makeServer() as McpServerConfigLike
          }
          // Remote/stdio need the credential material.
          const secret = yield* secrets.get(instance.secretRef).pipe(
            Effect.map(Redacted.value),
            Effect.catchAll(() =>
              Effect.gen(function* () {
                // Resolution failure → error status, excluded from mounts.
                yield* store.setStatus(instance.id, "error")
                console.warn(
                  `[luna/connectors] secret resolution failed for instance ${instance.id} (${definition.id}) — excluded from mounts`,
                )
                return null
              }),
            ),
          )
          if (secret === null) return null
          if (t.kind === "mcp-remote") {
            return {
              type: "http",
              url: t.url,
              headers: { Authorization: `Bearer ${secret}` },
            }
          }
          return {
            type: "stdio",
            command: t.command,
            args: [...t.args],
            env: { [t.secretEnvVar]: secret },
          }
        })

      const refreshMounts: ConnectorServiceApi["refreshMounts"] = () =>
        Effect.gen(function* () {
          const instances = yield* store.list()
          const next: Record<string, McpServerConfigLike> = {}
          for (const instance of instances) {
            if (instance.status !== "connected") continue
            const definition = definitions.get(instance.definitionId)
            if (definition === undefined) continue // catalog drift: orphan row, skip
            const mount = yield* buildMount(definition, instance)
            if (mount !== null) next[definition.serverKey] = mount
          }
          snapshot = next
        })

      const connect: ConnectorServiceApi["connect"] = (input) =>
        Effect.gen(function* () {
          const definition = definitions.get(input.definitionId)
          if (definition === undefined) {
            return yield* Effect.fail(
              new ConnectorError({
                op: "connect",
                message: `unknown connector "${input.definitionId}"`,
              }),
            )
          }
          if (definition.auth.kind === "oauth2") {
            return yield* Effect.fail(
              new ConnectorError({
                op: "connect",
                message: `"${input.definitionId}" uses OAuth — use the authorization flow, not direct connect`,
              }),
            )
          }
          if (
            definition.auth.kind === "api-key" &&
            (input.secretRef === undefined || input.secretRef.trim() === "")
          ) {
            return yield* Effect.fail(
              new ConnectorError({
                op: "connect",
                message: `"${input.definitionId}" needs a stored credential (secretRef) — store it via the secure-entry flow first`,
              }),
            )
          }
          const existing = yield* store.list()
          if (existing.some((i) => i.definitionId === definition.id)) {
            // v1: one instance per definition (multi-account is PRD §23 open).
            return yield* Effect.fail(
              new ConnectorError({
                op: "connect",
                message: `"${input.definitionId}" is already connected — disconnect it first`,
              }),
            )
          }
          const now = yield* clock.nowMs()
          const capabilityIds =
            input.capabilityIds ??
            definition.capabilities.filter((c) => c.defaultGranted).map((c) => c.id)
          const instance: ConnectorInstance = {
            id: crypto.randomUUID(),
            definitionId: definition.id,
            label: input.label.trim() || definition.name,
            status: "connected",
            secretRef: input.secretRef ?? "none",
            grantedScopes: scopesForCapabilities(definition, capabilityIds),
            accountKind: `connector-${definition.id}`,
            createdAt: now,
            lastHealthyAt: now,
          }
          yield* store.insert(instance)
          yield* refreshMounts()
          return instance
        })

      const disconnect: ConnectorServiceApi["disconnect"] = (instanceId) =>
        Effect.gen(function* () {
          const removed = yield* store.remove(instanceId)
          if (removed) yield* refreshMounts()
          return removed
        })

      // Boot: hydrate the snapshot from persisted instances so threads
      // created before any settings interaction still get their mounts.
      yield* refreshMounts()

      return {
        catalog: () => Effect.succeed(options.definitions.map(toMeta)),
        list: () => store.list(),
        connect,
        disconnect,
        refreshMounts,
        mountSnapshotSync: () => snapshot,
      } satisfies ConnectorServiceApi
    }),
  )
