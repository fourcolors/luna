/**
 * accountsReducer.ts - panel-local UI state for Settings Accounts.
 *
 * Shared domain state (`accounts` from account-list) lives in @luna/ui-shared.
 * This reducer owns only the add form, delete confirm, and requestId slots.
 * `secretRef` is a POINTER (`env:VAR`, `op://…`, …) — never a resolved secret —
 * wiped on submit and socket close.
 */

export type StatusKind = "ok" | "error" | "info"

export interface StatusLine {
  readonly text: string
  readonly kind: StatusKind
}

export interface AccountsPanelState {
  readonly idInput: string
  readonly labelInput: string
  readonly kindInput: string
  /** Secret-ref POINTER only — never a resolved credential. */
  readonly secretRefInput: string
  readonly statusLine: StatusLine | null
  readonly confirmId: string | null
  readonly reqId: string | null
  readonly reqKind: "add" | "rm" | null
}

export type AccountsPanelAction =
  | { readonly type: "id-changed"; readonly value: string }
  | { readonly type: "label-changed"; readonly value: string }
  | { readonly type: "kind-changed"; readonly value: string }
  | { readonly type: "secret-ref-changed"; readonly value: string }
  | { readonly type: "status-set"; readonly text: string; readonly kind: StatusKind }
  | { readonly type: "status-clear" }
  | { readonly type: "confirm-delete"; readonly id: string }
  | { readonly type: "confirm-clear" }
  | { readonly type: "submit-add-started"; readonly requestId: string }
  | { readonly type: "submit-rm-started"; readonly requestId: string }
  | {
      readonly type: "account-status-received"
      readonly frame: { readonly requestId?: unknown; readonly ok?: unknown; readonly message?: unknown }
    }
  | { readonly type: "socket-closed" }

export function initialAccountsPanelState(): AccountsPanelState {
  return {
    idInput: "",
    labelInput: "",
    kindInput: "anthropic",
    secretRefInput: "",
    statusLine: null,
    confirmId: null,
    reqId: null,
    reqKind: null,
  }
}

export function newReqId(): string {
  return `acct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function reduceAccountsPanel(
  state: AccountsPanelState,
  action: AccountsPanelAction,
): AccountsPanelState {
  switch (action.type) {
    case "id-changed":
      return { ...state, idInput: action.value }
    case "label-changed":
      return { ...state, labelInput: action.value }
    case "kind-changed":
      return { ...state, kindInput: action.value }
    case "secret-ref-changed":
      return { ...state, secretRefInput: action.value }
    case "status-set":
      return { ...state, statusLine: { text: action.text, kind: action.kind } }
    case "status-clear":
      return { ...state, statusLine: null }
    case "confirm-delete":
      return { ...state, confirmId: action.id }
    case "confirm-clear":
      return { ...state, confirmId: null }
    case "submit-add-started":
      return {
        ...state,
        reqId: action.requestId,
        reqKind: "add",
        statusLine: { text: "Adding…", kind: "info" },
        // Wipe pointer field on send so it cannot linger in the form.
        secretRefInput: "",
      }
    case "submit-rm-started":
      return {
        ...state,
        reqId: action.requestId,
        reqKind: "rm",
        confirmId: null,
        statusLine: { text: "Removing…", kind: "info" },
      }
    case "account-status-received": {
      const rid = typeof action.frame.requestId === "string" ? action.frame.requestId : ""
      if (!rid || rid !== state.reqId) return state
      const ok = action.frame.ok === true
      const message =
        typeof action.frame.message === "string" && action.frame.message.trim()
          ? action.frame.message.trim()
          : ok
            ? state.reqKind === "rm"
              ? "Removed."
              : "Added."
            : "Request failed."
      return {
        ...state,
        reqId: null,
        reqKind: null,
        statusLine: { text: message, kind: ok ? "ok" : "error" },
        ...(ok && state.reqKind === "add"
          ? { idInput: "", labelInput: "", kindInput: "anthropic" }
          : {}),
      }
    }
    case "socket-closed":
      return {
        ...state,
        secretRefInput: "",
        reqId: null,
        reqKind: null,
        confirmId: null,
        statusLine: { text: "Disconnected from server.", kind: "error" },
      }
    default:
      return state
  }
}

export const ACCOUNT_KIND_OPTIONS = [
  "anthropic",
  "google",
  "openai",
  "ollama-cloud",
  "ollama-local",
] as const

export function healthLabel(health: string): string {
  if (health === "rate_limited") return "rate limited"
  if (health === "spent") return "spent"
  if (health === "healthy") return "healthy"
  return health || "unknown"
}
