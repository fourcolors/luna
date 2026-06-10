/**
 * Connector abstraction tests (M1).
 *
 * Load-bearing claims:
 *   - connect → instance row → refreshMounts → mountSnapshotSync delivers
 *     the right McpServerConfig shape per transport
 *   - secret material lands ONLY in the mount (header/env) and the
 *     instance row holds the POINTER
 *   - a failing secret resolution flips the instance to "error" and
 *     EXCLUDES it from mounts (the agent just doesn't get the tools)
 *   - OAuth definitions reject direct connect; one instance per definition
 *   - the mock connector's native server mounts end-to-end
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import { Clock, ConfigError, SecretProvider } from "@luna/core"
import {
  BUILTIN_CONNECTORS,
  ConnectorInstanceStore,
  ConnectorService,
  ConnectorServiceLayer,
  MOCK_CONNECTOR,
  scopesForCapabilities,
  type ConnectorDefinition,
} from "../src/index.js"

const apiKeyDef: ConnectorDefinition = {
  id: "fake-saas",
  name: "Fake SaaS",
  blurb: "A remote-MCP api-key connector for tests.",
  category: "other",
  auth: { kind: "api-key", fieldLabel: "API token" },
  transport: { kind: "mcp-remote", url: "http://127.0.0.1:9999/mcp/" },
  capabilities: [
    { id: "read", label: "Read", scopes: ["saas.read"], defaultGranted: true },
    { id: "write", label: "Write", scopes: ["saas.write"], defaultGranted: false },
  ],
  serverKey: "fake_saas",
}

const stdioDef: ConnectorDefinition = {
  id: "fake-stdio",
  name: "Fake Stdio",
  blurb: "A stdio connector for tests.",
  category: "other",
  auth: { kind: "api-key", fieldLabel: "token" },
  transport: {
    kind: "mcp-stdio",
    command: "fake-mcp",
    args: ["--serve"],
    secretEnvVar: "FAKE_TOKEN",
  },
  capabilities: [],
  serverKey: "fake_stdio",
}

const oauthDef: ConnectorDefinition = {
  id: "fake-oauth",
  name: "Fake OAuth",
  blurb: "An oauth connector for tests.",
  category: "other",
  auth: {
    kind: "oauth2",
    authorizationEndpoint: "https://example.test/auth",
    tokenEndpoint: "https://example.test/token",
    clientIdEnvVar: "FAKE_CLIENT_ID",
    clientSecretEnvVar: "FAKE_CLIENT_SECRET",
  },
  transport: { kind: "mcp-remote", url: "http://127.0.0.1:9999/mcp/" },
  capabilities: [],
  serverKey: "fake_oauth",
}

/** SecretProvider stub: resolves env:KNOWN_* refs, fails everything else. */
const secretsStub = Layer.succeed(SecretProvider, {
  get: (ref: string) =>
    ref.startsWith("env:KNOWN")
      ? Effect.succeed(Redacted.make(`secret-for-${ref}`))
      : Effect.fail(
          new ConfigError({ module: "test", key: ref, message: "unknown ref" }),
        ),
})

const baseLayer = (defs: ReadonlyArray<ConnectorDefinition>) =>
  ConnectorServiceLayer({ definitions: defs }).pipe(
    Layer.provide(ConnectorInstanceStore.Memory),
    Layer.provide(secretsStub),
    Layer.provide(Clock.Default),
  )

const run = <A, E>(
  defs: ReadonlyArray<ConnectorDefinition>,
  eff: Effect.Effect<A, E, ConnectorService>,
) => Effect.runPromise(eff.pipe(Effect.provide(baseLayer(defs))) as Effect.Effect<A, E>)

describe("ConnectorService — lifecycle", () => {
  it("catalog() is wire-safe metadata (no transport internals, no makeServer)", async () => {
    const meta = await run([MOCK_CONNECTOR, apiKeyDef],
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        return yield* svc.catalog()
      }),
    )
    expect(meta.map((m) => m.id)).toEqual(["mock-connector", "fake-saas"])
    expect(JSON.stringify(meta)).not.toContain("makeServer")
    expect(JSON.stringify(meta)).not.toContain("url")
    expect(meta[1]?.authKind).toBe("api-key")
  })

  it("unknown definition / OAuth-direct / missing api-key ref / duplicate all reject", async () => {
    await run([apiKeyDef, oauthDef],
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        const unknown = yield* svc.connect({ definitionId: "ghost", label: "x" }).pipe(Effect.flip)
        expect(unknown.message).toContain("unknown connector")
        const oauth = yield* svc.connect({ definitionId: "fake-oauth", label: "x" }).pipe(Effect.flip)
        expect(oauth.message).toContain("OAuth")
        const noRef = yield* svc.connect({ definitionId: "fake-saas", label: "x" }).pipe(Effect.flip)
        expect(noRef.message).toContain("secretRef")
        yield* svc.connect({ definitionId: "fake-saas", label: "one", secretRef: "env:KNOWN_A" })
        // C1 multi-account: a DIFFERENT label is a second account, allowed…
        yield* svc.connect({ definitionId: "fake-saas", label: "two", secretRef: "env:KNOWN_A" })
        // …but re-using an existing label (slug-insensitive) is rejected.
        const dup = yield* svc.connect({ definitionId: "fake-saas", label: "One!", secretRef: "env:KNOWN_A" }).pipe(Effect.flip)
        expect(dup.message).toContain('already has an account labeled')
        expect(yield* svc.list()).toHaveLength(2)
      }),
    )
  })

  it("default capabilities → granted scopes; explicit selection narrows", () => {
    expect(scopesForCapabilities(apiKeyDef, ["read", "write"])).toEqual([
      "saas.read",
      "saas.write",
    ])
    expect(scopesForCapabilities(apiKeyDef, ["read"])).toEqual(["saas.read"])
  })
})

