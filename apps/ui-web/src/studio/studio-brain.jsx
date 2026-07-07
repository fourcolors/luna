// studio-brain.jsx — shared UI for "brains" (Luna / Hermes / OpenClaw)
import React from "react";
import { BRAINS, BRAIN_ORDER } from "./studio-data.jsx";

const BrReact = React;

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
export function BrainPicker({ value, onChange, includeAuto = true }) {
  const [open, setOpen] = BrReact.useState(false);
  const ref = BrReact.useRef(null);
  BrReact.useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open]);
  const cur = BRAINS[value] || BRAINS.luna;
  return (
    <div className="brain-pick" ref={ref}>
      <button
        className="brain-pick-btn"
        style={{ "--brain": "var(--brain-" + cur.key + ")" }}
        onClick={() => setOpen((o) => !o)}
        title="who should answer?"
      >
        <BrainIcon icon={cur.icon} />
        <span>{cur.name}</span>
        <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div className="brain-pick-menu">
          {BRAIN_ORDER.map((k) => {
            const b = BRAINS[k];
            return (
              <button
                key={k}
                className={"brain-opt" + (k === value ? " on" : "")}
                style={{ "--bo": "var(--brain-" + k + ")" }}
                onClick={() => { onChange(k); setOpen(false); }}
              >
                <span className="bo-ic"><BrainIcon icon={b.icon} /></span>
                <span style={{ flex: 1 }}>
                  <span className="bo-name">{b.name}</span>
                  <span className="bo-blurb">{b.blurb}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
