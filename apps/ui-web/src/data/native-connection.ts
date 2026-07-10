import type { PersistedConfig } from "./config"

export interface NativeLocalConnection {
  readonly url: string
  readonly token: string
}

type Invoke = (command: string) => Promise<unknown>

function tauriInvoke(): Invoke | null {
  const tauri = (globalThis as typeof globalThis & {
    __TAURI__?: { core?: { invoke?: Invoke } }
  }).__TAURI__
  return typeof tauri?.core?.invoke === "function" ? tauri.core.invoke : null
}

export function shouldHydrateNativeLocal(config: PersistedConfig): boolean {
  if (config.token.length >= 16) return false
  try {
    const url = new URL(config.url)
    return (
      (url.protocol === "ws:" || url.protocol === "wss:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
    )
  } catch {
    return false
  }
}

export async function loadNativeLocalConnection(
  invoke: Invoke | null = tauriInvoke(),
): Promise<NativeLocalConnection | null> {
  if (!invoke) return null
  try {
    const value = (await invoke("load_local_connection")) as Partial<NativeLocalConnection> | null
    if (
      !value ||
      typeof value.url !== "string" ||
      !/^wss?:\/\//.test(value.url) ||
      typeof value.token !== "string" ||
      value.token.length < 16
    ) {
      return null
    }
    return { url: value.url, token: value.token }
  } catch {
    return null
  }
}