describe("ConnectorService — mounting", () => {
  it("mcp-remote mounts as http + bearer header; instance row keeps only the pointer", async () => {
    await run([apiKeyDef],
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        const instance = yield* svc.connect({
          definitionId: "fake-saas",
          label: "Test",
          secretRef: "env:KNOWN_A",
        })
        expect(instance.secretRef).toBe("env:KNOWN_A") // pointer, not value
        expect(instance.grantedScopes).toEqual(["saas.read"]) // defaultGranted only
        const mounts = svc.mountSnapshotSync()
        expect(mounts["fake_saas_test"]).toEqual({
          type: "http",
          url: "http://127.0.0.1:9999/mcp/",
          headers: { Authorization: "Bearer secret-for-env:KNOWN_A" },
        })
        // the instance list never carries the secret VALUE
        const listed = yield* svc.list()
        expect(JSON.stringify(listed)).not.toContain("secret-for-")
      }),
    )
  })

  it("mcp-stdio mounts as stdio + env injection", async () => {
    await run([stdioDef],
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        yield* svc.connect({ definitionId: "fake-stdio", label: "T", secretRef: "env:KNOWN_B" })
        expect(svc.mountSnapshotSync()["fake_stdio_t"]).toEqual({
          type: "stdio",
          command: "fake-mcp",
          args: ["--serve"],
          env: { FAKE_TOKEN: "secret-for-env:KNOWN_B" },
        })
      }),
    )
  })

  it("native (mock connector) mounts an sdk server instance — the M1 pipeline proof", async () => {
    await run([...BUILTIN_CONNECTORS],
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        yield* svc.connect({ definitionId: "mock-connector", label: "Mock" })
        const mounts = svc.mountSnapshotSync()
        const mock = mounts["mock_connector_mock"] as { type?: string } | undefined
        expect(mock).toBeDefined()
        expect(mock?.type).toBe("sdk")
      }),
    )
  })

  it("secret-resolution failure → status error + EXCLUDED from mounts; disconnect empties", async () => {
    await run([apiKeyDef],
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        const instance = yield* svc.connect({
          definitionId: "fake-saas",
          label: "T",
          secretRef: "env:UNRESOLVABLE",
        })
        // connect itself succeeded (the ref is a pointer) but the mount
        // refresh could not resolve it → excluded + flagged.
        expect(svc.mountSnapshotSync()["fake_saas_t"]).toBeUndefined()
        const listed = yield* svc.list()
        expect(listed[0]?.status).toBe("error")
        const removed = yield* svc.disconnect(instance.id)
        expect(removed).toBe(true)
        expect(yield* svc.list()).toEqual([])
        expect(svc.mountSnapshotSync()).toEqual({})
      }),
    )
  })

  it("boot hydration: a persisted connected instance mounts without any connect call", async () => {
    // Pre-seed the store, then build the service layer — mirrors a restart.
    const seeded = Layer.effect(
      ConnectorInstanceStore,
      Effect.gen(function* () {
        const api = yield* Effect.gen(function* () {
          return yield* ConnectorInstanceStore
        }).pipe(Effect.provide(ConnectorInstanceStore.Memory))
        yield* api.insert({
          id: "pre-1",
          definitionId: "fake-saas",
          label: "Persisted",
          status: "connected",
          secretRef: "env:KNOWN_A",
          grantedScopes: ["saas.read"],
          accountKind: "connector-fake-saas",
          createdAt: 1,
          lastHealthyAt: 1,
        })
        return api
      }),
    )
    const mounts = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        return svc.mountSnapshotSync()
      }).pipe(
        Effect.provide(
          ConnectorServiceLayer({ definitions: [apiKeyDef] }).pipe(
            Layer.provide(seeded),
            Layer.provide(secretsStub),
            Layer.provide(Clock.Default),
          ),
        ),
      ) as Effect.Effect<Readonly<Record<string, unknown>>>,
    )
    // C1: the non-default label mounts under its suffixed key.
    expect(mounts["fake_saas_persisted"]).toMatchObject({ type: "http" })
  })
})
