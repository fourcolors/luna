/**
 * Full client-brokered OAuth flow at the service level (PRD A §09),
 * against a MOCK provider — the M2 demo in test form:
 *
 *   beginAuth → consent URL (PKCE bound, server-held verifier)
 *   completeAuth → state check, code exchange, refresh-token persisted
 *     via the secret sink, instance row, access token mounted as Bearer
 *   expiry → refresh mints a new token (single mint under concurrency)
 *   revoked refresh token → needs-reauth + excluded from mounts
 *   disconnect → best-effort provider revocation + local removal
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import { Clock, ConfigError, SecretProvider } from "@luna/core"
import { makeOAuthClient, type FetchLike } from "@luna/oauth"
import {
  ConnectorInstanceStore,
  ConnectorService,
  ConnectorServiceLayer,
  type ConnectorDefinition,
} from "../src/index.js"

const oauthDef: ConnectorDefinition = {
  id: "fake-google",
  name: "Fake Google",
  blurb: "OAuth test connector.",
  category: "productivity",
  auth: {
    kind: "oauth2",
    authorizationEndpoint: "https://accounts.fake.test/auth",
    tokenEndpoint: "https://oauth2.fake.test/token",
    revocationEndpoint: "https://oauth2.fake.test/revoke",
    clientIdEnvVar: "FAKE_GOOGLE_CLIENT_ID",
    clientSecretEnvVar: "FAKE_GOOGLE_CLIENT_SECRET",
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  transport: { kind: "mcp-remote", url: "http://127.0.0.1:8000/mcp/" },
  capabilities: [
    { id: "mail", label: "Mail", scopes: ["fake.mail"], defaultGranted: true },
    { id: "files", label: "Files", scopes: ["fake.files"], defaultGranted: false },
  ],
  serverKey: "fake_google",
}

/** Mock provider: records every POST; one valid code; refresh counter. */
const makeProvider = () => {
  const calls: Array<{ url: string; form: Record<string, string> }> = []
  let refreshCount = 0
  let refreshRevoked = false
  const fetchImpl: FetchLike = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body))
    calls.push({ url, form })
    if (url.endsWith("/revoke")) {
      return { ok: true, status: 200, json: async () => ({}) }
    }
    if (form["grant_type"] === "authorization_code") {
      if (form["code"] !== "good-code") {
        return { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
        }),
      }
    }
    // refresh_token grant
    if (refreshRevoked || form["refresh_token"] !== "refresh-1") {
      return { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) }
    }
    refreshCount++
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: `access-${refreshCount + 1}`, expires_in: 3600 }),
    }
  }
  return {
    fetchImpl,
    calls,
    revokeRefreshToken: () => {
      refreshRevoked = true
    },
    getRefreshCount: () => refreshCount,
  }
}

/** Test clock we can advance to expire access tokens. */
const makeTestClock = () => {
  let now = 1_000_000
  return {
    layer: Layer.succeed(Clock, {
      nowMs: () => Effect.sync(() => now),
      nowIso: () => Effect.sync(() => new Date(now).toISOString()),
      sleep: () => Effect.void,
    } as never),
    advance: (ms: number) => {
      now += ms
    },
  }
}

const makeRig = () => {
  const provider = makeProvider()
  const clock = makeTestClock()
  // The secret sink: stores under the var name, returns the env: ref —
  // and the SecretProvider stub resolves from the same map (mirrors the
  // chat-server wiring of process.env + persistEnvSecret).
  const stored = new Map<string, string>()
  const sinkCalls: string[] = []
  const clearedVars: string[] = []
  const layer = ConnectorServiceLayer({
    definitions: [oauthDef],
    oauth: {
      client: makeOAuthClient(provider.fetchImpl),
      storeSecret: (varName, value) =>
        Effect.sync(() => {
          stored.set(varName, value)
          sinkCalls.push(varName)
          return `env:${varName}`
        }),
      clearSecret: (varName) =>
        Effect.sync(() => {
          stored.delete(varName)
          clearedVars.push(varName)
        }),
      env: {
        FAKE_GOOGLE_CLIENT_ID: "cid-123",
        FAKE_GOOGLE_CLIENT_SECRET: "cs-456",
      },
    },
  }).pipe(
    Layer.provide(ConnectorInstanceStore.Memory),
    Layer.provide(
      Layer.succeed(SecretProvider, {
        get: (ref: string) => {
          const v = ref.startsWith("env:") ? stored.get(ref.slice(4)) : undefined
          return v !== undefined
            ? Effect.succeed(Redacted.make(v))
            : Effect.fail(
                new ConfigError({ module: "test", key: ref, message: "unresolved" }),
              )
        },
      }),
    ),
    Layer.provide(clock.layer),
  )
  return { provider, clock, stored, sinkCalls, clearedVars, layer }
}

