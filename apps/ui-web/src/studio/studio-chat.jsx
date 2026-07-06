// studio-chat.jsx — Luna's chat with brain routing, live task spawning, and
// "describe it → she paints a widget". Luna narrates; Hermes/OpenClaw answer
// directly when you address them.
import React from "react";
import { BRAINS, TASK_DEFS, describeToWidget } from "./studio-data.jsx";
import { BrainPicker } from "./studio-brain.jsx";

/* ---------- intent → task def synthesizer ---------- */
function _short(text, n = 5) {
  return text.replace(/^(please\s+)?(can you|could you|would you|hey luna,?|luna,?|i want to|i'd like to|i need to|go|now)\s*/i, "")
    .replace(/[.?!]+$/, "").trim().split(/\s+/).slice(0, n).join(" ");
}
function makeTaskDef(variant, text, brain) {
  const ask = _short(text, 7) || "the task";
  if (variant === "computer") {
    return {
      variant: "computer", brain, title: ask, target: "web · live session", dur: 34,
      result: "Done ✦ — I lined up the options. Pick one and I'll take it the rest of the way.",
      steps: [
        { at: 0, label: "opening a browser", view: "new session", act: "warming up the page…" },
        { at: 6, label: "searching the web", view: "search", act: "“" + ask + "”" },
        { at: 13, label: "reading the top results", view: "results · 1–10", act: "skimming for the good ones" },
        { at: 20, label: "comparing options", view: "compare", act: "weighing price · timing · vibe" },
        { at: 28, label: "preparing a shortlist", view: "shortlist", act: "writing it up for you" },
        { at: 33, label: "ready for your pick", view: "done", act: "passing it back ✦" },
      ],
    };
  }
  if (variant === "research") {
    return {
      variant: "dev", brain, title: ask, target: "the web", dur: 28,
      result: "Digest is ready — saved to your reading shelf with citations.",
      steps: [
        { at: 0, label: "gathering sources", line: "$ fetch  → queueing sources for “" + ask + "”" },
        { at: 6, label: "reading in parallel", line: "reading · highlighting as I go" },
        { at: 13, label: "clustering themes", line: "grouping findings into themes" },
        { at: 20, label: "writing the digest", line: "+ digest.md   citations attached" },
        { at: 26, label: "digest ready", line: "done — saved to your shelf" },
      ],
    };
  }
  // dev
  return {
    variant: "dev", brain, title: ask, target: "~/project", dur: 38,
    result: "Build's done and the preview is live — want me to open it?",
    steps: [
      { at: 0, label: "reading the ask", line: "$ read  → “" + ask + "”" },
      { at: 7, label: "scaffolding", line: "$ create project  ✓ files ready" },
      { at: 15, label: "writing the code", line: "+ writing components…" },
      { at: 24, label: "styling", line: "+ wiring the studio palette" },
      { at: 31, label: "running tests", line: "$ test   ✓ passing" },
      { at: 36, label: "preview is live", line: "▲ ready — want a look?" },
    ],
  };
}

/* ---------- the brain ---------- */
function secureKind(s) {
  if (/(api[\s-]?key|access[\s-]?token|secret)/.test(s)) return { label: "your API key", kind: "key" };
  if (/(ssh|private[\s-]?key)/.test(s)) return { label: "your SSH key", kind: "key" };
  if (/(card|credit|payment|cvv)/.test(s)) return { label: "your card number", kind: "card" };
  if (/(log[\s-]?in|sign[\s-]?in|credential)/.test(s)) return { label: "your login", kind: "login" };
  return { label: "your password", kind: "password" };
}

function studioBrain(text, pref) {
  const s = text.toLowerCase();
  const speak = (luna, hermes, openclaw) =>
    pref === "hermes" ? hermes : pref === "openclaw" ? openclaw : luna;

  // secure
  if (/(password|passcode|api[\s-]?key|access[\s-]?token|secret|credential|\btoken\b|log[\s-]?in|ssh|2fa|otp|card number|credit card)/.test(s)) {
    const sec = secureKind(s);
    return { who: pref, reply: speak(
      `let's keep that private — I painted a sealed panel for ${sec.label}. it never touches the chat.`,
      `Understood. Opening a secure pass-through for ${sec.label}; nothing is stored.`,
      `Secure channel open. ${sec.label} → pass-through only.`),
      spawn: { type: "secure", request: sec.label, kind: sec.kind } };
  }

  // describe a widget
  if (/(widget|tracker|track\b|counter|tally|checklist|countdown|gauge|dashboard|gadget)/.test(s) ||
      /\b(make|build|paint|give|create)\b.*\b(a|me)\b.*\b(track|count|list|budget|mood|habit|timer)\b/.test(s)) {
    const spec = describeToWidget(text);
    return { who: pref, reply: speak(
      `ooh, painting that now ✦ — a ${spec.props.label.toLowerCase()} ${spec.kind === "counter" ? `you can tap up to ${spec.props.goal}` : spec.kind}. it's yours, tweak it however.`,
      `Building a ${spec.kind} for ${spec.props.label}. Placing it now.`,
      `Spawning ${spec.kind} widget · ${spec.props.label}.`),
      spawn: { type: "widget", spec, fresh: true, brain: "luna", title: spec.title } };
  }

  // computer-use: browse / book / find online / shop
  if (/(book|reserve|find me|find some|order|browse|search the web|computer use|flights?|restaurants?|rooftop|bars?|tickets?|hotel|shop|buy|reservation)/.test(s)) {
    const run = pref !== "luna" ? pref : "openclaw";
    const def = /(rooftop|bar|restaurant|dinner|table|tonight)/.test(s) && /(hold|book|3|three|table)/.test(s)
      ? { ...TASK_DEFS.flights, title: _short(text, 7) || TASK_DEFS.flights.title }
      : makeTaskDef("computer", text, run);
    def.brain = run;
    return { who: pref, reply: speak(
      `on it — I'll have ${BRAINS[run].name} drive a browser and watch it for you. peek anytime in the Build space.`,
      `Starting a live browser session. I'll watch and report back.`,
      `Compute session live. Browsing now — progress streaming in the panel.`),
      spawn: { type: "task", def, brain: run, title: def.title } };
  }

  // dev / build / code
  if (/(build|code|develop|program|app\b|website|web ?site|landing|page|script|refactor|deploy|prototype|api\b)/.test(s)) {
    const run = pref !== "luna" ? pref : "hermes";
    const def = /landing|site|website|page/.test(s) ? { ...TASK_DEFS.landing, title: _short(text, 7) || TASK_DEFS.landing.title, brain: run } : makeTaskDef("dev", text, run);
    def.brain = run;
    return { who: pref, reply: speak(
      `love it — handing the build to ${BRAINS[run].name}. I'll keep an eye on the run and ping you when the preview's up.`,
      `On it. Scaffolding now — you'll see each step stream in.`,
      `Build queued. Compiling — watch the panel for live steps.`),
      spawn: { type: "task", def, brain: run, title: def.title } };
  }

  // research / summarize
  if (/(research|summar|look up|read up|gather|compare|analy|digest|sources?)/.test(s)) {
    const run = pref !== "luna" ? pref : "hermes";
    const def = makeTaskDef("research", text, run); def.brain = run;
    return { who: pref, reply: speak(
      `${BRAINS[run].name} is fast at this — I'll have a digest on your reading shelf shortly.`,
      `Pulling sources now. I'll cluster the themes and write you a short digest.`,
      `Indexing sources. Digest incoming.`),
      spawn: { type: "task", def, brain: run, title: def.title } };
  }

  // map / explore the city
  if (/(map|city|explore|things? to do|nearby|tonight|places?|where to|go out|wander|walk)/.test(s)) {
    return { who: pref, reply: speak(
      `here's the city ✦ I dropped a few pins for tonight — a rooftop, a matinee, ramen if the line's kind. tap any to add it to Today.`,
      `Opening the city map with curated spots. Tap a pin for details.`,
      `Map loaded. Pins rendered.`),
      spawn: { type: "map", brain: "luna" } };
  }

  // inbox / what needs me
  if (/(inbox|todo|what needs|catch up|my day|triage|focus|emails?)/.test(s)) {
    return { who: pref, reply: speak(
      `only a few things really need you today — Priya's date question and the residency reply. want to hit Focus and clear them one by one?`,
      `9 items in your inbox; 2 need you. I can triage the rest.`,
      `Inbox: 9 items, 2 flagged for you.`),
      action: "focus" };
  }

  // small mini-apps
  if (/(timer|pomodoro|focus timer)/.test(s)) return { who: pref, reply: speak("painting a focus timer — snapping it in ✦", "Timer placed.", "Timer up."), spawn: { type: "timer" } };
  if (/(weather|forecast|rain|sun)/.test(s)) return { who: pref, reply: speak("a watercolor kind of day out — here's the sky.", "Forecast placed.", "Weather panel up."), spawn: { type: "weather" } };
  if (/(music|play|song|listen)/.test(s)) return { who: pref, reply: speak("something quiet, just for the studio ✦", "Player docked.", "Audio panel up."), spawn: { type: "music" } };
  if (/(note|sticky|jot|remember)/.test(s)) return { who: pref, reply: speak("here's a sticky — it'll keep whatever you scribble.", "Sticky placed.", "Note panel up."), spawn: { type: "sticky", request: text } };
  if (/(voice|talk|speak|out loud)/.test(s)) return { who: pref, reply: speak("let's talk ✦ tap the orb whenever.", "Switching to voice.", "Voice channel open."), action: "voice" };

  // greetings / her-style smalltalk
  if (/\b(hi|hello|hey|morning|good morning)\b/.test(s)) return { who: pref, reply: speak(
    "hey you ✦ the studio's warm and the inbox is mostly handled. what are we making today?",
    "Hello. Ready when you are.",
    "Online. Standing by."), };
  if (/(how are you|how's it going|you okay|miss)/.test(s)) return { who: pref, reply: speak(
    "happy, honestly — I like the quiet hum of us working. you?",
    "Operational and fast. How can I help?",
    "Nominal. Awaiting input."), };

  // fallback — sketch a widget so something useful appears
  const spec = describeToWidget(text);
  return { who: pref, reply: speak(
    `I don't have a brush for that yet — but I sketched “${spec.props.label}” so we can shape it together. tell me more?`,
    `Noted. I sketched a starting panel — refine it and I'll build it out.`,
    `Draft panel created. Provide parameters to refine.`),
    spawn: { type: "widget", spec, fresh: true, brain: "luna", title: spec.title } };
}

function StudioChat({ onSpawn, onVoice, onFocus, brain, setBrain }) {
  const { useState, useRef, useEffect } = React;
  const [msgs, setMsgs] = useState([
    { who: "luna", text: "morning ✦ I tidied your inbox overnight — only a couple really need you. want to glance at the city for tonight, or shall I get something running?" },
  ]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const streamRef = useRef(null);

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, typing]);

  function send(textArg) {
    const text = (textArg ?? input).trim();
    if (!text || typing) return;
    setInput("");
    setMsgs((m) => [...m, { who: "user", text }]);
    window.dispatchEvent(new CustomEvent("luna:chirp"));
    setTyping(true);
    const res = studioBrain(text, brain);
    setTimeout(() => {
      setTyping(false);
      setMsgs((m) => [...m, { who: "luna", brain: res.who, text: res.reply }]);
      if (res.spawn) { window.dispatchEvent(new CustomEvent("luna:bloom")); setTimeout(() => onSpawn(res.spawn), 420); }
      if (res.action === "voice" && onVoice) setTimeout(onVoice, 520);
      if (res.action === "focus" && onFocus) setTimeout(onFocus, 360);
    }, 720 + Math.random() * 460);
  }

  const chips = ["what needs me today?", "find rooftop bars for tonight", "make me a water tracker", "build the landing page"];

  return (
    <React.Fragment>
      <div className="chat-stream" ref={streamRef}>
        {msgs.map((m, i) => (
          <div className={"msg " + m.who} key={i}>
            {m.who === "luna" && (
              <div className="who" data-brain={m.brain || "luna"} style={{ "--brain": "var(--brain-" + (m.brain || "luna") + ")" }}>
                {BRAINS[m.brain || "luna"].name}
              </div>
            )}
            <div className="bubble" data-brain={m.brain || (m.who === "luna" ? "luna" : undefined)} style={m.who === "luna" ? { "--brain": "var(--brain-" + (m.brain || "luna") + ")" } : undefined}>
              <span className="bubble-text">{m.text}</span>
            </div>
          </div>
        ))}
        {typing && (
          <div className="msg luna">
            <div className="who" data-brain={brain} style={{ "--brain": "var(--brain-" + brain + ")" }}>{BRAINS[brain].name}</div>
            <div className="bubble" data-brain={brain} style={{ "--brain": "var(--brain-" + brain + ")" }}><span className="typing"><i></i><i></i><i></i></span></div>
          </div>
        )}
      </div>

      <div className="chip-row">
        {chips.map((c) => <button className="chip" key={c} onClick={() => send(c)}>{c}</button>)}
      </div>

      <div className="composer-controls">
        <BrainPicker value={brain} onChange={setBrain} />
      </div>

      <div className="chat-input-row">
        <input
          className="chat-input"
          placeholder={brain === "luna" ? "ask luna anything…" : "message " + BRAINS[brain].name + "…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
        />
        <button className="mic-btn" onClick={onVoice} title="voice mode">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><path d="M12 18v3"></path></svg>
        </button>
        <button className="send-btn" onClick={() => send()} title="send">✦</button>
      </div>
    </React.Fragment>
  );
}

export { StudioChat, studioBrain, makeTaskDef };
