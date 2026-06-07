/**
 * wake-cron-boot.smoke.ts — boot-risk verification for the wake cron layer.
 *
 * chat-server.ts has NO tsc gate (root tsconfig excludes apps/ui-web/**),
 * so a missing service in the layer graph crashes the WHOLE boot. This
 * smoke PROVES the wake cron sub-layer builds with a ManagedRuntime by
 * importing the REAL exported `buildWakeCronLayer` factory — not a
 * hand-copied mirror.
 *
 * Doubles:
 *   - Real `WakeReasonerDefault` (keeps SDKClient requirement intact — proves
 *     the wiring shape the live boot uses)
 *   - `SDKClient.fake` so ZERO model calls are made (cron never fires during
 *     a layer build, so reason() is never invoked anyway)
 *   - workspacePath = process.cwd() — WakeLogStore.makeLayer opens
 *     <cwd>/.workspace/workspace.db at layer build. If the file doesn't
 *     exist, bun:sqlite creates it; the table-missing failure surfaces only
 *     on the first append(), not at boot.
 *
 * Regression guard: removing `Layer.provide(sdkClientL)` from
 * buildWakeCronLayer MUST make this smoke FAIL with a missing-service defect.
 *
 * Run: bun run apps/ui-web/scripts/smoke/wake-cron-boot.smoke.ts
 * Exit 0 = PASS, non-zero = FAIL (missing service in graph → fix Layer.provide)
 */
import { Clock, WakeCron } from "@luna/core"
import { SDKClient } from "@luna/adapter-sdk"
import type { Query } from "@luna/adapter-sdk"
import { Effect, ManagedRuntime, Layer } from "effect"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildWakeCronLayer } from "../chat-server.js"

// ---------------------------------------------------------------------------
// Set up a temp workspace dir so WakeLogStore.makeLayer can open the db
// ---------------------------------------------------------------------------

const wsRoot = mkdtempSync(join(tmpdir(), "wake-smoke-"))
const wsDir = join(wsRoot, ".workspace")
mkdirSync(wsDir, { recursive: true })
writeFileSync(join(wsDir, "workspace.md"), "# smoke workspace\n")
// Note: workspace.db file is created lazily on first open by WakeLogStore.

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/**
 * Canned, model-free Query. The cron does NOT fire during a layer build,
 * so reason() is never invoked — but WakeReasonerDefault.SDKClient must
 * be satisfiable, which is exactly what this smoke proves.
 */
const sdkFake: Layer.Layer<SDKClient> = SDKClient.fake(() => {
  async function* gen(): AsyncGenerator<never> {
    // never yields — reason() is never called during a layer build
  }
  return gen() as unknown as Query
})

// ---------------------------------------------------------------------------
// Build the layer under test — SAME factory the live boot uses
// ---------------------------------------------------------------------------

const layer = buildWakeCronLayer({
  expr: "*/30 * * * *",
  workspaceSlug: "smoke",
  workspacePath: wsRoot,
  sdkClientL: sdkFake,
  clockL: Clock.Default,
})

// ---------------------------------------------------------------------------
// The assertion: resolve WakeCron marker (forces the layer to build)
// ---------------------------------------------------------------------------

const main = Effect.gen(function* () {
  const marker = yield* WakeCron
  console.log(
    "[smoke] WakeCron marker resolved; expr =",
    marker.expr,
    "slug =",
    marker.workspaceSlug,
    "triggerId =",
    marker.triggerId,
  )
  if (marker.expr !== "*/30 * * * *") {
    throw new Error(
      `[smoke] FAIL — expected expr "*/30 * * * *", got "${marker.expr}"`,
    )
  }
  if (marker.workspaceSlug !== "smoke") {
    throw new Error(
      `[smoke] FAIL — expected slug "smoke", got "${marker.workspaceSlug}"`,
    )
  }
  if (!marker.triggerId) {
    throw new Error("[smoke] FAIL — triggerId is falsy")
  }
})

const rt = ManagedRuntime.make(layer)
rt.runPromise(main)
  .then(() => rt.dispose())
  .then(() => {
    console.log(
      "[smoke] PASS — wake cron layer builds with the real WakeReasonerDefault graph (SDKClient + WakeLogStore satisfied)",
    )
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("[smoke] FAIL — layer build defect:", err)
    process.exit(1)
  })
