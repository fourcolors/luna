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

export const appRouter = t.router({
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

export type AppRouter = typeof appRouter
