/**
 * AccountSwitcher — Solid component for selecting the active Anthropic account.
 *
 * Always renders a <select> dropdown when at least one anthropic-kind account
 * is available. The leading "— Auto —" option (value="") lets the user revert
 * to broker rotation (null selectedAccountId). Unhealthy accounts are shown
 * as disabled options so the user can see they exist but cannot select them.
 */
import { type Component, For } from "solid-js"

export interface AccountSummary {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly health: string
}

export interface AccountSwitcherProps {
  readonly accounts: ReadonlyArray<AccountSummary>
  readonly selectedId: string | null
  readonly onSelect: (accountId: string | null) => void
  readonly disabled?: boolean
}

export const AccountSwitcher: Component<AccountSwitcherProps> = (props) => {
  const anthropicAccounts = () =>
    props.accounts.filter((a) => a.kind === "anthropic")

  // Don't render until we have account info from the server.
  if (anthropicAccounts().length === 0) return null

  return (
    <select
      value={props.selectedId ?? ""}
      disabled={props.disabled}
      onChange={(e) => {
        const val = e.currentTarget.value
        props.onSelect(val === "" ? null : val)
      }}
      style={{ "font-size": "inherit" }}
    >
      <option value="">— Auto —</option>
      <For each={anthropicAccounts()}>
        {(acct) => (
          <option
            value={acct.id}
            disabled={acct.health !== "healthy"}
          >
            {acct.label}
            {acct.health !== "healthy" ? " (unavailable)" : ""}
          </option>
        )}
      </For>
    </select>
  )
}
