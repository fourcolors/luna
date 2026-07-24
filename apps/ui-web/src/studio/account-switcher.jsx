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
//
// Astryx port: the native <select> becomes an Astryx Selector. Selector's
// non-clearable variant only accepts a string `value` (no null), so the
// null <-> "" mapping that used to live in the raw onChange handler now
// lives in both directions: "" represents Auto going in (value={selectedId
// ?? ""}) and coming out (onChange maps "" back to null before calling
// onSelect), preserving the exact null-means-auto contract callers rely on.
import React from "react";
import { Selector } from "./astryx-kit.tsx";

export function AccountSwitcher({ accounts, selectedId, onSelect, disabled }) {
  const anthropicAccounts = (accounts || []).filter((a) => a.kind === "anthropic");
  if (anthropicAccounts.length === 0) return null;

  const options = [
    { value: "", label: "— Auto —" },
    ...anthropicAccounts.map((acct) => ({
      value: acct.id,
      label: acct.health !== "healthy" ? `${acct.label} (unavailable)` : acct.label,
      disabled: acct.health !== "healthy",
    })),
  ];

  return (
    <Selector
      label="Account"
      isLabelHidden
      options={options}
      value={selectedId ?? ""}
      isDisabled={disabled}
      onChange={(val) => onSelect(val === "" ? null : val)}
    />
  );
}
