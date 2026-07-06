// luna-mini-apps.jsx — panel content components (each panel is a "mini MCP app")
import React, { useState, useEffect, useRef } from "react";

/* ---------- tomagotchi: pip ---------- */
const PIP_IDLE_MOODS = [
  "daydreaming…",
  "watching the paint dry",
  "humming quietly",
  "thinking about clouds",
];

function PipApp() {
  const [mood, setMood] = useState(PIP_IDLE_MOODS[0]);
  const [wiggle, setWiggle] = useState(false);
  const [hearts, setHearts] = useState([]);
  const idleTimer = useRef(null);

  function excite(text) {
    setMood(text);
    setWiggle(true);
    setTimeout(() => setWiggle(false), 650);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      setMood(PIP_IDLE_MOODS[Math.floor(Math.random() * PIP_IDLE_MOODS.length)]);
    }, 4000);
  }

  useEffect(() => {
    const onChirp = () => excite("listening…");
    const onBloom = () => excite("ooh, a new panel!");
    window.addEventListener("luna:chirp", onChirp);
    window.addEventListener("luna:bloom", onBloom);
    const idle = setInterval(() => {
      setMood((m) =>
        PIP_IDLE_MOODS.includes(m)
          ? PIP_IDLE_MOODS[Math.floor(Math.random() * PIP_IDLE_MOODS.length)]
          : m
      );
    }, 9000);
    return () => {
      window.removeEventListener("luna:chirp", onChirp);
      window.removeEventListener("luna:bloom", onBloom);
      clearInterval(idle);
      clearTimeout(idleTimer.current);
    };
  }, []);

  function pet(e) {
    const id = Date.now();
    const x = 30 + Math.random() * 40;
    setHearts((h) => [...h.slice(-4), { id, x }]);
    excite("!! pets !!");
  }

  return (
    <div className="pip-stage" onClick={pet} title="pet pip">
      <div className={"pip-blob" + (wiggle ? " wiggle" : "")}>
        <span className="pip-eye l"></span>
        <span className="pip-eye r"></span>
        <span className="pip-cheek l"></span>
        <span className="pip-cheek r"></span>
      </div>
      <div className="pip-mood">{mood}</div>
      {hearts.map((h) => (
        <span key={h.id} className="pip-heart" style={{ left: h.x + "%", top: "30%" }}>♥</span>
      ))}
    </div>
  );
}

