/**
 * server-version.ts - captures the connected Luna server's release version
 * from the WebSocket hello frame (`frame.serverVersion`, a bare semver like
 * "0.5.0" resolved server-side from LUNA_BUILD_VERSION or the server-v* git
 * tag) and caches it in localStorage so the Updates panel can read it without
 * a live socket reference.
 *
 * Follows the existing `applyBuildSha` pattern (wire.ts / hubEngines.ts):
 * additive, degrades gracefully when the server predates the field.
 */

const STORAGE_KEY = "luna_server_version"

/** Read the last-seen server release version, or null if unknown. */
export function getServerVersion(): string | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

/**
 * Fold `frame.serverVersion` from a hello frame into the cache. Call from
 * the hello-frame handlers in wire.ts and hubEngines.ts next to their
 * applyBuildSha calls.
 */
export function setServerVersionFromFrame(frame: unknown): void {
  const v = (frame as { serverVersion?: unknown } | null)?.serverVersion
  try {
    if (typeof v === "string" && v.trim()) {
      localStorage.setItem(STORAGE_KEY, v.trim())
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    /* quota - cosmetic cache only */
  }
}
