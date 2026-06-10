/**
 * OAuthClient — authorization-code + PKCE for the connector flow
 * (PRD A §09, derisked against Google's current desktop-app rules).
 *
 * Deliberately tiny: build the authorize URL, exchange the code, refresh.
 * No token storage here — the ConnectorService owns persistence (refresh
 * token → SecretProvider ref) and the in-memory access-token cache.
 *
 * `fetch` is injected for tests (mock provider) and future proxying;
 * defaults to globalThis.fetch. Token VALUES never appear in errors.
 */
import { Data, Effect } from "effect"
import { challengeFor } from "./pkce.js"

export class OAuthError extends Data.TaggedError("OAuthError")<{
  readonly op: "exchange" | "refresh" | "authorize"
  /** Non-sensitive: HTTP status + the provider's `error` code only. */
  readonly message: string
}> {}

export interface TokenResponse {
  readonly accessToken: string
  /** Present on first exchange (Google: requires access_type=offline). */
  readonly refreshToken?: string
  /** Seconds until the access token expires (provider-reported). */
  readonly expiresInSec: number
}

export interface AuthorizeUrlInput {
  readonly authorizationEndpoint: string
  readonly clientId: string
  readonly redirectUri: string
  readonly scopes: ReadonlyArray<string>
  readonly state: string
  readonly verifier: string
  readonly extraParams?: Readonly<Record<string, string>>
}

export interface ExchangeInput {
  readonly tokenEndpoint: string
  readonly clientId: string
  /** Installed-app client secrets are issued-but-not-confidential
   *  (Google's words) — include when present. */
  readonly clientSecret?: string
  readonly code: string
  readonly verifier: string
  readonly redirectUri: string
}

export interface RefreshInput {
  readonly tokenEndpoint: string
  readonly clientId: string
  readonly clientSecret?: string
  readonly refreshToken: string
}

export type FetchLike = (
  url: string,
  init: {
    readonly method: "POST"
    readonly headers: Record<string, string>
    readonly body: string
  },
) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly json: () => Promise<unknown>
}>

export const buildAuthorizeUrl = async (
  input: AuthorizeUrlInput,
): Promise<string> => {
  const challenge = await challengeFor(input.verifier)
  const url = new URL(input.authorizationEndpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("scope", input.scopes.join(" "))
  url.searchParams.set("state", input.state)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  for (const [k, v] of Object.entries(input.extraParams ?? {})) {
    url.searchParams.set(k, v)
  }
  return url.toString()
}

const parseTokens = (
  op: "exchange" | "refresh",
  body: unknown,
): Effect.Effect<TokenResponse, OAuthError> => {
  const o = body as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  }
  if (typeof o?.access_token !== "string" || o.access_token.length === 0) {
    return Effect.fail(
      new OAuthError({ op, message: "token response missing access_token" }),
    )
  }
  return Effect.succeed({
    accessToken: o.access_token,
    ...(typeof o.refresh_token === "string" && o.refresh_token.length > 0
      ? { refreshToken: o.refresh_token }
      : {}),
    expiresInSec: typeof o.expires_in === "number" ? o.expires_in : 3600,
  })
}

const postForm = (
  fetchImpl: FetchLike,
  op: "exchange" | "refresh",
  url: string,
  form: Record<string, string>,
): Effect.Effect<TokenResponse, OAuthError> =>
  Effect.tryPromise({
    try: () =>
      fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      }),
    catch: (e) =>
      new OAuthError({ op, message: `token endpoint unreachable: ${String(e)}` }),
  }).pipe(
    Effect.flatMap((res) =>
      Effect.tryPromise({
        try: () => res.json(),
        catch: () =>
          new OAuthError({ op, message: `non-JSON token response (HTTP ${res.status})` }),
      }).pipe(
        Effect.flatMap((body) => {
          if (!res.ok) {
            const code = (body as { error?: unknown })?.error
            return Effect.fail(
              new OAuthError({
                op,
                // Provider error CODES are safe (invalid_grant etc.);
                // never include the response body wholesale.
                message: `HTTP ${res.status}${typeof code === "string" ? ` (${code})` : ""}`,
              }),
            )
          }
          return parseTokens(op, body)
        }),
      ),
    ),
  )

export interface OAuthClientApi {
  readonly exchange: (
    input: ExchangeInput,
  ) => Effect.Effect<TokenResponse, OAuthError>
  readonly refresh: (
    input: RefreshInput,
  ) => Effect.Effect<TokenResponse, OAuthError>
  /**
   * Best-effort RFC 7009 revocation. Never fails — disconnect must
   * succeed even when the provider is unreachable (the local secret is
   * dropped regardless; revocation is defence-in-depth, not a gate).
   */
  readonly revoke: (input: {
    readonly revocationEndpoint: string
    readonly token: string
  }) => Effect.Effect<void>
}

export const makeOAuthClient = (
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): OAuthClientApi => ({
  exchange: (input) =>
    postForm(fetchImpl, "exchange", input.tokenEndpoint, {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      ...(input.clientSecret !== undefined
        ? { client_secret: input.clientSecret }
        : {}),
    }),
  refresh: (input) =>
    postForm(fetchImpl, "refresh", input.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      ...(input.clientSecret !== undefined
        ? { client_secret: input.clientSecret }
        : {}),
    }),
  revoke: (input) =>
    Effect.tryPromise({
      try: () =>
        fetchImpl(input.revocationEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: input.token }).toString(),
        }),
      catch: () => undefined,
    }).pipe(Effect.ignore),
})