/* ---------- agents ---------- */
function AgentsApp() {
  const [agents, setAgents] = useState([
    { id: 1, name: "inbox triage", desc: "sorting 14 new emails", status: "running" },
    { id: 2, name: "researcher", desc: "idle — last ran 2h ago", status: "idle" },
    { id: 3, name: "daily digest", desc: "scheduled for 5:00 pm", status: "scheduled" },
  ]);
  function toggle(id) {
    setAgents((as) =>
      as.map((a) =>
        a.id === id
          ? a.status === "running"
            ? { ...a, status: "idle", desc: "paused just now" }
            : { ...a, status: "running", desc: "warming up…" }
          : a
      )
    );
  }
  return (
    <div className="row-list">
      {agents.map((a) => (
        <div className="mini-row" key={a.id}>
          <span className={"status-dot " + a.status}></span>
          <div className="grow">
            <div className="name">{a.name}</div>
            <div className="desc">{a.desc}</div>
          </div>
          <button className="ghost-btn" onClick={() => toggle(a.id)}>
            {a.status === "running" ? "pause" : "run"}
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------- workflows ---------- */
function WorkflowsApp() {
  const [flows, setFlows] = useState([
    { id: 1, name: "morning digest", steps: 4, done: 4 },
    { id: 2, name: "inbox sweep", steps: 3, done: 0 },
    { id: 3, name: "weekly review", steps: 5, done: 2 },
  ]);
  const running = useRef(new Set());

  function run(id) {
    if (running.current.has(id)) return;
    running.current.add(id);
    setFlows((fs) => fs.map((f) => (f.id === id ? { ...f, done: 0 } : f)));
    const flow = flows.find((f) => f.id === id);
    for (let i = 1; i <= flow.steps; i++) {
      setTimeout(() => {
        setFlows((fs) => fs.map((f) => (f.id === id ? { ...f, done: i } : f)));
        if (i === flow.steps) running.current.delete(id);
      }, i * 550);
    }
  }

  return (
    <div className="row-list">
      {flows.map((f) => (
        <div className="mini-row" key={f.id}>
          <div className="grow">
            <div className="name">{f.name}</div>
            <div className="wf-steps">
              {Array.from({ length: f.steps }).map((_, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="wf-link"></span>}
                  <span className={"wf-step" + (i < f.done ? " done" : "")}></span>
                </React.Fragment>
              ))}
            </div>
          </div>
          <button className="ghost-btn" onClick={() => run(f.id)}>
            {f.done === f.steps ? "again" : "run"}
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------- settings ---------- */
const LUNA_PALETTES = {
  dawn: ["#e8a7b0", "#f2c29a", "#c9b6d9"],
  meadow: ["#b5c9a3", "#ecd9a0", "#aac9cf"],
  tide: ["#a9b8dc", "#93c2c4", "#d9b3bd"],
};

function SettingsApp({ t, setTweak }) {
  return (
    <div style={{ overflowY: "auto", minHeight: 0 }}>
      <div className="section-label">watercolor palette</div>
      <div className="swatch-row">
        {Object.entries(LUNA_PALETTES).map(([name, colors]) => (
          <button
            key={name}
            className={"swatch" + (t.palette === name ? " active" : "")}
            title={name}
            onClick={() => setTweak("palette", name)}
          >
            {colors.map((c) => (
              <span key={c} style={{ background: c }}></span>
            ))}
          </button>
        ))}
      </div>
      <div className="section-label">appearance</div>
      <div className="chip-row" style={{ padding: 0 }}>
        {["light", "dark"].map((m) => (
          <button
            key={m}
            className="chip"
            style={
              t.theme === m
                ? { borderColor: "var(--accent)", color: "var(--accent)", fontWeight: 600 }
                : {}
            }
            onClick={() => setTweak("theme", m)}
          >
            {m}
          </button>
        ))}
      </div>
      <div className="section-label">panel chrome</div>
      <div className="chip-row" style={{ padding: 0 }}>
        {["wash", "ink"].map((c) => (
          <button
            key={c}
            className="chip"
            style={
              t.chrome === c
                ? { borderColor: "var(--accent)", color: "var(--accent)", fontWeight: 600 }
                : {}
            }
            onClick={() => setTweak("chrome", c)}
          >
            {c === "wash" ? "soft wash" : "ink outline"}
          </button>
        ))}
      </div>
      <div className="section-label">model &amp; effort</div>
      <div className="chip-row" style={{ padding: 0 }}>
        {[["show", "show options"], ["luna", "luna decides"]].map(([v, label]) => (
          <button
            key={v}
            className="chip"
            style={
              (t.modelControls || "show") === v
                ? { borderColor: "var(--accent)", color: "var(--accent)", fontWeight: 600 }
                : {}
            }
            onClick={() => setTweak("modelControls", v)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="settings-note">
        {t.modelControls === "luna"
          ? "luna quietly picks the best model + effort per message."
          : "pickers show in chat — leave them on auto anytime."}
      </div>
      <div className="section-label">paper grain</div>
      <div className="chip-row" style={{ padding: 0 }}>
        <button className="chip" onClick={() => setTweak("grain", !t.grain)}>
          {t.grain ? "on — tap to smooth" : "off — tap for texture"}
        </button>
      </div>
    </div>
  );
}

/* ---------- focus timer ---------- */
function TimerApp() {
  const [secs, setSecs] = useState(25 * 60);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const iv = setInterval(() => setSecs((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(iv);
  }, [on]);
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return (
    <div className="timer-wrap">
      <div className="timer-time">{mm}:{ss}</div>
      <div className="timer-controls">
        <button className="ghost-btn" onClick={() => setOn(!on)}>{on ? "pause" : "start"}</button>
        <button className="ghost-btn" onClick={() => { setOn(false); setSecs(25 * 60); }}>reset</button>
      </div>
    </div>
  );
}

/* ---------- sticky note ---------- */
function StickyApp({ initial }) {
  const [text, setText] = useState(initial || "");
  return (
    <textarea
      className="sticky-area"
      placeholder="jot something…"
      value={text}
      onChange={(e) => setText(e.target.value)}
    ></textarea>
  );
}

/* ---------- weather ---------- */
function WeatherApp() {
  return (
    <div className="weather-wrap">
      <div className="weather-sun"></div>
      <div className="weather-temp">72°</div>
      <div className="weather-desc">painted skies, light breeze</div>
      <div className="weather-hours">
        {[["now", "72°"], ["2p", "74°"], ["4p", "73°"], ["6p", "68°"]].map(([h, v]) => (
          <div key={h}>{h}<b>{v}</b></div>
        ))}
      </div>
    </div>
  );
}

/* ---------- music ---------- */
function MusicApp() {
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(34);
  useEffect(() => {
    if (!playing) return;
    const iv = setInterval(() => setPos((p) => (p >= 100 ? 0 : p + 1)), 900);
    return () => clearInterval(iv);
  }, [playing]);
  return (
    <div className="music-wrap">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="play-btn" onClick={() => setPlaying(!playing)}>
          {playing ? "❚❚" : "▶"}
        </button>
        <div>
          <div className="music-title">Wet on Wet</div>
          <div className="music-artist">quiet studio mixes</div>
        </div>
      </div>
      <div className="music-bar"><i style={{ width: pos + "%" }}></i></div>
    </div>
  );
}

/* ---------- habit tracker ---------- */
function HabitApp() {
  const [habits, setHabits] = useState([
    { name: "morning pages", days: [1, 1, 0, 1, 0, 0, 0] },
    { name: "walk outside", days: [1, 0, 1, 1, 1, 0, 0] },
    { name: "no doomscroll", days: [0, 1, 1, 0, 0, 0, 0] },
  ]);
  function flip(hi, di) {
    setHabits((hs) =>
      hs.map((h, i) =>
        i === hi ? { ...h, days: h.days.map((d, j) => (j === di ? (d ? 0 : 1) : d)) } : h
      )
    );
  }
  return (
    <div className="row-list">
      {habits.map((h, hi) => (
        <div className="mini-row" key={h.name}>
          <div className="grow">
            <div className="name">{h.name}</div>
          </div>
          <div className="habit-dots">
            {h.days.map((d, di) => (
              <button
                key={di}
                className={"habit-dot" + (d ? " on" : "")}
                onClick={() => flip(hi, di)}
              ></button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- secure pass-through form ---------- */
function SecureApp({ request, kind, onSubmit, onCancel }) {
  const label = request || "your password";
  const isLogin = kind === "login";
  const [user, setUser] = useState("");
  const [val, setVal] = useState("");
  const [show, setShow] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
  const canSend = val.trim().length > 0 && (!isLogin || user.trim().length > 0);
  function submit(e) {
    if (e) e.preventDefault();
    if (!canSend) return;
    onSubmit({ label, len: val.length });
    setUser("");
    setVal("");
  }
  return (
    <form className="secure-wrap" onSubmit={submit} autoComplete="off">
      <div className="secure-shield">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 9.5C8 19.2 5 15.5 5 11V6z"></path></svg>
        encrypted · pass-through only
      </div>
      <div className="secure-prompt">luna needs {label}</div>
      {isLogin &&
        <label className="secure-field">
          <span className="secure-flabel">username</span>
          <div className="secure-inputrow">
            <input
              className="secure-input plain"
              type="text"
              value={user}
              autoComplete="off"
              spellCheck={false}
              placeholder="who you are…"
              onChange={(e) => setUser(e.target.value)} />
          </div>
        </label>
      }
      <label className="secure-field">
        <span className="secure-flabel">{isLogin ? "password" : label}</span>
        <div className="secure-inputrow">
          <input
            ref={inputRef}
            className="secure-input"
            type={show ? "text" : "password"}
            value={val}
            autoComplete="off"
            spellCheck={false}
            placeholder="••••••••"
            onChange={(e) => setVal(e.target.value)} />
          <button type="button" className="secure-eye" title={show ? "hide" : "show"} onClick={() => setShow((s) => !s)}>
            {show ?
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l18 18"></path><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"></path><path d="M9.4 5.2A9 9 0 0 1 21 12a9.3 9.3 0 0 1-2.4 3.2M6.3 6.3A9.3 9.3 0 0 0 3 12a9 9 0 0 0 9 6 8.8 8.8 0 0 0 2.4-.3"></path></svg> :
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>
            }
          </button>
        </div>
      </label>
      <div className="secure-assure">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>
        <span>handed straight to the task, then forgotten — never written to the chat or saved.</span>
      </div>
      <div className="secure-actions">
        <button type="button" className="ghost-btn" onClick={onCancel}>cancel</button>
        <button type="submit" className="secure-send" disabled={!canSend}>send securely ✦</button>
      </div>
    </form>
  );
}

/* ---------- blank generated panel ---------- */
function BlankApp({ request }) {
  return (
    <div className="blank-wrap">
      <div className="blank-stroke"></div>
      <div className="blank-stroke s2"></div>
      <div className="blank-note">
        luna sketched this panel for “{request}” — keep chatting and she’ll paint in the details.
      </div>
    </div>
  );
}

export {
  PipApp, AgentsApp, WorkflowsApp, SettingsApp,
  TimerApp, StickyApp, WeatherApp, MusicApp, HabitApp, BlankApp, SecureApp,
  LUNA_PALETTES,
};
