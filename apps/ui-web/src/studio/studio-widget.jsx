// studio-widget.jsx — GeneratedWidget: the real, interactive widget Luna
// "paints" when you describe one. spec = { kind, props }.
import React from "react";
import { Button, TextInput } from "./astryx-kit.tsx";

const GwReact = React;

function GeneratedWidget({ spec, fresh }) {
  const { useState, useEffect } = GwReact;
  const kind = (spec && spec.kind) || "stat";
  const p = (spec && spec.props) || {};
  const [painting, setPainting] = useState(!!fresh);
  useEffect(() => {
    if (!fresh) return;
    const tm = setTimeout(() => setPainting(false), 820);
    return () => clearTimeout(tm);
  }, [fresh]);

  return (
    <div className="gw-wrap">
      {painting && <div className="gw-painting"></div>}
      {kind === "counter" && <GwCounter {...p} />}
      {kind === "checklist" && <GwChecklist {...p} />}
      {kind === "countdown" && <GwCountdown {...p} />}
      {kind === "gauge" && <GwGauge {...p} />}
      {kind === "mood" && <GwMood {...p} />}
      {kind === "habit" && <GwHabit {...p} />}
      {kind === "stat" && <GwStat {...p} />}
    </div>
  );
}

function GwCounter({ label, unit = "today", goal = 8, value = 0 }) {
  const [n, setN] = GwReact.useState(value);
  const showDots = goal <= 16;
  return (
    <div className="gw-counter">
      <div className="gw-num">{n}<small>/ {goal} {unit}</small></div>
      {showDots ? (
        <div className="gw-goaldots">
          {Array.from({ length: goal }).map((_, i) => (
            <i key={i} className={i < n ? "on" : ""}></i>
          ))}
        </div>
      ) : (
        <div className="gw-goaltext">{Math.round((n / goal) * 100)}% of today's goal</div>
      )}
      <div className="gw-counter-ctrl">
        <Button
          className="gw-step"
          label="Decrease"
          variant="ghost"
          size="sm"
          isIconOnly
          icon={<span aria-hidden="true">–</span>}
          onClick={() => setN((x) => Math.max(0, x - 1))}
        />
        <Button
          className="gw-step"
          label="Increase"
          variant="ghost"
          size="sm"
          isIconOnly
          icon={<span aria-hidden="true">+</span>}
          onClick={() => setN((x) => x + 1)}
        />
      </div>
    </div>
  );
}

function GwChecklist({ label, items = [] }) {
  const [list, setList] = GwReact.useState(
    (items.length ? items : ["", "", ""]).filter(Boolean).map((t, i) => ({ id: i, t, done: false }))
  );
  const [draft, setDraft] = GwReact.useState("");
  const nextId = GwReact.useRef(list.length);
  function toggle(id) { setList((l) => l.map((x) => (x.id === id ? { ...x, done: !x.done } : x))); }
  function add() {
    const t = draft.trim();
    if (!t) return;
    setList((l) => [...l, { id: nextId.current++, t, done: false }]);
    setDraft("");
  }
  return (
    <>
      <div className="gw-checklist">
        {list.length === 0 && <div className="gw-goaltext" style={{ textAlign: "center", padding: 8 }}>empty — add your first item below ✦</div>}
        {list.map((x) => (
          <div key={x.id} className={"gw-check" + (x.done ? " on" : "")} onClick={() => toggle(x.id)}>
            <span className="box">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12l5 5L20 6"></path></svg>
            </span>
            <span className="lbl">{x.t}</span>
          </div>
        ))}
      </div>
      <div className="gw-additem">
        <TextInput
          label="Add an item"
          isLabelHidden
          placeholder="add an item…"
          value={draft}
          onChange={(v) => setDraft(v)}
          onEnter={add}
        />
        <Button label="Add item" variant="ghost" isIconOnly icon={<span aria-hidden="true">+</span>} onClick={add} />
      </div>
    </>
  );
}

