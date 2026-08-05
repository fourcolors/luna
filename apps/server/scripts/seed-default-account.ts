/**
 * seed-default-account — installer entry to idempotently seed the default
 * account into luna.db.
 *
 * Chooses the durable `env:CLAUDE_CODE_OAUTH_TOKEN` pointer when a non-empty
 * `CLAUDE_CODE_OAUTH_TOKEN` is present in the environment (the long-lived
 * setup-token path), otherwise `claude-code:login`. It writes only the POINTER
 * ref — never the token value (the value stays in the gitignored `.env` and is
 * resolved per-query at runtime). No-op if an account already exists.
 *
 * Usage:
 *   bun run apps/ui-web/scripts/seed-default-account.ts [dbPath]
 *     dbPath defaults to $LUNA_DB_PATH, then $LUNA_HOME/luna.db.
 */
import { chooseDefaultSecretRef, seedDefaultAccount } from "../src/setup-login.js"

const dbPath =
  process.argv[2] ??
  process.env.LUNA_DB_PATH ??
  (process.env.LUNA_HOME ? `${process.env.LUNA_HOME}/luna.db` : undefined)

if (!dbPath) {
  console.error(
    "[seed-default-account] no db path — pass it as an arg or set LUNA_DB_PATH / LUNA_HOME",
  )
  process.exit(2)
}

const secretRef = chooseDefaultSecretRef(process.env)
try {
  const r = seedDefaultAccount(dbPath, secretRef)
  console.log(
    r.seeded
      ? `[seed-default-account] seeded default account (secret_ref=${r.secretRef})`
      : `[seed-default-account] account already present — no-op (policy would use secret_ref=${r.secretRef})`,
  )
  process.exit(0)
} catch (e) {
  console.error(`[seed-default-account] failed: ${String(e)}`)
  process.exit(1)
}
