/**
 * Plaid client singleton.
 *
 * Reads PLAID_CLIENT_ID and PLAID_SECRET from env. Uses the "development"
 * environment by default — free tier, supports real accounts. Flip
 * PLAID_ENV=production when/if that's ever needed.
 *
 * Access tokens (one per bank Item) are stored as a JSON array in
 * PLAID_ACCESS_TOKENS, e.g.:
 *   PLAID_ACCESS_TOKENS=["access-development-abc123","access-development-xyz456"]
 */
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid"

export function makePlaidClient() {
  const clientId = process.env.PLAID_CLIENT_ID
  const secret = process.env.PLAID_SECRET
  const env = process.env.PLAID_ENV ?? "development"

  if (!clientId || !secret) {
    throw new Error(
      "PLAID_CLIENT_ID and PLAID_SECRET must be set. Run: bun run setup",
    )
  }

  const config = new Configuration({
    basePath: (
      PlaidEnvironments[env as keyof typeof PlaidEnvironments] ??
      PlaidEnvironments.development
    ) as string,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
      },
    },
  })

  return new PlaidApi(config)
}

export function getAccessTokens(): string[] {
  const raw = process.env.PLAID_ACCESS_TOKENS
  if (!raw) return []
  try {
    return JSON.parse(raw) as string[]
  } catch {
    return raw.split(",").map((t) => t.trim())
  }
}
