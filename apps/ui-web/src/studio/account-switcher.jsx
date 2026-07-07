// account-switcher.jsx — React port of ui-shared-solid/AccountSwitcher.tsx.
//
// Selects the active Anthropic account for new requests. Renders only when
// at least one kind==="anthropic" account is known (nothing to pick before
// the server has sent its account list) — this mirrors the Solid original's
// early `return null`, ported as a guard clause instead of an early
// component return (React components must always return via JSX, but an
// empty render reads the same to the caller).
//
// The leading "— Auto —" option (value="") reverts to broker rotation (a
// null selectedId). Unhealthy accounts are shown but disabled so the user
// can see they exist without being able to select a dead account.
import React from "react";

export function AccountSwitcher({ accounts, selectedId, onSelect, disabled }) {
  const anthropicAccounts = (accounts || []).filter((a) => a.kind === "anthropic");
  if (anthropicAccounts.length === 0) return null;

  return (
    <select
      className="stg-field-input"
      value={selectedId ?? ""}
      disabled={disabled}
      onChange={(e) => {
        const val = e.target.value;
        onSelect(val === "" ? null : val);
      }}
      style={{ fontSize: "inherit" }}
    >
      <option value="">— Auto —</option>
      {anthropicAccounts.map((acct) => (
        <option key={acct.id} value={acct.id} disabled={acct.health !== "healthy"}>
          {acct.label}
          {acct.health !== "healthy" ? " (unavailable)" : ""}
        </option>
      ))}
    </select>
  );
}
