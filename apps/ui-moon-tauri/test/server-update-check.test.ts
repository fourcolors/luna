// @vitest-environment jsdom
//
// Unit tests for server-update-check.ts - the Updates panel's "Luna server"
// half. Moon cannot call the loopback-only control API remotely, so this
// module queries the public GitHub releases API itself and compares the
// newest server-v* release against the connected server's version (cached
// from the WS hello frame by server-version.ts).

import { beforeEach, describe, expect, it, vi } from "vitest"
import { checkServerUpdate } from "../frontend-react/src/panels/settings-updates/server-update-check"
import {
  getServerVersion,
  setServerVersionFromFrame,
} from "../frontend-react/src/panels/settings-updates/server-version"

function mockReleases(releases: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(releases),
    }),
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe("server-version cache", () => {
  it("stores and reads the hello frame's serverVersion", () => {
    setServerVersionFromFrame({ serverVersion: "0.5.0" })
    expect(getServerVersion()).toBe("0.5.0")
  })

  it("clears the cache when the frame has no serverVersion", () => {
    setServerVersionFromFrame({ serverVersion: "0.5.0" })
    setServerVersionFromFrame({})
    expect(getServerVersion()).toBeNull()
  })

  it("ignores non-string serverVersion values", () => {
    setServerVersionFromFrame({ serverVersion: 42 })
    expect(getServerVersion()).toBeNull()
  })
})

describe("checkServerUpdate", () => {
  it("returns null when no server version is cached", async () => {
    mockReleases([{ tag_name: "server-v0.6.0" }])
    expect(await checkServerUpdate()).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("finds a newer server release and builds the update command", async () => {
    setServerVersionFromFrame({ serverVersion: "0.5.0" })
    mockReleases([
      { tag_name: "server-v0.6.0", draft: false, prerelease: false, body: "New stuff" },
      { tag_name: "server-v0.5.0", draft: false, prerelease: false },
    ])
    const info = await checkServerUpdate()
    expect(info).not.toBeNull()
    expect(info!.current).toBe("0.5.0")
    expect(info!.latest).toBe("0.6.0")
    expect(info!.tag).toBe("server-v0.6.0")
    expect(info!.updateCommand).toBe("luna-update-server --ref server-v0.6.0")
    expect(info!.notes).toBe("New stuff")
  })

  it("returns null when the server is already current", async () => {
    setServerVersionFromFrame({ serverVersion: "0.6.0" })
    mockReleases([{ tag_name: "server-v0.6.0", draft: false, prerelease: false }])
    expect(await checkServerUpdate()).toBeNull()
  })

  it("returns null when the server is newer than any release", async () => {
    setServerVersionFromFrame({ serverVersion: "0.7.0" })
    mockReleases([{ tag_name: "server-v0.6.0", draft: false, prerelease: false }])
    expect(await checkServerUpdate()).toBeNull()
  })

  it("skips drafts, prereleases, and non-server tags", async () => {
    setServerVersionFromFrame({ serverVersion: "0.5.0" })
    mockReleases([
      { tag_name: "server-v0.9.0", draft: true, prerelease: false },
      { tag_name: "server-v0.8.0", draft: false, prerelease: true },
      { tag_name: "moon-v0.8.0", draft: false, prerelease: false },
      { tag_name: "server-v0.6.0", draft: false, prerelease: false },
    ])
    const info = await checkServerUpdate()
    expect(info!.latest).toBe("0.6.0")
  })

  it("picks the newest of several server releases", async () => {
    setServerVersionFromFrame({ serverVersion: "0.5.0" })
    mockReleases([
      { tag_name: "server-v0.6.0", draft: false, prerelease: false },
      { tag_name: "server-v0.6.1", draft: false, prerelease: false },
      { tag_name: "server-v0.10.0", draft: false, prerelease: false },
    ])
    const info = await checkServerUpdate()
    expect(info!.latest).toBe("0.10.0")
  })

  it("throws on GitHub API errors", async () => {
    setServerVersionFromFrame({ serverVersion: "0.5.0" })
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403 }),
    )
    await expect(checkServerUpdate()).rejects.toThrow()
  })
})
