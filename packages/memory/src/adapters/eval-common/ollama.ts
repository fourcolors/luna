/**
 * Ollama preflight shared by the memory eval harnesses (locomo-eval,
 * longmemeval-eval).
 *
 * One resolved base URL feeds BOTH the embedder and the answer model, so the
 * two can never silently talk to different daemons. `probeModel` checks a
 * model is actually pulled (POST /api/show) - a reachable daemon without the
 * answer model used to produce an all-zero results file instead of a stop.
 */

const DEFAULT_PORT = "11434"

/**
 * Resolve the Ollama base URL from `LUNA_OLLAMA_BASE_URL`, then
 * `OLLAMA_HOST`, then the local default. `OLLAMA_HOST` follows Ollama's own
 * rules: it may be quoted, a bare `host` or `host:port` (port defaults to
 * 11434; an explicit scheme defaults to 80/443), a bare IPv6 address, and
 * is often the daemon's BIND address (`0.0.0.0` / `::`), dialed as loopback.
 * Empty values count as unset. Throws on a value no URL can be built from,
 * so the caller can report a config error instead of crashing.
 */
export function resolveOllamaBaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const pick = (key: string) => {
    const v = env[key]?.trim().replace(/^(["'])(.*)\1$/, "$2").trim()
    return v ? v : undefined
  }
  const raw = pick("LUNA_OLLAMA_BASE_URL") ?? pick("OLLAMA_HOST")
  if (raw === undefined) return `http://127.0.0.1:${DEFAULT_PORT}`
  const hasScheme = /^https?:\/\//i.test(raw)
  // A bare IPv6 address ("::1") has 2+ colons and no brackets.
  const hostPart = !hasScheme && !raw.startsWith("[") && (raw.match(/:/g)?.length ?? 0) > 1 ? `[${raw}]` : raw
  let url: URL
  try {
    url = new URL(hasScheme ? hostPart : `http://${hostPart}`)
  } catch {
    throw new Error(`cannot build an Ollama URL from "${raw}"`)
  }
  if (!hasScheme && url.port === "") url.port = DEFAULT_PORT
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "127.0.0.1"
  return url.toString().replace(/\/+$/, "")
}

export type ModelProbe =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** Is `model` pulled on the daemon at `baseUrl`? Never throws. */
export async function probeModel(baseUrl: string, model: string): Promise<ModelProbe> {
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) return { ok: true }
    if (res.status === 404) {
      return { ok: false, reason: `model "${model}" is not pulled (run: ollama pull ${model})` }
    }
    return { ok: false, reason: `/api/show for "${model}" returned HTTP ${res.status}` }
  } catch (cause) {
    return { ok: false, reason: `Ollama unreachable at ${baseUrl}: ${String(cause)}` }
  }
}

/** The daemon's version string, or "unknown". Never throws. */
export async function fetchOllamaVersion(baseUrl: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return "unknown"
    const json = (await res.json()) as { version?: unknown }
    return typeof json.version === "string" ? json.version : "unknown"
  } catch {
    return "unknown"
  }
}
