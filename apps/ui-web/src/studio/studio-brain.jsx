// studio-brain.jsx — shared UI for "brains" (Luna / Hermes / OpenClaw)
import React from "react";
import { DropdownMenu, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "./astryx-kit.tsx";
import { BRAINS, BRAIN_ORDER } from "./studio-data.jsx";

// inline glyphs — Luna spark, Hermes wing, OpenClaw bracket-claw
export function BrainIcon({ icon }) {
  if (icon === "hermes") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12c5 0 7-2 9-7 1 5 3 7 9 7-6 0-8 2-9 7-2-5-4-7-9-7Z"></path>
      </svg>
    );
  }
  if (icon === "claw") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 4 4 12l4 8"></path>
        <path d="M16 4l4 8-4 8"></path>
        <path d="M12 9v6"></path>
      </svg>
    );
  }
  // luna spark (default)
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2c.5 4.2 1.8 5.5 6 6-4.2.5-5.5 1.8-6 6-.5-4.2-1.8-5.5-6-6 4.2-.5 5.5-1.8 6-6Z"></path>
    </svg>
  );
}

// little badge shown in a panel header / chat / task
export function BrainBadge({ brain, live, bare, showName = true }) {
  const b = BRAINS[brain] || BRAINS.luna;
  return (
    <span
      className={"brain-badge" + (live ? " live" : "") + (bare ? " bare" : "")}
      style={{ "--brain": "var(--brain-" + b.key + ")" }}
      title={b.name + " — " + b.blurb}
    >
      <BrainIcon icon={b.icon} />
      {showName && <span>{b.name}</span>}
    </span>
  );
}

// composer brain selector
// Was hand-rolled: local open state + a document "pointerdown" listener to
// detect outside clicks and close the menu. Astryx's DropdownMenu owns that
// dismiss logic (light-dismiss + Escape + focus return) internally, so the
// manual effect is gone - no more risk of the two systems fighting over
// focus/keyboard nav. Single-choice semantics are now real ARIA
// (role="menuitemradio" via DropdownMenuRadioGroup) instead of a bag of
// plain buttons with a hand-applied "on" class.
export function BrainPicker({ value, onChange, includeAuto = true }) {
  const cur = BRAINS[value] || BRAINS.luna;
  return (
    <DropdownMenu
      button={{
        label: cur.name,
        icon: <BrainIcon icon={cur.icon} />,
        variant: "secondary",
        size: "sm",
        style: { color: "var(--brain-" + cur.key + ")" },
        tooltip: "who should answer?",
      }}
      hasChevron
      data-testid="brain-picker"
    >
      <DropdownMenuRadioGroup value={value} onChange={onChange} aria-label="who should answer?">
        {BRAIN_ORDER.map((k) => {
          const b = BRAINS[k];
          return (
            <DropdownMenuRadioItem
              key={k}
              value={k}
              icon={<BrainIcon icon={b.icon} />}
              label={b.name}
              description={b.blurb}
              style={k === value ? { color: "var(--brain-" + k + ")" } : undefined}
            />
          );
        })}
      </DropdownMenuRadioGroup>
    </DropdownMenu>
  );
}
