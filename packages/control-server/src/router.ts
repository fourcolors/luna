/**
 * tRPC v11 control plane router for Luna.
 *
 * Procedures:
 *   control.restart — platform-correct chat-server restart (launchctl on
 *                     darwin, SIGTERM-under-supervisor elsewhere)
 *   control.status  — returns server uptime / startedAt / version
 *   control.version — returns the package version string
 *   control.checkServerUpdate — checks GitHub for a newer server-v* release
 *   control.updateServer — triggers luna-update-server to a target ref
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
 * Compare two semver strings. Returns negative if a < b, 0 if equal,
 * positive if a > b. Non-numeric parts are compared as 0.
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v.split(".").map((p) => {
      const n = parseInt(p, 10)
      return Number.isNaN(n) ? 0 : n
    })
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

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

    /**
     * Check GitHub for a newer server-v* release. Compares the running
     * version (PKG_VERSION) against the latest published server release.
     *
     * Returns `{ current, latest, updateAvailable, tag, notes }`. `latest`
     * is null when the check fails (network error, no releases found);
     * callers should treat that as "unknown", not "up to date".
     */
    checkServerUpdate: t.procedure.query(async () => {
      const current = PKG_VERSION
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15_000)
        let res: Response
        try {
          res = await fetch(
            "https://api.github.com/repos/fourcolors/luna/releases?per_page=20",
            {
              signal: controller.signal,
              headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": "luna-control-server",
              },
            },
          )
        } finally {
          clearTimeout(timer)
        }
        if (!res.ok) {
          throw new Error(`GitHub API returned ${res.status}`)
        }
        const releases = (await res.json()) as Array<{
          tag_name: string
          body: string | null
          draft: boolean
          prerelease: boolean
        }>
        const serverReleases = releases.filter(
          (r) =>
            r.tag_name.startsWith("server-v") &&
            !r.draft &&
            !r.prerelease,
        )
        if (serverReleases.length === 0) {
          throw new Error("no server-v* releases found")
        }
        // Releases are returned newest-first; the first server-v* is latest.
        const latest = serverReleases[0]!
        const latestVersion = latest.tag_name.replace(/^server-v/, "")
        return {
          current,
          latest: latestVersion,
          tag: latest.tag_name,
          updateAvailable: compareSemver(latestVersion, current) > 0,
          notes: latest.body ?? null,
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`control.checkServerUpdate: ${msg}`)
        return {
          current,
          latest: null as string | null,
          tag: null as string | null,
          updateAvailable: false,
          notes: null as string | null,
          error: msg,
        }
      }
    }),

    /**
     * Trigger a server update to the given tag (defaults to the latest
     * server-v* release). Runs `scripts/luna-update-server --ref <tag>`
     * from the repo root in the background; the script handles readiness
     * probing and auto-rollback.
     *
     * Returns immediately; the update runs detached. Check `control.status`
     * afterwards to confirm the new version is live.
     */
    updateServer: t.procedure
      .input((val: unknown) => {
        if (val === undefined || val === null) return {}
        if (typeof val !== "object" || Array.isArray(val)) {
          throw new Error("input must be an object")
        }
        const tag = (val as Record<string, unknown>)["tag"]
        if (tag !== undefined && typeof tag !== "string") {
          throw new Error("tag must be a string")
        }
        return { tag: tag as string | undefined }
      })
      .mutation(async ({ input }) => {
        // Resolve the target tag: explicit input, or the latest release.
        let tag = input.tag
        if (tag === undefined) {
          try {
            const res = await fetch(
              "https://api.github.com/repos/fourcolors/luna/releases?per_page=20",
              {
                headers: {
                  Accept: "application/vnd.github+json",
                  "User-Agent": "luna-control-server",
                },
              },
            )
            if (!res.ok) throw new Error(`GitHub API returned ${res.status}`)
            const releases = (await res.json()) as Array<{
              tag_name: string
              draft: boolean
              prerelease: boolean
            }>
            const latest = releases.find(
              (r) =>
                r.tag_name.startsWith("server-v") &&
                !r.draft &&
                !r.prerelease,
            )
            if (!latest) throw new Error("no server-v* releases found")
            tag = latest.tag_name
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
              ok: false as const,
              message: `could not resolve latest server release: ${msg}`,
            }
          }
        }

        if (!/^server-v\d+\.\d+\.\d+$/.test(tag)) {
          return {
            ok: false as const,
            message: `refusing to update to malformed tag: ${tag}`,
          }
        }

        // Locate the updater script relative to the repo root.
        const repoRoot = join(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "..",
          "..",
        )
        const updater = join(repoRoot, "scripts", "luna-update-server")

        // Run detached so the tRPC response isn't blocked by the update.
        // The script logs to its own location; failures are visible via
        // systemctl/journal, not this response.
        const { spawn } = await import("node:child_process")
        const child = spawn(updater, ["--ref", tag], {
          detached: true,
          stdio: "ignore",
          cwd: repoRoot,
        })
        child.unref()

        return {
          ok: true as const,
          message: `server update to ${tag} started in background`,
          tag,
        }
      }),
  }),
  })

/**
 * Static router instance — preserves the existing `appRouter` import shape for
 * tests (`appRouter.createCaller`) and the fetch adapter. The default "unknown"
 * buildSha applies here; the live server uses `createAppRouter(buildSha)`.
 */
export const appRouter = createAppRouter()

export type AppRouter = typeof appRouter
