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
import {
  buildAuthorizeUrl,
  generateState,
  generateVerifier,
  type OAuthClientApi,
} from "@luna/oauth"
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

/** How long a begun-but-not-completed OAuth grant stays redeemable. */
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000
/** Refresh an access token when it has less than this left. */
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

interface PendingAuth {
  readonly pendingId: string
  readonly definitionId: string
  readonly label: string
  readonly capabilityIds: ReadonlyArray<string>
  readonly verifier: string
  readonly state: string
  readonly redirectUri: string
  readonly startedAtMs: number
}

interface CachedAccessToken {
  readonly accessToken: string
  readonly expiresAtMs: number
}

export interface ConnectorServiceApi {
  /** Wire-safe catalog metadata for the settings UI. */
  readonly catalog: () => Effect.Effect<ReadonlyArray<ConnectorDefinitionMeta>>
  /** Current instances (status only — secretRef is a pointer, safe). */
  readonly list: () => Effect.Effect<ReadonlyArray<ConnectorInstance>>
  /**
   * Connect a non-OAuth definition (auth kind "api-key" or "none").
   * For api-key, `secretRef` must already point at the stored credential
   * (the secure-entry flow stores it first, then connects). OAuth
   * definitions reject here — they go through beginAuth/completeAuth.
   */
  readonly connect: (input: {
    readonly definitionId: string
    readonly label: string
    readonly secretRef?: string
    readonly capabilityIds?: ReadonlyArray<string>
  }) => Effect.Effect<ConnectorInstance, ConnectorError>
  /**
   * Client-brokered OAuth, server half (PRD §09): generate verifier +
   * state, build the consent URL for the client to open in the operator's
   * real browser. `loopbackPort` is the ephemeral 127.0.0.1 port the
   * CLIENT bound (RFC 8252 — the redirect lands on the client machine).
   */
  readonly beginAuth: (input: {
    readonly definitionId: string
    readonly label: string
    readonly capabilityIds?: ReadonlyArray<string>
    readonly loopbackPort: number
  }) => Effect.Effect<
    { readonly pendingId: string; readonly authUrl: string },
    ConnectorError
  >
  /**
   * Redeem the authorization code the client captured. Validates state
   * (CSRF binding), exchanges code+verifier at the token endpoint,
   * persists the refresh token via the injected secret sink, writes the
   * instance row, and mounts. The client never sees a token.
   */
  readonly completeAuth: (input: {
    readonly pendingId: string
    readonly code: string
    readonly state: string
  }) => Effect.Effect<ConnectorInstance, ConnectorError>
  /**
   * Persist the operator's per-operator OAuth client credentials (PRD §23) so
   * the consent flow can run without hand-editing ~/.luna/.env. Writes the
   * definition's clientIdEnvVar (and clientSecretEnvVar when a secret is given)
   * via the same secret sink the refresh token uses. The values are stored
   * server-side and never echoed back. Rejects non-oauth2 definitions and
   * when no OAuth wiring is configured.
   */
  readonly setClientCredentials: (input: {
    readonly definitionId: string
    readonly clientId: string
    readonly clientSecret?: string
  }) => Effect.Effect<void, ConnectorError>
  /** Remove an instance (best-effort token revocation included for OAuth). */
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
  /**
   * OAuth wiring (absent = OAuth definitions reject begin/complete).
   *   - client: the PKCE exchange/refresh client (@luna/oauth)
   *   - storeSecret: persist a refresh token under an env var AND make it
   *     resolvable immediately (the chat-server sets process.env + writes
   *     ~/.luna/.env atomically) — returns the secretRef to persist
   *   - env: where clientIdEnvVar/clientSecretEnvVar resolve (per-operator
   *     Google client, PRD §23 — nothing ships in-repo)
   */
  readonly oauth?: {
    readonly client: OAuthClientApi
    readonly storeSecret: (
      varName: string,
      value: string,
    ) => Effect.Effect<string, ConnectorError>
    /** Drop a stored env secret on disconnect (best-effort; review G2). */
    readonly clearSecret?: (varName: string) => Effect.Effect<void>
    readonly env: Readonly<Record<string, string | undefined>>
  }
}

