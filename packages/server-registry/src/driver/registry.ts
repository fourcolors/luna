// packages/server-registry/src/driver/registry.ts
import type { ServerUpdateDriver } from "./contract.js"
import type { RuntimeKind } from "../runtime/executor.js"
import { LunaChatServerDriver } from "./luna-chat-server.js"
import { OpenClawDriver } from "./openclaw.js"
import { HermesDriver } from "./hermes.js"

export type DriverKind = "luna-chat-server" | "openclaw" | "hermes"

export function loadDriver(kind: string, pinnedScriptPath?: string): ServerUpdateDriver {
  switch (kind) {
    case "luna-chat-server":
      return new LunaChatServerDriver(pinnedScriptPath ?? "/usr/local/lib/luna/luna-update-server")
    case "openclaw":
      return new OpenClawDriver()
    case "hermes":
      return new HermesDriver()
    default:
      throw new Error(
        `Unknown driver kind '${kind}'. Valid kinds: luna-chat-server, openclaw, hermes. (No dynamic import — closed registry.)`,
      )
  }
}

export function checkCapability(driver: ServerUpdateDriver, runtime: RuntimeKind): void {
  // All current RuntimeKind variants map to ShellExecutor. IpcExecutor is forward-looking.
  // If a driver requires "shell", all current runtimes support it → OK.
  // If a driver requires "ipc", no current runtime supports it → fail.
  if (driver.requires === "ipc") {
    throw new Error(
      `Driver '${driver.kind}' requires 'ipc' capability, but runtime '${runtime.target}' ` +
        `only provides 'shell'. No IpcExecutor exists for any current RuntimeKind.`,
    )
  }
  // driver.requires === "shell" — all current runtimes support shell
}
