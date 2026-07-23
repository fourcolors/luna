// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useLunaData, RestartRefusedError } from "./useLunaData"

describe("useLunaData - restartServer", () => {
  let container: HTMLDivElement | null = null
  let root: ReturnType<typeof createRoot> | null = null

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) {
      const r = root
      act(() => r.unmount())
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container)
    }
    vi.restoreAllMocks()
  })

  it("throws explicit Error when restart HTTP status is non-ok (e.g. 500)", async () => {
    let restartFn: (() => Promise<void>) | null = null

    function TestComponent() {
      const data = useLunaData()
      restartFn = data.restartServer
      return null
    }

    act(() => {
      root!.render(React.createElement(TestComponent))
    })

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response)

    await expect(restartFn!()).rejects.toThrow("Server restart HTTP error: 500")
  })

  it("throws explicit Error when restart HTTP status is non-ok (e.g. 401)", async () => {
    let restartFn: (() => Promise<void>) | null = null

    function TestComponent() {
      const data = useLunaData()
      restartFn = data.restartServer
      return null
    }

    act(() => {
      root!.render(React.createElement(TestComponent))
    })

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as Response)

    await expect(restartFn!()).rejects.toThrow("Server restart HTTP error: 401")
  })

  it("throws RestartRefusedError when server returns ok response with refusal payload", async () => {
    let restartFn: (() => Promise<void>) | null = null

    function TestComponent() {
      const data = useLunaData()
      restartFn = data.restartServer
      return null
    }

    act(() => {
      root!.render(React.createElement(TestComponent))
    })

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          data: {
            json: {
              ok: false,
              message: "no supervisor process found",
            },
          },
        },
      }),
    } as Response)

    await expect(restartFn!()).rejects.toThrow(RestartRefusedError)
  })

  it("resolves when server returns ok: true response", async () => {
    let restartFn: (() => Promise<void>) | null = null

    function TestComponent() {
      const data = useLunaData()
      restartFn = data.restartServer
      return null
    }

    act(() => {
      root!.render(React.createElement(TestComponent))
    })

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          data: {
            json: {
              ok: true,
            },
          },
        },
      }),
    } as Response)

    await expect(restartFn!()).resolves.toBeUndefined()
  })
})