/** `env:VARNAME` → `VARNAME`; anything else (op refs, "none") → null. */
const secretRefVarName = (ref: string): string | null =>
  ref.startsWith("env:") ? ref.slice(4) : null

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
      const oauth = options.oauth

      // The sync mount cache (see header). Plain object; JS single thread.
      let snapshot: Readonly<Record<string, McpServerConfigLike>> = {}
      // Minted access tokens — in memory ONLY, never persisted (PRD §08).
      const accessTokens = new Map<string, CachedAccessToken>()
      // Begun-but-unredeemed OAuth grants, pruned on every touch.
      const pendingAuths = new Map<string, PendingAuth>()
      // SINGLE-FLIGHT (review/PRD §23 refresh-race): every mount rebuild —
      // and therefore every token mint/refresh — runs under one permit.
      // Concurrent triggers (boot, connect, the chat-server's rotation
      // timer) serialize instead of double-refreshing the same instance.
      const refreshGate = yield* Effect.makeSemaphore(1)

      const oauthEnv = (name: string): string | null => {
        const v = oauth?.env[name]
        return typeof v === "string" && v.length > 0 ? v : null
      }

      /** Normalize an account label to a stable slug: mount-key suffix, env-var
       *  segment, and the per-definition uniqueness key (C1 multi-account). */
      const labelSlug = (label: string): string => {
        const s = label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
        if (s.length > 0) return s
        // Symbol-only / non-ASCII labels would all collapse to one fallback
        // slug and collide (review C1) — hash the raw label instead so
        // distinct labels stay distinct (deterministic djb2, no Date/random).
        let h = 5381
        for (let i = 0; i < label.length; i++) {
          h = ((h * 33) ^ label.charCodeAt(i)) >>> 0
        }
        return `acct_${h.toString(16)}`
      }

      /** The definition's DEFAULT label slug (the Moon sends label=def.name
       *  when the operator types nothing) — such instances keep the bare
       *  serverKey + the historical per-definition env var, so pre-C1 rows
       *  and tool names are untouched. Keyed off the IMMUTABLE definition.id
       *  (review C1): for every current catalog entry id-slug === name-slug,
       *  and a future display-name rename must not re-alias the historical
       *  var name or churn mount keys. */
      const defaultSlug = (definition: ConnectorDefinition): string =>
        labelSlug(definition.id)

      const refreshTokenVarName = (
        definition: ConnectorDefinition,
        label: string,
      ): string => {
        const base = `LUNA_CONNECTOR_${definition.id.toUpperCase().replace(/-/g, "_")}`
        const slug = labelSlug(label)
        // Default-labeled instance keeps the historical var name (back-compat
        // with rows minted before multi-account).
        return slug === defaultSlug(definition)
          ? `${base}_REFRESH_TOKEN`
          : `${base}_${slug.toUpperCase()}_REFRESH_TOKEN`
      }

      /** Per-instance mount key: bare serverKey for the default label (stable
       *  vs pre-C1), else serverKey_<slug>. Keys never change as sibling
       *  accounts come and go — slug uniqueness per definition is enforced at
       *  connect/beginAuth/completeAuth, so keys cannot collide. */
      const mountKey = (
        definition: ConnectorDefinition,
        instance: ConnectorInstance,
      ): string => {
        const slug = labelSlug(instance.label)
        return slug === defaultSlug(definition)
          ? definition.serverKey
          : `${definition.serverKey}_${slug}`
      }

      /** Valid cached access token, or mint one from the refresh token.
       *  Failure → needs-reauth + null (excluded from mounts). */
      const ensureAccessToken = (
        definition: ConnectorDefinition,
        instance: ConnectorInstance,
      ): Effect.Effect<string | null> =>
        Effect.gen(function* () {
          if (definition.auth.kind !== "oauth2" || oauth === undefined) {
            return null
          }
          const auth = definition.auth
          const now = yield* clock.nowMs()
          const cached = accessTokens.get(instance.id)
          if (cached !== undefined && cached.expiresAtMs - now > ACCESS_TOKEN_REFRESH_MARGIN_MS) {
            return cached.accessToken
          }
          const clientId = oauthEnv(auth.clientIdEnvVar)
          if (clientId === null) {
            yield* store.setStatus(instance.id, "error")
            console.warn(
              `[luna/connectors] ${definition.id}: ${auth.clientIdEnvVar} not set — excluded from mounts`,
            )
            return null
          }
          const refreshToken = yield* secrets.get(instance.secretRef).pipe(
            Effect.map(Redacted.value),
            Effect.catchAll(() => Effect.succeed(null)),
          )
          if (refreshToken === null) {
            yield* store.setStatus(instance.id, "needs-reauth")
            console.warn(
              `[luna/connectors] ${definition.id}: refresh token unresolvable — needs reauth`,
            )
            return null
          }
          const clientSecret = oauthEnv(auth.clientSecretEnvVar)
          const minted = yield* oauth.client
            .refresh({
              tokenEndpoint: auth.tokenEndpoint,
              clientId,
              ...(clientSecret !== null ? { clientSecret } : {}),
              refreshToken,
            })
            .pipe(Effect.catchAll(() => Effect.succeed(null)))
          if (minted === null) {
            // Revoked/expired refresh token (or provider down) — flag and
            // exclude; the settings UI offers Reconnect (PRD §08).
            yield* store.setStatus(instance.id, "needs-reauth")
            console.warn(
              `[luna/connectors] ${definition.id}: token refresh failed — needs reauth`,
            )
            return null
          }
          accessTokens.set(instance.id, {
            accessToken: minted.accessToken,
            expiresAtMs: now + minted.expiresInSec * 1000,
          })
          return minted.accessToken
        })

      const buildMount = (
        definition: ConnectorDefinition,
        instance: ConnectorInstance,
      ): Effect.Effect<McpServerConfigLike | null> =>
        Effect.gen(function* () {
          const t = definition.transport
          if (t.kind === "native") {
            return t.makeServer() as McpServerConfigLike
          }
          // OAuth definitions mount with a MINTED ACCESS TOKEN; api-key
          // definitions mount with the stored credential itself.
          let credential: string | null
          if (definition.auth.kind === "oauth2") {
            credential = yield* ensureAccessToken(definition, instance)
          } else {
            credential = yield* secrets.get(instance.secretRef).pipe(
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
          }
          if (credential === null) return null
          if (t.kind === "mcp-remote") {
            return {
              type: "http",
              url: t.url,
              headers: { Authorization: `Bearer ${credential}` },
            }
          }
          return {
            type: "stdio",
            command: t.command,
            args: [...t.args],
            env: { [t.secretEnvVar]: credential },
          }
        })

      // The ungated snapshot rebuild — ALL token minting (ensureAccessToken
      // via buildMount) happens here. Callers MUST hold refreshGate (review
      // G2): connect/completeAuth/disconnect run their check→mutate→rebuild
      // as ONE gated unit so a concurrent rotation tick can neither
      // double-mint a token nor re-add a just-removed instance's access
      // token to the cache.
      const rebuildSnapshot = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          const instances = yield* store.list()
          const next: Record<string, McpServerConfigLike> = {}
          for (const instance of instances) {
            if (instance.status !== "connected") continue
            const definition = definitions.get(instance.definitionId)
            if (definition === undefined) continue // catalog drift: orphan row, skip
            const mount = yield* buildMount(definition, instance)
            // C1 multi-account: each instance mounts under its own key — the
            // agent sees mcp__google_workspace__* (default label) alongside
            // mcp__google_workspace_flowstay__* etc.
            if (mount !== null) next[mountKey(definition, instance)] = mount
          }
          snapshot = next
        })

      const refreshMounts: ConnectorServiceApi["refreshMounts"] = () =>
        refreshGate.withPermits(1)(rebuildSnapshot())

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
          const capabilityIds =
            input.capabilityIds ??
            definition.capabilities.filter((c) => c.defaultGranted).map((c) => c.id)
          // ATOMIC check→insert→rebuild under the gate (review G2): the
          // duplicate guard and the insert must not interleave with a
          // second identical connect, or two rows land for one label.
          const label = input.label.trim() || definition.name
          return yield* refreshGate.withPermits(1)(
            Effect.gen(function* () {
              const existing = yield* store.list()
              // C1 multi-account: N instances per definition, ONE per label
              // slug (the slug keys the mount + the refresh-token env var).
              if (
                existing.some(
                  (i) =>
                    i.definitionId === definition.id &&
                    labelSlug(i.label) === labelSlug(label),
                )
              ) {
                return yield* Effect.fail(
                  new ConnectorError({
                    op: "connect",
                    message: `"${input.definitionId}" already has an account labeled "${label}" — pick a different label or disconnect it first`,
                  }),
                )
              }
              const now = yield* clock.nowMs()
              const instance: ConnectorInstance = {
                id: crypto.randomUUID(),
                definitionId: definition.id,
                label,
                status: "connected",
                secretRef: input.secretRef ?? "none",
                grantedScopes: scopesForCapabilities(definition, capabilityIds),
                accountKind: `connector-${definition.id}`,
                createdAt: now,
                lastHealthyAt: now,
              }
              yield* store.insert(instance)
              yield* rebuildSnapshot()
              return instance
            }),
          )
        })

      const pruneExpiredPending = (now: number): void => {
        for (const [id, p] of pendingAuths) {
          if (now - p.startedAtMs > PENDING_AUTH_TTL_MS) pendingAuths.delete(id)
        }
      }

      const beginAuth: ConnectorServiceApi["beginAuth"] = (input) =>
        Effect.gen(function* () {
          const definition = definitions.get(input.definitionId)
          if (definition === undefined || definition.auth.kind !== "oauth2") {
            return yield* Effect.fail(
              new ConnectorError({
                op: "beginAuth",
                message: `"${input.definitionId}" is not an OAuth connector`,
              }),
            )
          }
          if (oauth === undefined) {
            return yield* Effect.fail(
              new ConnectorError({
                op: "beginAuth",
                message: "OAuth is not configured on this server",
              }),
            )
          }
          const auth = definition.auth
          const clientId = oauthEnv(auth.clientIdEnvVar)
          if (clientId === null) {
            return yield* Effect.fail(
              new ConnectorError({
                op: "beginAuth",
                // Operator-actionable: this is the per-operator-client setup
                // step (PRD §23) — say exactly which var is missing.
                message: `${auth.clientIdEnvVar} is not set — create your own OAuth client and add it to ~/.luna/.env first`,
              }),
            )
          }
          const requestedLabel = input.label.trim() || definition.name
          const existing = yield* store.list()
          // C1 multi-account: only the LABEL must be free, not the definition.
          if (
            existing.some(
              (i) =>
                i.definitionId === definition.id &&
                labelSlug(i.label) === labelSlug(requestedLabel),
            )
          ) {
            return yield* Effect.fail(
              new ConnectorError({
                op: "beginAuth",
                message: `"${input.definitionId}" already has an account labeled "${requestedLabel}" — pick a different label or disconnect it first`,
              }),
            )
          }
          if (
            !Number.isInteger(input.loopbackPort) ||
            input.loopbackPort < 1 ||
            input.loopbackPort > 65535
          ) {
            return yield* Effect.fail(
              new ConnectorError({ op: "beginAuth", message: "invalid loopback port" }),
            )
          }
          const now = yield* clock.nowMs()
          pruneExpiredPending(now)
          const capabilityIds =
            input.capabilityIds ??
            definition.capabilities.filter((c) => c.defaultGranted).map((c) => c.id)
          const verifier = generateVerifier()
          const state = generateState()
          // RFC 8252 §7.3: the redirect lands on the CLIENT's loopback —
          // the server never needs a reachable callback (PRD §09).
          const redirectUri = `http://127.0.0.1:${input.loopbackPort}/callback`
          const pendingId = crypto.randomUUID()
          const authUrl = yield* Effect.promise(() =>
            buildAuthorizeUrl({
              authorizationEndpoint: auth.authorizationEndpoint,
              clientId,
              redirectUri,
              scopes: scopesForCapabilities(definition, capabilityIds),
              state,
              verifier,
              ...(auth.extraAuthParams !== undefined
                ? { extraParams: auth.extraAuthParams }
                : {}),
            }),
          )
          pendingAuths.set(pendingId, {
            pendingId,
            definitionId: definition.id,
            label: requestedLabel,
            capabilityIds,
            verifier,
            state,
            redirectUri,
            startedAtMs: now,
          })
          return { pendingId, authUrl }
        })

      const completeAuth: ConnectorServiceApi["completeAuth"] = (input) =>
        Effect.gen(function* () {
          const now = yield* clock.nowMs()
          pruneExpiredPending(now)
          const pending = pendingAuths.get(input.pendingId)
          if (pending === undefined) {
            return yield* Effect.fail(
              new ConnectorError({
                op: "completeAuth",
                message: "unknown or expired authorization — start over",
              }),
            )
          }
          // CSRF binding: the state the provider echoed must be OURS.
          if (input.state !== pending.state) {
            pendingAuths.delete(input.pendingId)
            return yield* Effect.fail(
              new ConnectorError({ op: "completeAuth", message: "state mismatch" }),
            )
          }
          const definition = definitions.get(pending.definitionId)
          if (definition === undefined || definition.auth.kind !== "oauth2" || oauth === undefined) {
            pendingAuths.delete(input.pendingId)
            return yield* Effect.fail(
              new ConnectorError({ op: "completeAuth", message: "connector no longer available" }),
            )
          }
          const auth = definition.auth
          const clientId = oauthEnv(auth.clientIdEnvVar)
          if (clientId === null) {
            // Consume the pending like the sibling early-exits (review G2):
            // the env var vanished mid-flow; don't leave the grant lingering.
            pendingAuths.delete(input.pendingId)
            return yield* Effect.fail(
              new ConnectorError({
                op: "completeAuth",
                message: `${auth.clientIdEnvVar} is not set`,
              }),
            )
          }
          const clientSecret = oauthEnv(auth.clientSecretEnvVar)
          const tokens = yield* oauth.client
            .exchange({
              tokenEndpoint: auth.tokenEndpoint,
              clientId,
              ...(clientSecret !== null ? { clientSecret } : {}),
              code: input.code,
              verifier: pending.verifier,
              redirectUri: pending.redirectUri,
            })
            .pipe(
              Effect.mapError(
                (e) =>
                  new ConnectorError({
                    op: "completeAuth",
                    message: `token exchange failed: ${e.message}`,
                  }),
              ),
            )
          // One-shot: the code is consumed whatever happens next.
          pendingAuths.delete(input.pendingId)
          if (tokens.refreshToken === undefined) {
            return yield* Effect.fail(
              new ConnectorError({
                op: "completeAuth",
                message:
                  "provider returned no refresh token — re-consent is required (the definition should send access_type=offline & prompt=consent)",
              }),
            )
          }
          // Narrowed capture — TS cannot carry the undefined-check into the
          // gated closure below.
          const refreshToken = tokens.refreshToken
          // ATOMIC duplicate-check→storeSecret→insert→rebuild under the gate
          // (reviews G2 + C1): two concurrent OAuth flows for one LABEL each
          // reach here. The duplicate re-check runs BEFORE the token is
          // persisted — were storeSecret outside the gate, a LOSING same-label
          // flow (possibly consented as a DIFFERENT Google account) would
          // overwrite the winner's refresh token in the shared per-label var
          // and silently swap accounts at the next refresh. The loser's
          // exchanged token is simply dropped (never persisted; the code was
          // single-use anyway).
          return yield* refreshGate.withPermits(1)(
            Effect.gen(function* () {
              const existing = yield* store.list()
              if (
                existing.some(
                  (i) =>
                    i.definitionId === definition.id &&
                    labelSlug(i.label) === labelSlug(pending.label),
                )
              ) {
                return yield* Effect.fail(
                  new ConnectorError({
                    op: "completeAuth",
                    message: `"${definition.id}" already has an account labeled "${pending.label}" — pick a different label or disconnect it first`,
                  }),
                )
              }
              // Invariant: no two instances may ever share a token var. The
              // slug-uniqueness guard makes a collision unreachable today;
              // this converts any future drift from silent cross-account
              // contamination into a clean error (review C1).
              const varName = refreshTokenVarName(definition, pending.label)
              if (existing.some((i) => i.secretRef === `env:${varName}`)) {
                return yield* Effect.fail(
                  new ConnectorError({
                    op: "completeAuth",
                    message: `another connected account already uses the credential slot for "${pending.label}" — pick a different label`,
                  }),
                )
              }
              // Persist the refresh token via the injected sink; the instance
              // row stores only the returned POINTER. The var name is keyed by
              // the LABEL slug (C1) so each account's token lives in its own
              // ~/.luna/.env entry; the default label keeps the historical
              // per-definition var (pre-C1 rows untouched).
              const secretRef = yield* oauth.storeSecret(varName, refreshToken)
              const instance: ConnectorInstance = {
                id: crypto.randomUUID(),
                definitionId: definition.id,
                label: pending.label,
                status: "connected",
                secretRef,
                grantedScopes: scopesForCapabilities(definition, pending.capabilityIds),
                accountKind: `connector-${definition.id}`,
                createdAt: now,
                lastHealthyAt: now,
              }
              yield* store.insert(instance)
              // Seed the access-token cache so the first mount needs no refresh.
              accessTokens.set(instance.id, {
                accessToken: tokens.accessToken,
                expiresAtMs: now + tokens.expiresInSec * 1000,
              })
              yield* rebuildSnapshot()
              return instance
            }),
          )
        })

      const disconnect: ConnectorServiceApi["disconnect"] = (instanceId) =>
        // Gated end-to-end (review G2): revoke→delete-secret→remove-row→
        // clear-cache→rebuild is one atomic unit so the rotation fiber
        // can't re-mint/re-cache a token for the instance mid-removal.
        refreshGate.withPermits(1)(
          Effect.gen(function* () {
            const instances = yield* store.list()
            const instance = instances.find((i) => i.id === instanceId)
            if (instance !== undefined && oauth !== undefined) {
              const definition = definitions.get(instance.definitionId)
              if (definition !== undefined && definition.auth.kind === "oauth2") {
                const refreshToken = yield* secrets.get(instance.secretRef).pipe(
                  Effect.map(Redacted.value),
                  Effect.catchAll(() => Effect.succeed(null)),
                )
                // Best-effort provider revocation BEFORE dropping local
                // state (PRD §16: disconnect revokes, not just deletes).
                if (
                  refreshToken !== null &&
                  definition.auth.revocationEndpoint !== undefined
                ) {
                  yield* oauth.client.revoke({
                    revocationEndpoint: definition.auth.revocationEndpoint,
                    token: refreshToken,
                  })
                }
                // Drop the LOCAL refresh-token secret too (review G2): a
                // revoked token left in ~/.luna/.env is dead weight and a
                // needless lingering credential. Best-effort.
                if (oauth.clearSecret !== undefined) {
                  const varName = secretRefVarName(instance.secretRef)
                  if (varName !== null) {
                    yield* oauth
                      .clearSecret(varName)
                      .pipe(Effect.catchAll(() => Effect.void))
                  }
                }
              }
            }
            accessTokens.delete(instanceId)
            const removed = yield* store.remove(instanceId)
            if (removed) yield* rebuildSnapshot()
            return removed
          }),
        )

      const setClientCredentials: ConnectorServiceApi["setClientCredentials"] = (
        input,
      ) =>
        Effect.gen(function* () {
          const definition = definitions.get(input.definitionId)
          if (definition === undefined) {
            return yield* Effect.fail(
              new ConnectorError({
                op: "setClientCredentials",
                message: `unknown connector: ${input.definitionId}`,
              }),
            )
          }
          if (definition.auth.kind !== "oauth2") {
            return yield* Effect.fail(
              new ConnectorError({
                op: "setClientCredentials",
                message: `${input.definitionId} does not use an OAuth client`,
              }),
            )
          }
          if (oauth === undefined) {
            return yield* Effect.fail(
              new ConnectorError({
                op: "setClientCredentials",
                message: "OAuth is not configured on this server",
              }),
            )
          }
          const id = input.clientId.trim()
          if (id.length === 0) {
            return yield* Effect.fail(
              new ConnectorError({
                op: "setClientCredentials",
                message: "client id must not be empty",
              }),
            )
          }
          const secret = input.clientSecret?.trim()
          // The env-file writer's documented precondition: values must not
          // carry newlines (an interior \n would inject an extra line into
          // ~/.luna/.env — review M2.6). Reject WITHOUT echoing the value.
          if (/[\r\n]/.test(id) || (secret !== undefined && /[\r\n]/.test(secret))) {
            return yield* Effect.fail(
              new ConnectorError({
                op: "setClientCredentials",
                message: "credentials must not contain line breaks",
              }),
            )
          }
          // Persist via the same sink the refresh token uses (process.env +
          // atomic ~/.luna/.env at 0600). SECRET FIRST, id LAST (review M2.6):
          // `configured` keys on the id var, so committing the id only after
          // the secret succeeds means a partial failure can never leave a
          // "configured" connector whose token exchange is missing its secret.
          if (secret !== undefined && secret.length > 0) {
            yield* oauth.storeSecret(definition.auth.clientSecretEnvVar, secret)
          }
          yield* oauth.storeSecret(definition.auth.clientIdEnvVar, id)
        })

      // Build wire-safe catalog metadata, enriching oauth2 per-operator-client
      // definitions with their current `configured` state (id env var set?).
      const catalog: ConnectorServiceApi["catalog"] = () =>
        Effect.succeed(
          options.definitions.map((d) => {
            const meta = toMeta(d)
            if (d.auth.kind !== "oauth2") return meta
            return {
              ...meta,
              clientSetup: {
                configured:
                  oauth !== undefined &&
                  oauthEnv(d.auth.clientIdEnvVar) !== null,
              },
            }
          }),
        )

      // Boot: hydrate the snapshot from persisted instances so threads
      // created before any settings interaction still get their mounts.
      yield* refreshMounts()

      return {
        catalog,
        list: () => store.list(),
        connect,
        beginAuth,
        completeAuth,
        setClientCredentials,
        disconnect,
        refreshMounts,
        mountSnapshotSync: () => snapshot,
      } satisfies ConnectorServiceApi
    }),
  )