function GwCountdown({ label = "The big day", days = 30 }) {
  const [target] = GwReact.useState(() => Date.now() + days * 86400000);
  const left = Math.max(0, Math.ceil((target - Date.now()) / 86400000));
  return (
    <div className="gw-countdown">
      <div className="gw-days">{left}</div>
      <div className="gw-days-lbl">days to go</div>
      <div className="gw-cd-name">{label}</div>
    </div>
  );
}

function GwGauge({ label = "Savings", value = 350, goal = 1000, unit = "$" }) {
  const [v, setV] = GwReact.useState(value);
  const pct = Math.min(100, Math.round((v / goal) * 100));
  const step = Math.max(1, Math.round(goal / 20));
  return (
    <div className="gw-gauge">
      <div className="gw-gauge-num">
        <b>{unit}{v.toLocaleString()}</b>
        <span>of {unit}{goal.toLocaleString()} · {pct}%</span>
      </div>
      <div className="gw-gauge-bar"><i style={{ width: pct + "%" }}></i></div>
      <div className="gw-gauge-ctrl">
        <Button className="ghost-btn" label={`Decrease by ${unit}${step}`} variant="ghost" onClick={() => setV((x) => Math.max(0, x - step))}>
          – {unit}{step}
        </Button>
        <Button className="ghost-btn" label={`Increase by ${unit}${step}`} variant="ghost" onClick={() => setV((x) => x + step)}>
          + {unit}{step}
        </Button>
      </div>
    </div>
  );
}

const GW_FACES = [
  { e: "😔", w: "low" },
  { e: "😐", w: "meh" },
  { e: "🙂", w: "okay" },
  { e: "😊", w: "good" },
  { e: "🤩", w: "great" },
];
function GwMood({ label = "How are you?" }) {
  const [sel, setSel] = GwReact.useState(null);
  return (
    <div className="gw-mood">
      <div className="gw-mood-q">{label}</div>
      <div className="gw-faces">
        {GW_FACES.map((f, i) => (
          <Button
            key={i}
            className={"gw-face" + (sel === i ? " on" : "")}
            label={f.w}
            tooltip={f.w}
            variant="ghost"
            isIconOnly
            icon={<span aria-hidden="true">{f.e}</span>}
            onClick={() => setSel(i)}
          />
        ))}
      </div>
      <div className="gw-mood-note">{sel == null ? "tap how today feels" : "logged — feeling " + GW_FACES[sel].w + " ✦"}</div>
    </div>
  );
}

function GwHabit({ label = "New habit" }) {
  const [days, setDays] = GwReact.useState([0, 0, 0, 0, 0, 0, 0]);
  const names = ["M", "T", "W", "T", "F", "S", "S"];
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 12 }}>
      <div className="gw-mood-q" style={{ fontSize: 20 }}>{label}</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        {days.map((d, i) => (
          <Button
            key={i}
            label={names[i] + (d ? " done" : " not done")}
            variant="ghost"
            onClick={() => setDays((ds) => ds.map((x, j) => (j === i ? (x ? 0 : 1) : x)))}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, color: "var(--ink-soft)", fontFamily: "inherit", fontSize: 11 }}
          >
            <span className={"habit-dot" + (d ? " on" : "")} style={{ width: 22, height: 22 }}></span>
            {names[i]}
          </Button>
        ))}
      </div>
      <div className="gw-goaltext" style={{ textAlign: "center" }}>{days.filter(Boolean).length} of 7 this week</div>
    </div>
  );
}

function GwStat({ label = "New widget", note = "" }) {
  return (
    <div className="gw-stat">
      <div className="gw-stat-strokes"><i></i><i></i><i></i></div>
      <div className="gw-stat-note">
        Luna sketched <b>{label}</b> from “{note}”. Keep chatting and she'll paint in the details — or tell her exactly what to track.
      </div>
    </div>
  );
}

export { GeneratedWidget };
