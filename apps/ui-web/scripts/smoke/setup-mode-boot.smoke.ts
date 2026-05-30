/**
 * setup-mode-boot.smoke.ts — gate-logic verification for Task 3 (boot-time
 * credential readiness gate).
 *
 * chat-server.ts has NO tsc gate (root tsconfig excludes apps/ui-web/**;
 * the file is in scripts/, Bun-transpiled), so a broken import or wrong
 * argument shape in the live boot crashes silently. This smoke imports the
 * REAL exported gate functions and exercises all three decision paths:
 *
 *   1. No accounts → setup
 *   2. claude-code:login account + auth status ok:false → setup
 *   3. claude-code:login account + auth status ok:true → normal
 *
 * Run: bun run apps/ui-web/scripts/smoke/setup-mode-boot.smoke.ts
 * Exit 0 = PASS, non-zero = FAIL.
 */
import { decideMode, probeCredentialReadiness } from "../credential-readiness.js"

// Case 1: no accounts → setup
const empty = probeCredentialReadiness({
  dbPath: "/nonexistent/luna.db",
  claudeExe: "claude",
  _readAccounts: () => [],
})
if (decideMode(empty) !== "setup") throw new Error("expected setup for no accounts")
console.log("[smoke] case 1 OK: no accounts → setup")

// Case 2: claude-code:login account + lapsed auth → setup
const lapsed = probeCredentialReadiness({
  dbPath: "x",
  claudeExe: "claude",
  _readAccounts: () => [{ kind: "anthropic", secret_ref: "claude-code:login" }],
  _authStatus: () => ({ ok: false }),
})
if (decideMode(lapsed) !== "setup") throw new Error("expected setup for lapsed login")
console.log("[smoke] case 2 OK: lapsed login → setup")

// Case 3: claude-code:login account + healthy auth → normal
const ok = probeCredentialReadiness({
  dbPath: "x",
  claudeExe: "claude",
  _readAccounts: () => [{ kind: "anthropic", secret_ref: "claude-code:login" }],
  _authStatus: () => ({ ok: true }),
})
if (decideMode(ok) !== "normal") throw new Error("expected normal for healthy login")
console.log("[smoke] case 3 OK: healthy login → normal")

console.log("[smoke] setup-mode gate OK")