describe("client-brokered OAuth flow (mock provider e2e)", () => {
  it("begin → consent URL with PKCE; complete → instance + Bearer mount; verifier never leaves", async () => {
    const rig = makeRig()
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConnectorService

        const begun = yield* svc.beginAuth({
          definitionId: "fake-google",
          label: "Personal",
          loopbackPort: 49152,
        })
        const url = new URL(begun.authUrl)
        expect(url.origin + url.pathname).toBe("https://accounts.fake.test/auth")
        expect(url.searchParams.get("client_id")).toBe("cid-123")
        expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:49152/callback")
        expect(url.searchParams.get("scope")).toBe("fake.mail") // defaultGranted only
        expect(url.searchParams.get("code_challenge_method")).toBe("S256")
        expect(url.searchParams.get("access_type")).toBe("offline")
        const state = url.searchParams.get("state")!

        const instance = yield* svc.completeAuth({
          pendingId: begun.pendingId,
          code: "good-code",
          state,
        })
        expect(instance.status).toBe("connected")
        expect(instance.secretRef).toBe("env:LUNA_CONNECTOR_FAKE_GOOGLE_REFRESH_TOKEN")
        expect(instance.grantedScopes).toEqual(["fake.mail"])
        // refresh token persisted through the sink, never in the instance
        expect(rig.stored.get("LUNA_CONNECTOR_FAKE_GOOGLE_REFRESH_TOKEN")).toBe("refresh-1")
        expect(JSON.stringify(instance)).not.toContain("refresh-1")
        expect(JSON.stringify(instance)).not.toContain("access-1")

        // mounted with the EXCHANGE-seeded access token (no refresh call yet)
        const mounts = svc.mountSnapshotSync()
        expect(mounts["fake_google"]).toEqual({
          type: "http",
          url: "http://127.0.0.1:8000/mcp/",
          headers: { Authorization: "Bearer access-1" },
        })
        expect(rig.provider.getRefreshCount()).toBe(0)

        // the exchange carried the verifier + secret, form-encoded
        const exchange = rig.provider.calls.find(
          (c) => c.form["grant_type"] === "authorization_code",
        )!
        expect(exchange.form["code_verifier"]).toMatch(/^[A-Za-z0-9\-._~]{64}$/)
        expect(exchange.form["client_secret"]).toBe("cs-456")
        // …and the verifier never appeared in the authorize URL
        expect(begun.authUrl).not.toContain(exchange.form["code_verifier"]!)
      }).pipe(Effect.provide(rig.layer)),
    )
  })

  it("state mismatch and unknown/expired pendingId both reject; the code is single-use", async () => {
    const rig = makeRig()
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        const begun = yield* svc.beginAuth({
          definitionId: "fake-google",
          label: "x",
          loopbackPort: 50000,
        })
        const bad = yield* svc
          .completeAuth({ pendingId: begun.pendingId, code: "good-code", state: "forged" })
          .pipe(Effect.flip)
        expect(bad.message).toContain("state mismatch")
        // state mismatch consumed the pending — replay is dead
        const replay = yield* svc
          .completeAuth({ pendingId: begun.pendingId, code: "good-code", state: "forged" })
          .pipe(Effect.flip)
        expect(replay.message).toContain("unknown or expired")

        const ghost = yield* svc
          .completeAuth({ pendingId: "nope", code: "x", state: "y" })
          .pipe(Effect.flip)
        expect(ghost.message).toContain("unknown or expired")
      }).pipe(Effect.provide(rig.layer)),
    )
  })

  it("expired access token → ONE refresh under concurrent rebuilds (single-flight)", async () => {
    const rig = makeRig()
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        const begun = yield* svc.beginAuth({
          definitionId: "fake-google",
          label: "x",
          loopbackPort: 50001,
        })
        const state = new URL(begun.authUrl).searchParams.get("state")!
        yield* svc.completeAuth({ pendingId: begun.pendingId, code: "good-code", state })

        // Push past expiry (3600s) — the cached token is stale now.
        rig.clock.advance(3601 * 1000)
        yield* Effect.all(
          [svc.refreshMounts(), svc.refreshMounts(), svc.refreshMounts()],
          { concurrency: "unbounded" },
        )
        expect(rig.provider.getRefreshCount()).toBe(1) // semaphore: one mint
        const mounts = svc.mountSnapshotSync()
        expect(
          (mounts["fake_google"] as { headers: { Authorization: string } }).headers
            .Authorization,
        ).toBe("Bearer access-2")
      }).pipe(Effect.provide(rig.layer)),
    )
  })

  it("completeAuth rejects a SECOND flow for an already-connected definition (review G2 duplicate guard)", async () => {
    const rig = makeRig()
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        // Two independent begins (double-click / web+Moon) → two pendings.
        const a = yield* svc.beginAuth({ definitionId: "fake-google", label: "A", loopbackPort: 51000 })
        const b = yield* svc.beginAuth({ definitionId: "fake-google", label: "B", loopbackPort: 51001 })
        const stateA = new URL(a.authUrl).searchParams.get("state")!
        const stateB = new URL(b.authUrl).searchParams.get("state")!
        yield* svc.completeAuth({ pendingId: a.pendingId, code: "good-code", state: stateA })
        // The second completeAuth must NOT insert a second row.
        const dup = yield* svc
          .completeAuth({ pendingId: b.pendingId, code: "good-code", state: stateB })
          .pipe(Effect.flip)
        expect(dup.message).toContain("already connected")
        const listed = yield* svc.list()
        expect(listed).toHaveLength(1)
      }).pipe(Effect.provide(rig.layer)),
    )
  })

  it("disconnect drops the LOCAL refresh-token secret via clearSecret (review G2)", async () => {
    const rig = makeRig()
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        const begun = yield* svc.beginAuth({ definitionId: "fake-google", label: "x", loopbackPort: 51002 })
        const state = new URL(begun.authUrl).searchParams.get("state")!
        const instance = yield* svc.completeAuth({ pendingId: begun.pendingId, code: "good-code", state })
        expect(rig.stored.has("LUNA_CONNECTOR_FAKE_GOOGLE_REFRESH_TOKEN")).toBe(true)
        yield* svc.disconnect(instance.id)
        expect(rig.clearedVars).toContain("LUNA_CONNECTOR_FAKE_GOOGLE_REFRESH_TOKEN")
        expect(rig.stored.has("LUNA_CONNECTOR_FAKE_GOOGLE_REFRESH_TOKEN")).toBe(false)
      }).pipe(Effect.provide(rig.layer)),
    )
  })

  it("revoked refresh token → needs-reauth + excluded; disconnect revokes at the provider", async () => {
    const rig = makeRig()
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        const begun = yield* svc.beginAuth({
          definitionId: "fake-google",
          label: "x",
          loopbackPort: 50002,
        })
        const state = new URL(begun.authUrl).searchParams.get("state")!
        const instance = yield* svc.completeAuth({
          pendingId: begun.pendingId,
          code: "good-code",
          state,
        })

        rig.provider.revokeRefreshToken()
        rig.clock.advance(3601 * 1000)
        yield* svc.refreshMounts()
        expect(svc.mountSnapshotSync()["fake_google"]).toBeUndefined()
        const listed = yield* svc.list()
        expect(listed[0]?.status).toBe("needs-reauth")

        const removed = yield* svc.disconnect(instance.id)
        expect(removed).toBe(true)
        const revokeCall = rig.provider.calls.find((c) => c.url.endsWith("/revoke"))
        expect(revokeCall?.form["token"]).toBe("refresh-1")
      }).pipe(Effect.provide(rig.layer)),
    )
  })

  it("beginAuth without the per-operator client id is operator-actionable", async () => {
    const provider = makeProvider()
    const layer = ConnectorServiceLayer({
      definitions: [oauthDef],
      oauth: {
        client: makeOAuthClient(provider.fetchImpl),
        storeSecret: () => Effect.sync(() => "env:X"),
        env: {}, // no client configured
      },
    }).pipe(
      Layer.provide(ConnectorInstanceStore.Memory),
      Layer.provide(
        Layer.succeed(SecretProvider, {
          get: () =>
            Effect.fail(new ConfigError({ module: "t", key: "x", message: "n/a" })),
        }),
      ),
      Layer.provide(Clock.Default),
    )
    const err = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        return yield* svc
          .beginAuth({ definitionId: "fake-google", label: "x", loopbackPort: 50003 })
          .pipe(Effect.flip)
      }).pipe(Effect.provide(layer)),
    )
    expect(err.message).toContain("FAKE_GOOGLE_CLIENT_ID is not set")
    expect(err.message).toContain("~/.luna/.env")
  })
})

