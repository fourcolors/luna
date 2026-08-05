/**
 * setup-mode-boot.smoke.ts — gate-logic + layer-build verification for Task 3
 * (boot-time credential readiness gate).
 *
 * `chat-server.ts` (apps/server/src, S09) has a tsc gate, but tsc cannot see
 * whether a Layer.provide composition actually resolves at runtime - a broken
 * import or wrong argument shape in the live boot still crashes silently with
 * no type error. This smoke:
 *
 *   1. Tests the three decision paths of the credential gate (pure functions,
 *      no network / disk required).
 *   2. Actually BUILDS the setup-mode ManagedRuntime on ephemeral ports and
 *      disposes it — this proves the requirement chain (UIService →
 *      ObservabilityService → Clock) is correctly satisfied and that passing
 *      null for chatService/accountBroker/survey/localShellBridge is
 *      type-correct and accepted by startUIWebSocketServer.
 *
 * Regression guard: removing `.pipe(Layer.provide(uiL))` from
 * buildSetupServerLayer MUST make this smoke FAIL with a missing-UIService
 * defect. Verify once (delete → FAIL → restore) before committing.
 *
 * Run: LUNA_UI_WS_TOKEN=smoke-test-token-ok bun run apps/ui-web/scripts/smoke/setup-mode-boot.smoke.ts
 * (UI_WS_TOKEN / LUNA_UI_WS_TOKEN must be ≥16 chars — required by startUIWebSocketServer)
 * Exit 0 = PASS, non-zero = FAIL.
 */
import { decideMode, probeCredentialReadiness } from "../../../server/src/credential-readiness.js"
import { buildSetupServerLayer } from "../../../server/src/chat-server.js"
import { Effect, ManagedRuntime } from "effect"

// ── Part 1: credential gate decision paths ────────────────────────────────

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

// ── Part 2: layer build + dispose ─────────────────────────────────────────
//
// Use port 0 for WS (OS picks an ephemeral port). Control server uses
// Bun.serve with no scope finalizer so we pass a fixed port here — but
// since the smoke process exits after dispose(), there is no port leak.
// We still avoid 4754 to not conflict with a running server.
const rt = ManagedRuntime.make(buildSetupServerLayer(0, 14754))
rt.runPromise(Effect.void)
  .then(() => rt.dispose())
  .then(() => {
    console.log("[smoke] setup-mode gate OK")
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("[smoke] FAIL — setup-mode layer build defect:", err)
    process.exit(1)
  })
