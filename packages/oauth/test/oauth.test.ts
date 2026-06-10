/**
 * OAuth package tests — PKCE correctness (pinned to the RFC 7636 appendix
 * test vector), authorize-URL construction, and the exchange/refresh wire
 * format against a mock token endpoint.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  buildAuthorizeUrl,
  challengeFor,
  generateState,
  generateVerifier,
  makeOAuthClient,
  type FetchLike,
} from "../src/index.js"

describe("PKCE", () => {
  it("challengeFor matches the RFC 7636 Appendix B test vector", async () => {
    // https://datatracker.ietf.org/doc/html/rfc7636#appendix-B
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    expect(await challengeFor(verifier)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    )
  })

  it("verifier: RFC-unreserved charset, length 64, high uniqueness", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const v = generateVerifier()
      expect(v).toMatch(/^[A-Za-z0-9\-._~]{64}$/)
      seen.add(v)
    }
    expect(seen.size).toBe(200)
  })

  it("state: url-safe, no padding, unique", () => {
    const a = generateState()
    const b = generateState()
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a).not.toBe(b)
  })
})

describe("buildAuthorizeUrl", () => {
  it("carries every RFC parameter + extras, S256 method, derived challenge", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    const url = new URL(
      await buildAuthorizeUrl({
        authorizationEndpoint: "https://accounts.example.test/o/oauth2/auth",
        clientId: "client-123",
        redirectUri: "http://127.0.0.1:49152/callback",
        scopes: ["scope.a", "scope.b"],
        state: "state-xyz",
        verifier,
        extraParams: { access_type: "offline", prompt: "consent" },
      }),
    )
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("client-123")
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:49152/callback")
    expect(url.searchParams.get("scope")).toBe("scope.a scope.b")
    expect(url.searchParams.get("state")).toBe("state-xyz")
    expect(url.searchParams.get("code_challenge")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    )
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("prompt")).toBe("consent")
    // the verifier itself must NEVER appear in the URL
    expect(url.toString()).not.toContain(verifier)
  })
})

describe("OAuthClient — wire format against a mock provider", () => {
  const capture: { url?: string; body?: URLSearchParams } = {}
  const mockFetch =
    (status: number, payload: unknown): FetchLike =>
    async (url, init) => {
      capture.url = url
      capture.body = new URLSearchParams(init.body)
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      }
    }

  it("exchange posts the authorization-code grant with verifier + secret", async () => {
    const client = makeOAuthClient(
      mockFetch(200, {
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3599,
      }),
    )
    const tokens = await Effect.runPromise(
      client.exchange({
        tokenEndpoint: "https://oauth2.example.test/token",
        clientId: "cid",
        clientSecret: "csecret",
        code: "auth-code-1",
        verifier: "verifier-1",
        redirectUri: "http://127.0.0.1:49152/callback",
      }),
    )
    expect(tokens).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresInSec: 3599,
    })
    expect(capture.url).toBe("https://oauth2.example.test/token")
    expect(Object.fromEntries(capture.body!)).toEqual({
      grant_type: "authorization_code",
      code: "auth-code-1",
      code_verifier: "verifier-1",
      redirect_uri: "http://127.0.0.1:49152/callback",
      client_id: "cid",
      client_secret: "csecret",
    })
  })

  it("refresh posts the refresh_token grant; omits client_secret when absent", async () => {
    const client = makeOAuthClient(
      mockFetch(200, { access_token: "at-2", expires_in: 100 }),
    )
    const tokens = await Effect.runPromise(
      client.refresh({
        tokenEndpoint: "https://oauth2.example.test/token",
        clientId: "cid",
        refreshToken: "rt-1",
      }),
    )
    expect(tokens.accessToken).toBe("at-2")
    expect(tokens.refreshToken).toBeUndefined()
    expect(Object.fromEntries(capture.body!)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt-1",
      client_id: "cid",
    })
  })

  it("provider errors surface the status + error CODE — never the body or tokens", async () => {
    const client = makeOAuthClient(
      mockFetch(400, { error: "invalid_grant", error_description: "secret-ish detail" }),
    )
    const err = await Effect.runPromise(
      client
        .refresh({
          tokenEndpoint: "https://oauth2.example.test/token",
          clientId: "cid",
          refreshToken: "rt-revoked",
        })
        .pipe(Effect.flip),
    )
    expect(err._tag).toBe("OAuthError")
    expect(err.message).toBe("HTTP 400 (invalid_grant)")
    expect(err.message).not.toContain("secret-ish")
    expect(JSON.stringify(err)).not.toContain("rt-revoked")
  })

  it("missing access_token in a 200 body is an error, not a crash", async () => {
    const client = makeOAuthClient(mockFetch(200, { weird: true }))
    const err = await Effect.runPromise(
      client
        .exchange({
          tokenEndpoint: "https://t",
          clientId: "c",
          code: "x",
          verifier: "v",
          redirectUri: "r",
        })
        .pipe(Effect.flip),
    )
    expect(err.message).toContain("missing access_token")
  })
})