describe("setClientCredentials — operator OAuth client setup (M2.6)", () => {
  // A rig whose storeSecret writes the SAME `env` object oauthEnv reads, mirroring
  // production where storeSecret = persistEnvSecret sets process.env (which IS env).
  const makeSetupRig = () => {
    const provider = makeProvider()
    const clock = makeTestClock()
    const env: Record<string, string | undefined> = {} // empty = client NOT configured
    const stored = new Map<string, string>()
    const layer = ConnectorServiceLayer({
      definitions: [oauthDef],
      oauth: {
        client: makeOAuthClient(provider.fetchImpl),
        storeSecret: (varName, value) =>
          Effect.sync(() => {
            env[varName] = value
            stored.set(varName, value)
            return `env:${varName}`
          }),
        env,
      },
    }).pipe(
      Layer.provide(ConnectorInstanceStore.Memory),
      Layer.provide(
        Layer.succeed(SecretProvider, {
          get: (ref: string) => {
            const v = ref.startsWith("env:") ? stored.get(ref.slice(4)) : undefined
            return v !== undefined
              ? Effect.succeed(Redacted.make(v))
              : Effect.fail(new ConfigError({ module: "test", key: ref, message: "x" }))
          },
        }),
      ),
      Layer.provide(clock.layer),
    )
    return { env, stored, layer }
  }

  it("catalog reports configured:false until setClientCredentials flips it true", async () => {
    const rig = makeSetupRig()
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        const before = (yield* svc.catalog())[0]
        yield* svc.setClientCredentials({
          definitionId: "fake-google",
          clientId: "my-id.apps.googleusercontent.com",
          clientSecret: "my-secret",
        })
        const after = (yield* svc.catalog())[0]
        return { before, after }
      }).pipe(Effect.provide(rig.layer)) as Effect.Effect<{ before: any; after: any }>,
    )
    expect(out.before.clientSetup).toEqual({ configured: false })
    expect(out.after.clientSetup).toEqual({ configured: true })
    expect(rig.env["FAKE_GOOGLE_CLIENT_ID"]).toBe("my-id.apps.googleusercontent.com")
    expect(rig.env["FAKE_GOOGLE_CLIENT_SECRET"]).toBe("my-secret")
  })

  it("a missing secret is allowed — id alone flips configured (Desktop-app/PKCE clients)", async () => {
    const rig = makeSetupRig()
    const after = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        yield* svc.setClientCredentials({ definitionId: "fake-google", clientId: "id-only" })
        return (yield* svc.catalog())[0]
      }).pipe(Effect.provide(rig.layer)) as Effect.Effect<any>,
    )
    expect(after.clientSetup).toEqual({ configured: true })
    expect(rig.env["FAKE_GOOGLE_CLIENT_ID"]).toBe("id-only")
    expect(rig.env["FAKE_GOOGLE_CLIENT_SECRET"]).toBeUndefined() // no secret stored
  })

  it("rejects an unknown connector and an empty client id", async () => {
    const rig = makeSetupRig()
    const errs = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        const unknown = yield* svc
          .setClientCredentials({ definitionId: "nope", clientId: "x" })
          .pipe(Effect.flip)
        const empty = yield* svc
          .setClientCredentials({ definitionId: "fake-google", clientId: "   " })
          .pipe(Effect.flip)
        return { unknown: unknown.message, empty: empty.message }
      }).pipe(Effect.provide(rig.layer)) as Effect.Effect<{ unknown: string; empty: string }>,
    )
    expect(errs.unknown).toContain("unknown connector")
    expect(errs.empty).toContain("must not be empty")
  })
})
