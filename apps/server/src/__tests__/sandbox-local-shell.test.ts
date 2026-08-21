import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createLocalShellBridge } from "@luna/ui-ws"
import {
  attachSandboxLocalShell,
  executeSandboxLocalShellRequest,
  resolveSandboxLocalShell,
  sanitizeSandboxCommandEnv,
} from "../sandbox-local-shell.js"

describe("sandbox local shell", () => {
  const tmpDirs: string[] = []

  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "luna-sandbox-shell-"))
    tmpDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("requires explicit container scope, marker, and dangerous env opt-in", () => {
    const home = tempDir()
    const root = tempDir()
    const markerPath = join(home, ".luna", "allow-dangerous-local-shell")
    const markerExists = (path: string): boolean => path === markerPath

    expect(resolveSandboxLocalShell({
      env: {
        LUNA_PROFILE: "dev",
        LUNA_RUNTIME_SCOPE: "incus-container",
      },
      homeDir: home,
      cwd: root,
      sandboxRoot: root,
      markerExists,
    }).enabled).toBe(false)

    expect(resolveSandboxLocalShell({
      env: {
        LUNA_PROFILE: "dev",
        LUNA_RUNTIME_SCOPE: "host",
        LUNA_DEV_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL: "1",
      },
      homeDir: home,
      cwd: root,
      sandboxRoot: root,
      markerExists,
    }).enabled).toBe(false)

    expect(resolveSandboxLocalShell({
      env: {
        LUNA_PROFILE: "dev",
        LUNA_RUNTIME_SCOPE: "incus-container",
        LUNA_DEV_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL: "1",
      },
      homeDir: home,
      cwd: root,
      sandboxRoot: root,
      markerExists,
    })).toMatchObject({
      enabled: true,
      profileName: "dev",
      sandboxRoot: root,
    })
  })

  it("executes requests through a server-side sandbox binding", async () => {
    const root = tempDir()
    const bridge = createLocalShellBridge()
    attachSandboxLocalShell({
      bridge,
      threadId: "thr_1",
      cwd: root,
      sandboxRoot: root,
      env: { PATH: process.env.PATH },
      timeoutMs: 1_000,
    })

    await expect(bridge.request({
      threadId: "thr_1",
      command: "printf sandbox-ok",
      timeoutMs: 1_000,
    })).resolves.toMatchObject({
      approved: true,
      exitCode: 0,
      stdout: "sandbox-ok",
    })
  })

  it("denies request cwd outside the sandbox root", async () => {
    const root = tempDir()
    const outside = tempDir()

    await expect(executeSandboxLocalShellRequest({
      type: "local-shell-request",
      requestId: "req_1",
      threadId: "thr_1",
      command: "pwd",
      cwd: outside,
      timeoutMs: 1_000,
    }, {
      cwd: root,
      sandboxRoot: root,
      env: { PATH: process.env.PATH },
      timeoutMs: 1_000,
    })).resolves.toMatchObject({
      approved: false,
      stderr: "local shell cwd outside approved sandbox root",
    })
  })

  it("strips secrets from the command environment", () => {
    expect(sanitizeSandboxCommandEnv({
      PATH: "/bin",
      LUNA_UI_WS_TOKEN: "secret",
      API_KEY: "secret",
      NORMAL_VALUE: "ok",
    })).toEqual({
      PATH: "/bin",
      NORMAL_VALUE: "ok",
    })
  })
})
