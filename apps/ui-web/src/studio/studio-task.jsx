// studio-task.jsx — live task runner. Progress is derived from elapsed time, so
// a task keeps advancing even while its workspace is off-screen.
import React from "react";

const TkReact = React;

const CURSOR_SPOTS = [
  { left: "76%", top: "30%" }, { left: "30%", top: "62%" },
  { left: "60%", top: "44%" }, { left: "44%", top: "28%" },
  { left: "70%", top: "66%" }, { left: "50%", top: "50%" },
];

function TaskRunner({ def, startedAt }) {
  const { useState, useEffect } = TkReact;
  const start = startedAt;
  const running = start != null;
  const [, force] = useState(0);
  const elapsed = running ? (Date.now() - start) / 1000 : 0;
  const done = running && elapsed >= def.dur;

  useEffect(() => {
    if (!running || done) { force((x) => x + 1); return; } // settle final frame
    const iv = setInterval(() => force((x) => x + 1), 450);
    return () => clearInterval(iv);
  }, [running, done]);

  let curIdx = 0;
  for (let i = 0; i < def.steps.length; i++) if (elapsed >= def.steps[i].at) curIdx = i;
  const cur = def.steps[curIdx];
  const pct = Math.min(100, Math.round((elapsed / def.dur) * 100));
  const brainVar = { "--brain": "var(--brain-" + def.brain + ")" };

  return (
    <div className="task-wrap" style={brainVar}>
      <div className="task-top">
        <span className="task-target">{def.target}</span>
        <span className={"task-live" + (done ? " done" : "")}>{done ? "complete" : "running"}</span>
      </div>

      {def.variant === "computer" ? (
        <div className="task-browser">
          <div className="task-urlbar">
            <span className="task-dots"><i></i><i></i><i></i></span>
            <span className="task-url">{done ? def.target : (cur.view || def.target)}</span>
          </div>
          <div className="task-viewport">
            <div className="task-vp-view">{done ? "all set ✦" : cur.view}</div>
            <div className="task-vp-act">{done ? "results passed to Luna" : cur.act}</div>
            {!done && (
              <span className="task-cursor" style={CURSOR_SPOTS[curIdx % CURSOR_SPOTS.length]}>
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l15 9-6 1.5L18 21l-3 1.4-4-7.4L5 18z"></path></svg>
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="task-term">
          {def.steps.slice(0, curIdx + 1).map((s, i) => (
            <div className="task-line" key={i}>
              {s.line}
              {i === curIdx && !done && <span className="task-caret">&nbsp;</span>}
            </div>
          ))}
          {done && <div className="task-line"><span className="tl-ok">✓ done</span> — {def.target}</div>}
        </div>
      )}

      <div className="task-steps">
        {def.steps.map((s, i) => {
          const state = i < curIdx || done ? "done" : i === curIdx ? "active" : "";
          return (
            <div key={i} className={"task-step " + state}>
              <span className="ts-dot">{(i < curIdx || done) ? "✓" : ""}</span>
              <span>{s.label}</span>
            </div>
          );
        })}
      </div>

      <div className="task-progress"><i style={{ width: pct + "%" }}></i></div>

      {done && (
        <div className="task-result">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
          <span>{def.result || "done ✦ — ready for you."}</span>
        </div>
      )}
    </div>
  );
}

export { TaskRunner };
