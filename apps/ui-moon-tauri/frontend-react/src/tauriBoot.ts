/**
 * tauriBoot.ts - bounded Tauri invoke + dial-credential helpers for Moon boot.
 *
 * Round-3 Mac evidence (signed com.luna.moon, Local Network on, jax-box
 * reachable, luna_ws_url still ws://jax-box:4753/ui, WebKit.Networking with
 * ZERO TCP/SYN): the UI can sit forever on HTML "Disconnected" + MoonBar
 * default "waking up…" when boot awaits migrate/load_connection/list_routes
 * and never reaches new WebSocket. An invoke that never settles matches that
 * paint exactly (updateStatus('connecting') only runs inside connect()).
 *
 * These helpers cap every boot-time invoke so dial can proceed with the
 * cached jax-box URL from localStorage / moon-connection instead of hanging
 * before the socket constructor. They do NOT retarget the endpoint to
 * localhost.
 */

/** Default ceiling for boot-path invokes. Short enough to unblock dial. */
export const BOOT_INVOKE_MS = 2_000

export type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

/**
 * Race a Tauri invoke against a timeout. On timeout the returned promise
 * rejects with an Error whose message starts with `boot-timeout:` so callers
 * can branch without treating it as a durable route refusal.
 */
export function invokeWithTimeout(
  invoke: TauriInvoke,
  cmd: string,
  args?: Record<string, unknown>,
  ms: number = BOOT_INVOKE_MS,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`boot-timeout: ${cmd} exceeded ${ms}ms`))
    }, ms)
  })
  return Promise.race([invoke(cmd, args), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * True when a token string is safe to put on the wire as a bearer (not the
 * "legacy" sentinel and not an unresolved env:/file:/op:// scheme ref).
 */
export function isUsableBearerToken(token: unknown): token is string {
  if (typeof token !== "string") return false
  if (token === "legacy") return false
  if (token.startsWith("env:") || token.startsWith("file:") || token.startsWith("op://")) {
    return false
  }
  return true
}

/**
 * Pick the WS URL to dial: prefer a non-empty loaded value, then the
 * localStorage cache (luna_ws_url), then the installer default. Never forces
 * 127.0.0.1 when a jax-box (or other) cache is present.
 */
export function pickBootWsUrl(
  loadedUrl: string | null | undefined,
  localStorageGet: (key: string) => string | null = (k) => {
    try {
      return globalThis.localStorage?.getItem(k) ?? null
    } catch {
      return null
    }
  },
  fallback: string = "ws://127.0.0.1:4753/ui",
): string {
  if (typeof loadedUrl === "string" && loadedUrl) return loadedUrl
  const cached = localStorageGet("luna_ws_url")
  if (typeof cached === "string" && cached) return cached
  return fallback
}
