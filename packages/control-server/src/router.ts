/**
 * tRPC v11 control plane router for Luna.
 *
 * Procedures:
 *   control.restart — triggers launchctl kickstart of the chat-server service
 *   control.status  — returns server uptime / startedAt / version
 *   control.version — returns the package version string
 */
import { initTRPC } from "@trpc/server"
import os from "node:os"
import { spawnSync } from "node:child_process"

const t = initTRPC.create()

/** Module-level start timestamp — captured once when this module is first imported. */
const MODULE_START_MS = Date.now()

/** Package version read at import time (static string so it's bundle-safe). */
const PKG_VERSION = "0.0.1"

/** Service label used in launchctl commands. */
const CHAT_SERVICE_LABEL = "com.user.luna-chat-server"

/**
 * Build the control-plane router. `buildSha` is the git short-SHA of the
 * running server build, surfaced in `control.status` so operators can tell
 * which commit is live. Defaults to "unknown" — the boot entry threads the
 * resolved value in via `startControlServer(port, token, buildSha)`. Kept as a
 * factory (rather than a static object) so the SHA can be injected at boot
 * without a context type; the static `appRouter` export below preserves the
 * existing import shape for tests and the `AppRouter` type.
 */
export const createAppRouter = (buildSha: string = "unknown") =>
  t.router({
  control: t.router({
    /**
     * Restart the chat server via launchctl.
     * Returns immediately so the HTTP response can be flushed, then kicks the
     * service after a 500ms delay.
     */
    restart: t.procedure.mutation(async () => {
      const uid = os.userInfo().uid
      const label = `gui/${uid}/${CHAT_SERVICE_LABEL}`

      // Delay so the tRPC HTTP response is sent before the process restarts
      setTimeout(() => {
        spawnSync("launchctl", ["kickstart", "-k", label], {
          stdio: "ignore",
        })
      }, 500)

      return {
        ok: true as const,
        message: `Restart scheduled for ${label}`,
      }
    }),

    /**
     * Return runtime status: uptime, ISO start timestamp, and version.
     */
    status: t.procedure.query(() => {
      const uptimeSec = Math.floor((Date.now() - MODULE_START_MS) / 1000)
      return {
        uptime: uptimeSec,
        startedAt: new Date(MODULE_START_MS).toISOString(),
        version: PKG_VERSION,
        // Git short-SHA of this build (or "unknown"). Additive — older
        // clients ignore the extra field.
        buildSha,
      }
    }),

    /**
     * Return the package version.
     */
    version: t.procedure.query(() => ({
      version: PKG_VERSION,
    })),
  }),
  })

/**
 * Static router instance — preserves the existing `appRouter` import shape for
 * tests (`appRouter.createCaller`) and the fetch adapter. The default "unknown"
 * buildSha applies here; the live server uses `createAppRouter(buildSha)`.
 */
export const appRouter = createAppRouter()

export type AppRouter = typeof appRouter
