/**
 * AccountSwitcher — Solid component for selecting the active Anthropic account.
 *
 * Renders a <select> dropdown only when two or more anthropic-kind accounts
 * are available (no choice to make with 0 or 1). Unhealthy accounts are shown
 * as disabled options so the user can see they exist but cannot select them.
 */
import { type Component, For, createMemo } from "solid-js"

export interface AccountSummary {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly health: string
}

export interface AccountSwitcherProps {
  readonly accounts: ReadonlyArray<AccountSummary>
  readonly selectedId: string | null
  readonly onSelect: (accountId: string) => void
  readonly disabled?: boolean
}

export const AccountSwitcher: Component<AccountSwitcherProps> = (props) => {
  const anthropicAccounts = createMemo(() =>
    props.accounts.filter((a) => a.kind === "anthropic"),
  )

  // Don't render if 0 or 1 accounts (no choice to make).
  const visible = createMemo(() => anthropicAccounts().length > 1)

  return (
    <>{visible() && (
      <select
        value={props.selectedId ?? ""}
        disabled={props.disabled}
        onChange={(e) => props.onSelect(e.currentTarget.value)}
        style={{ "font-size": "inherit" }}
      >
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
    )}</>
  )
}
