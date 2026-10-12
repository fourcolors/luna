/**
 * server-update-check.test.ts - regression tests for the update panel's
 * version comparison.
 *
 * Bug (found 2026-10-11): checkServerUpdate compared the raw
 * getServerVersion() string against release semvers with compareSemver.
 * When the wire version carried the release-tag prefix (e.g. "server-v0.6.0",
 * because resolveBuildVersion passes LUNA_BUILD_VERSION through verbatim),
 * compareSemver returned NaN, `NaN <= 0` evaluated false, and the panel
 * permanently reported "update available" for an up-to-date server.
 */
import { afterEach, describe, expect, it, vi } from "vitest"

import { checkServerUpdate } from "./server-update-check"

const STORAGE_KEY = "luna_server_version"

function mockReleases(tagNames: string[]) {
  const releases = tagNames.map((tag_name) => ({
    tag_name,
    draft: false,
    prerelease: false,
    body: null,
  }))
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => releases,
    })),
  )
}

function setServerVersion(v: string) {
  localStorage.setItem(STORAGE_KEY, v)
}

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe("checkServerUpdate", () => {
  it("reports no update when the prefixed wire version matches the latest release", async () => {
    // This is the reported bug: pre-fix this returned an update prompt.
    setServerVersion("server-v0.6.0")
    mockReleases(["server-v0.6.0", "server-v0.5.0"])
    await expect(checkServerUpdate()).resolves.toBeNull()
  })

  it("normalizes a prefixed version before reporting a real update", async () => {
    setServerVersion("server-v0.6.0")
    mockReleases(["server-v0.7.0", "server-v0.6.0"])
    const info = await checkServerUpdate()
    expect(info).not.toBeNull()
    expect(info!.current).toBe("0.6.0")
    expect(info!.latest).toBe("0.7.0")
    expect(info!.tag).toBe("server-v0.7.0")
  })

  it("accepts a bare 'v' prefix too", async () => {
    setServerVersion("v0.6.0")
    mockReleases(["server-v0.6.0"])
    await expect(checkServerUpdate()).resolves.toBeNull()
  })

  it("keeps working for a bare semver wire version", async () => {
    setServerVersion("0.6.0")
    mockReleases(["server-v0.7.0"])
    const info = await checkServerUpdate()
    expect(info).not.toBeNull()
    expect(info!.current).toBe("0.6.0")
    expect(info!.latest).toBe("0.7.0")
  })

  it("treats an unparseable version as unknown instead of a false update", async () => {
    setServerVersion("not-a-version")
    mockReleases(["server-v0.7.0"])
    await expect(checkServerUpdate()).resolves.toBeNull()
  })

  it("returns null when no version is known", async () => {
    mockReleases(["server-v0.7.0"])
    await expect(checkServerUpdate()).resolves.toBeNull()
  })

  it("returns null when there are no server releases", async () => {
    setServerVersion("server-v0.6.0")
    mockReleases([])
    await expect(checkServerUpdate()).resolves.toBeNull()
  })
})
