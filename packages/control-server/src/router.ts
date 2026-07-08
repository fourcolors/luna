/**
 * tRPC v11 control plane router for Luna.
 *
 * Procedures:
 *   control.restart — platform-correct chat-server restart (launchctl on
 *                     darwin, SIGTERM-under-supervisor elsewhere)
 *   control.status  — returns server uptime / startedAt / version
 *   control.version — returns the package version string
 */
import { initTRPC } from "@trpc/server"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const t = initTRPC.create()

/** Module-level start timestamp — captured once when this module is first imported. */
const MODULE_START_MS = Date.now()

/**
 * Server semver — read from `server.version.json` at the repo root at import
 * time. `server.version.json` is the single source of truth bumped by
 * `scripts/bump-server.ts`; this wires it into `control.status` / `control.version`
 * so operators can inspect the live semver via the control plane (replacing the
 * dead `"0.0.1"` literal). Falls back to `"0.0.0"` if the file is absent or
 * malformed (e.g. in a container that strips non-source files) — a conspicuous
 * sentinel rather than a stale hard-coded version.
 */
const PKG_VERSION = (() => {
  try {
    // `import.meta.url` resolves to this file; the version JSON is two dirs up
    // (packages/control-server/src → repo root).
    const versionFile = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "server.version.json")
    const raw = JSON.parse(readFileSync(versionFile, "utf8")) as unknown
    if (raw !== null && typeof raw === "object" && "version" in raw && typeof (raw as Record<string, unknown>)["version"] === "string") {
      return (raw as Record<string, string>)["version"] as string
    }
    return "0.0.0"
  } catch {
    return "0.0.0"
  }
})()

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
     * Restart the chat server, platform-correctly. Mirrors
     * scheduleServerRestart in apps/ui-web/scripts/chat-server.ts (the
     * reference implementation for this exact branch):
     *
     *   darwin — `launchctl kickstart -k` of the launchd job; KeepAlive
     *            respawns it. The gui/<uid> label is the plist's hardcoded
     *            Label, NOT derivable from .env (the plist sets no env vars).
     *   else   — SIGTERM ourselves and let the unit's `Restart=always`
     *            respawn. No systemctl dependency, no unit-name resolution,
     *            works under any restart-on-exit supervisor. (The previous
     *            unconditional launchctl call was silently inert on the
     *            systemd production boxes — launchctl doesn't exist there
     *            and stdio:"ignore" swallowed the ENOENT.)
     *
     * Returns immediately so the HTTP response can be flushed; the restart
     * action runs after a 500ms delay. Failures of the delayed action can't
     * reach this response, so they are LOGGED (append-file logs / journal)
     * instead of ignored.
     */
    restart: t.procedure.mutation(async () => {
      if (process.platform === "darwin") {
        const uid = os.userInfo().uid
        const label = `gui/${uid}/${CHAT_SERVICE_LABEL}`

        // Delay so the tRPC HTTP response is sent before the process restarts
        setTimeout(() => {
          const result = spawnSync("launchctl", ["kickstart", "-k", label], {
            stdio: "ignore",
            timeout: 10_000,
          })
          if (result.error !== undefined || result.status !== 0) {
            console.error(
              `control.restart: launchctl kickstart failed (${
                result.error !== undefined
                  ? String(result.error)
                  : `exit ${result.status}`
              }) — is the ${CHAT_SERVICE_LABEL} launchd job installed?`,
            )
          }
        }, 500)

        return {
          ok: true as const,
          message: `Restart scheduled for ${label}`,
        }
      }

      // SIGTERM-suicide only works when something respawns us. systemd sets
      // INVOCATION_ID (and NOTIFY_SOCKET for Type=notify) in the service env;
      // with neither present (local `bun run`, ad-hoc incus exec, CI smokes)
      // a "restart" would silently become a permanent stop — the clean-exit-
      // means-dead class this slice exists to kill. Refuse instead.
      const supervised =
        (process.env["INVOCATION_ID"] ?? "") !== "" ||
        (process.env["NOTIFY_SOCKET"] ?? "") !== ""
      if (!supervised) {
        console.error(
          "control.restart: no supervisor detected (no INVOCATION_ID/NOTIFY_SOCKET) — refusing SIGTERM restart that would be a permanent stop",
        )
        return {
          ok: false as const,
          message:
            "no supervisor detected — restart refused (run under systemd, or restart manually)",
        }
      }

      // Delay so the tRPC HTTP response is sent before the process exits.
      setTimeout(() => {
        console.log(
          "control.restart: sending SIGTERM — supervisor (Restart=always) respawns",
        )
        process.kill(process.pid, "SIGTERM")
      }, 500)

      return {
        ok: true as const,
        message: "Restart scheduled via supervisor (SIGTERM + Restart=always)",
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
