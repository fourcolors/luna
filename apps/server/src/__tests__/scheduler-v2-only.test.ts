/**
 * scheduler-v2-only.test.ts — the post-removal contract.
 *
 * Replaces dream-wake-cutover.test.ts. After removing the
 * `LUNA_SCHEDULER_V2_ENABLED` kill switch and the legacy V1 (fiber-per-cron)
 * scheduling path, V2 is the ONLY scheduler. This guards the boot script so the
 * flag / legacy cron factories can never silently creep back in:
 *
 *   - the chat-server boot script reads no `LUNA_SCHEDULER_V2_ENABLED` env var,
 *   - it defines no `buildDreamCronLayer` / `buildWakeCronLayer` legacy factory,
 *   - it wires the V2 JobTicker unconditionally (no `schedulerV2Enabled` gate),
 *   - the deleted V1 modules are gone from packages/core.
 *
 * Pure source assertions (read the files via fs) — no boot, no SQLite — so it
 * runs identically under node-vitest and bun.
 */
import { describe, expect, it } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const chatServerPath = join(here, "..", "chat-server.ts")
const chatServerSrc = readFileSync(chatServerPath, "utf8")
const repoRoot = join(here, "..", "..", "..", "..")

describe("scheduler is V2-only (flag + legacy cron path removed)", () => {
  it("the boot script never reads LUNA_SCHEDULER_V2_ENABLED", () => {
    expect(chatServerSrc).not.toContain("LUNA_SCHEDULER_V2_ENABLED")
    expect(chatServerSrc).not.toContain("schedulerV2Enabled")
  })

  it("defines no legacy dream/wake cron factories", () => {
    // A tombstone comment may still name them for discoverability; what must be
    // gone is the factory *definition* and any call to it.
    expect(chatServerSrc).not.toMatch(/export const buildDreamCronLayer/)
    expect(chatServerSrc).not.toMatch(/export const buildWakeCronLayer/)
    expect(chatServerSrc).not.toMatch(/buildDreamCronLayer\(/)
    expect(chatServerSrc).not.toMatch(/buildWakeCronLayer\(/)
  })

  it("wires the V2 JobTicker unconditionally, with the S11a lunaHome marker seam", () => {
    // The lunaHome argument is load-bearing: without it runBootReconcile
    // never sees the clean-shutdown marker and the restart exemption is
    // silently dead forever - pin the argument, not just the call.
    expect(chatServerSrc).toMatch(/const jobTickerL = JobTickerLayer\(\{[^)]*lunaHome/)
    // The ticker layer must not be guarded behind a nullable ternary anymore.
    expect(chatServerSrc).not.toMatch(/jobTickerL\s*\?\?\s*Layer\.empty/)
  })

  it("gates the clean-shutdown marker write on a boot that ran reconcile", () => {
    // Un-gated, a setup-mode restart or a SIGTERM during the lazy layer
    // build writes a marker that launders a PRECEDING genuine crash's
    // orphans into an exempted boot (fail-open). The write must sit behind
    // the arming flag, and only buildMain (post-ServerHandle) may arm it.
    expect(chatServerSrc).toMatch(/if \(cleanShutdownMarkerArmed\) \{/)
    expect(chatServerSrc).toMatch(/cleanShutdownMarkerArmed = true/)
    const armCount = chatServerSrc.match(/cleanShutdownMarkerArmed = true/g)
    expect(armCount).toHaveLength(1)
  })

  it("always wires the AcceptHandler (no flag gate)", () => {
    expect(chatServerSrc).not.toMatch(/\?\s*acceptHandlerL\s*:\s*Layer\.empty/)
  })

  it("the legacy V1 scheduler modules are deleted", () => {
    const gone = [
      "packages/core/src/jobs/trigger-agent.ts",
      "packages/core/src/jobs/job-scheduler.ts",
      "packages/core/src/dream/dream-cron-layer.ts",
      "packages/core/src/wake/wake-cron-layer.ts",
    ]
    for (const rel of gone) {
      expect(existsSync(join(repoRoot, rel)), `${rel} should be deleted`).toBe(
        false,
      )
    }
  })
})
