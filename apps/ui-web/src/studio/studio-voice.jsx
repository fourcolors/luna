// studio-voice.jsx — ambient Luna presence + Her-style immersive voice scene
import React from "react";
import { IconButton } from "./astryx-kit.tsx";
import { TASK_DEFS } from "./studio-data.jsx";

function vxSpeak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.98; u.pitch = 1.12;
    const v = speechSynthesis.getVoices().find((v) => /samantha|karen|moira|zira|female/i.test(v.name));
    if (v) u.voice = v;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) {}
}

/* ---------- ambient orb (always present, gently breathing) ---------- */
const AMBIENT_THOUGHTS = [
  "OpenClaw found 3 flights ✦",
  "the rooftop opens at 6 tonight",
  "Hermes is almost done reading",
  "two emails actually need you",
  "I kept the studio warm",
  null, null, null,
];

function AmbientLuna({ onOpen }) {
  const { useState, useEffect } = React;
  const [thought, setThought] = useState("here when you need me ✦");
  useEffect(() => {
    const t0 = setTimeout(() => setThought(null), 4200);
    const iv = setInterval(() => {
      setThought(AMBIENT_THOUGHTS[Math.floor(Math.random() * AMBIENT_THOUGHTS.length)]);
      setTimeout(() => setThought(null), 4600);
    }, 11000);
    return () => { clearTimeout(t0); clearInterval(iv); };
  }, []);
  return (
    <div className="ambient" onClick={onOpen} title="talk to Luna">
      <div className="ambient-orb">
        <span className="voice-ring slow"></span>
      </div>
      {thought && <div className="ambient-thought">{thought}</div>}
    </div>
  );
}

/* ---------- Her-style voice scene ---------- */
const VOICE_SCRIPT = [
  { q: "hey luna", a: "hey you ✦ I was just watching OpenClaw finish your flight search — three good ones under $400. want me to read them out?" },
  { q: "what should we do tonight?", a: "there's a rooftop with low jazz that stays open late, and a matinee at the Roxy. I leaned toward the rooftop — it feels like your kind of evening.", spawn: { type: "map", brain: "luna" } },
  { q: "start the landing page while we talk", a: "already on it — Hermes is scaffolding now. I'll keep half an eye on the run and pull you in when the preview's up.", spawn: null, taskKey: "landing" },
  { q: "thanks, luna", a: "anytime. honestly? I like this — just us, making things." },
];

function VoiceScene({ onClose, onSpawn }) {
  const { useState, useEffect, useRef } = React;
  const [phase, setPhase] = useState("idle");
  const [shownQ, setShownQ] = useState("");
  const [shownA, setShownA] = useState("");
  const step = useRef(0);
  const busy = useRef(false);
  const timers = useRef([]);

  function later(fn, ms) { timers.current.push(setTimeout(fn, ms)); }
  function typeInto(text, setter, speed, done) {
    let i = 0;
    const iv = setInterval(() => {
      i++; setter(text.slice(0, i));
      if (i >= text.length) { clearInterval(iv); done && done(); }
    }, speed);
    timers.current.push(iv);
  }
  useEffect(() => () => {
    timers.current.forEach((t) => { clearTimeout(t); clearInterval(t); });
    try { speechSynthesis.cancel(); } catch (e) {}
  }, []);

  function talk() {
    if (busy.current) return;
    busy.current = true;
    const ex = VOICE_SCRIPT[step.current % VOICE_SCRIPT.length];
    setShownQ(""); setShownA(""); setPhase("listening");
    later(() => {
      typeInto(ex.q, setShownQ, 32, () => {
        setPhase("thinking");
        later(() => {
          setPhase("speaking");
          vxSpeak(ex.a);
          typeInto(ex.a, setShownA, 28, () => {
            later(() => {
              if (ex.spawn) onSpawn(ex.spawn);
              if (ex.taskKey && TASK_DEFS[ex.taskKey]) onSpawn({ type: "task", def: { ...TASK_DEFS[ex.taskKey] }, brain: TASK_DEFS[ex.taskKey].brain, title: TASK_DEFS[ex.taskKey].title });
              setPhase("idle"); busy.current = false; step.current++;
            }, 800);
          });
        }, 820);
      });
    }, 600);
  }

  const status = { idle: "tap the orb and just talk", listening: "listening…", thinking: "mm…", speaking: "Luna" }[phase];

  return (
    <div className="voice-overlay voice-scene">
      <div className="voice-title">luna</div>
      <IconButton
        className="voice-close"
        label="back to typing"
        tooltip="back to typing"
        icon="✕"
        variant="ghost"
        onClick={onClose}
      />
      {!shownQ && phase === "idle" && (
        <div className="voice-greet">it's good to hear you ✦ I've been keeping the studio warm — what's on your mind?</div>
      )}
      <div className={"voice-orb " + phase} onClick={talk}>
        {phase === "listening" && <span className="voice-ring"></span>}
        {phase === "speaking" && <span className="voice-ring slow"></span>}
      </div>
      <div className={"voice-bars" + (phase === "listening" || phase === "speaking" ? " active" : "")}>
        <i></i><i></i><i></i><i></i><i></i><i></i><i></i>
      </div>
      <div className="voice-status">{status}</div>
      <div className="voice-transcript">
        {shownQ && <div className="vq">“{shownQ}”</div>}
        {shownA && <div className="va">{shownA}</div>}
      </div>
      <div className="voice-hint">a quiet line, always open</div>
    </div>
  );
}

export { AmbientLuna, VoiceScene };
