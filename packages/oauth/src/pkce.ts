/**
 * PKCE primitives — RFC 7636 (S256 only; the plain method is forbidden
 * here on purpose) plus the `state` nonce for CSRF binding.
 *
 * The verifier stays SERVER-SIDE for the whole flow (PRD §09: the thin
 * client only ever sees the authorization code, which is useless without
 * the verifier held here).
 */

const UNRESERVED =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"

/** 64 random chars from the RFC 3986 unreserved set (43..128 allowed). */
export const generateVerifier = (): string => {
  const bytes = new Uint8Array(64)
  crypto.getRandomValues(bytes)
  let out = ""
  for (const b of bytes) out += UNRESERVED[b % UNRESERVED.length]
  return out
}

/** URL-safe base64 without padding (RFC 7636 §4.2). */
const base64url = (bytes: Uint8Array): string => {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** code_challenge = BASE64URL(SHA256(ASCII(verifier))). */
export const challengeFor = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  )
  return base64url(new Uint8Array(digest))
}

/** Opaque CSRF-binding nonce for the authorize round-trip. */
export const generateState = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}
