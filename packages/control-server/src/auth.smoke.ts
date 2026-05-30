/**
 * auth.smoke.ts — end-to-end verification of the control-server auth gate.
 *
 * server.ts uses `Bun.serve` (a Bun global) so this can't run under vitest;
 * it's a bun-run smoke. It starts the REAL control server on a loopback test
 * port and issues real HTTP requests to prove the symptom is fixed:
 *   - no Authorization header        → 401
 *   - wrong bearer token             → 401
 *   - correct bearer token           → NOT 401 (request is routed)
 *   - OPTIONS preflight (no auth)    → 204 (must still pass for CORS)
 *
 * Run: bun run packages/control-server/src/auth.smoke.ts
 * Exit 0 = PASS, non-zero = FAIL.
 */
import { Effect } from "effect"
import { startControlServer } from "./server.js"

const TOKEN = "smoke-control-token-0123456789"
const PORT = 47531
const statusUrl =
  `http://127.0.0.1:${PORT}/trpc/control.status` +
  `?input=${encodeURIComponent(JSON.stringify({ json: null }))}`

await Effect.runPromise(startControlServer(PORT, TOKEN))

const noAuth = await fetch(statusUrl)
const wrong = await fetch(statusUrl, {
  headers: { Authorization: "Bearer wrong-token" },
})
const good = await fetch(statusUrl, {
  headers: { Authorization: `Bearer ${TOKEN}` },
})
const preflight = await fetch(statusUrl, { method: "OPTIONS" })

console.log("[smoke] no-auth     status:", noAuth.status, "(expect 401)")
console.log("[smoke] wrong-token status:", wrong.status, "(expect 401)")
console.log("[smoke] good-token  status:", good.status, "(expect NOT 401)")
console.log("[smoke] OPTIONS     status:", preflight.status, "(expect 204)")

const pass =
  noAuth.status === 401 &&
  wrong.status === 401 &&
  good.status !== 401 &&
  preflight.status === 204

if (!pass) {
  console.error("[smoke] FAIL — control-server auth gate not enforced as expected")
  process.exit(1)
}
console.log("[smoke] control-server auth OK")
process.exit(0)
