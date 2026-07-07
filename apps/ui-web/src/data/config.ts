/**
 * Persisted connection config — the single shared long-lived bearer token +
 * default model/effort, cached in localStorage['ui-ws.config']. Ported from
 * the Solid ui-web App.tsx (byte-compatible storage shape so an existing
 * config survives the framework swap). Tailnet is the auth perimeter; the
 * token IS the session — there is no login/cookie layer.
 */

/** Effort levels the composer may request. `ultracode` is a wire token that
 *  survives a reload; per-model validity is clamped later against the
 *  server-advertised matrix, this is only a sanity filter on raw storage. */
export type EffortOption = "low" | "medium" | "high" | "xhigh" | "max" | "ultracode"

export interface PersistedConfig {
  readonly url: string
  readonly token: string
  readonly model: string
  /** Persisted effort for new threads; absent on older configs. `| undefined`
   *  so a model switch can clear a now-invalid value in one assignment.
   *  JSON.stringify drops undefined keys, so localStorage never carries null. */
  readonly effort?: EffortOption | undefined
  /** When true, plain Enter sends; Shift+Enter newline. Default false. */
  readonly enterToSend: boolean
  /** Last-selected account id. null = default broker rotation. */
  readonly selectedAccountId: string | null
}

const STORAGE_KEY = "ui-ws.config"
const DEFAULT_URL = "ws://127.0.0.1:4753/ui"
const DEFAULT_MODEL = "claude-sonnet-5"

const VALID_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
])

export const loadConfig = (): PersistedConfig => {
  const envToken = (import.meta.env["VITE_UI_WS_TOKEN"] as string | undefined) ?? ""
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedConfig>
      const parsedEffort =
        typeof parsed.effort === "string" && VALID_EFFORTS.has(parsed.effort)
          ? (parsed.effort as EffortOption)
          : undefined
      return {
        url: parsed.url ?? DEFAULT_URL,
        token: parsed.token && parsed.token.length >= 16 ? parsed.token : envToken,
        model: parsed.model ?? DEFAULT_MODEL,
        ...(parsedEffort !== undefined ? { effort: parsedEffort } : {}),
        enterToSend: parsed.enterToSend ?? false,
        selectedAccountId: parsed.selectedAccountId ?? null,
      }
    }
  } catch {
    // ignore corrupt/unavailable storage
  }
  return {
    url: DEFAULT_URL,
    token: envToken,
    model: DEFAULT_MODEL,
    enterToSend: false,
    selectedAccountId: null,
  }
}

export const saveConfig = (cfg: PersistedConfig): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch {
    // ignore
  }
}
