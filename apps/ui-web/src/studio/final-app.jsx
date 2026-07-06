// final-app.jsx — Luna Studio (final): Home space with inbox + threads,
// City and Build spaces, keyboard jumping, and threads woven through chat.
import React, { useState, useEffect, useRef, useCallback } from "react";
import { useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakColor, TweakToggle, TweakSelect, TweakSlider } from "./tweaks-panel.jsx";
import { LUNA_PALETTES, PipApp, TimerApp, WeatherApp, MusicApp, HabitApp, StickyApp, SecureApp } from "./luna-mini-apps.jsx";
import { TASK_DEFS, BRAINS } from "./studio-data.jsx";
import { BrainBadge } from "./studio-brain.jsx";
import { GeneratedWidget } from "./studio-widget.jsx";
import { TaskRunner } from "./studio-task.jsx";
import { MapApp } from "./studio-map.jsx";
import { makeTaskDef } from "./studio-chat.jsx";
import { AmbientLuna, VoiceScene } from "./studio-voice.jsx";
import { THREADS_SEED, ThreadsApp } from "./final-threads.jsx";
import { ThreadChat } from "./final-chat.jsx";
import { FinalInbox } from "./final-inbox.jsx";

const TWEAK_DEFAULTS = { theme: "light", palette: "tide", chrome: "wash", grain: false, motion: "lively", ambient: true, defaultBrain: "luna", snap: 28, guides: true };

const RAIL_W = 78;
const EDGE_MARGIN = 24;
const LEFT_EDGE = RAIL_W + EDGE_MARGIN;
const SNAP_GAP = 16;
const TOP_MIN = 64;
const HEAD_H = 40;

/* ---------------- workspaces ---------------- */
const WS_ICONS = {
  home: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11.5 12 4l9 7.5"></path><path d="M5.5 10v9.5h13V10"></path><path d="M10 19.5v-5h4v5"></path></svg>,
  city: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 20 3 22V8l6-2 6 2 6-2v14l-6 2-6-2Z"></path><path d="M9 6v14M15 8v14"></path></svg>,
  build: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 8-4 4 4 4M17 8l4 4-4 4M14 4l-4 16"></path></svg>,
  blank: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"></rect></svg>,
};
const WORKSPACES_SEED = [
  { id: "home", name: "Home", icon: "home", tint: "var(--wash-2)" },
  { id: "city", name: "The City", icon: "city", tint: "var(--wash-0)" },
  { id: "build", name: "Build", icon: "build", tint: "var(--wash-4)" },
];

function shortName(text, n = 4) {
  return text.replace(/[.?!]+$/, "").trim().toLowerCase().split(/\s+/).slice(0, n).join(" ");
}

/* ---------------- initial panels (all workspaces) ---------------- */
function buildPanels(vw, vh) {
  vw = Math.max(480, vw || 0);
  vh = Math.max(360, vh || 0);
  const colH = Math.max(260, vh - TOP_MIN - EDGE_MARGIN);
  const x0 = LEFT_EDGE;
  let z = 1;
  const P = [];
  const push = (o) => { P.push({ z: z++, ...o }); };

  /* --- Home: threads + pip (left), chat (center), inbox (right) --- */
  const leftW = 254;
  const inboxW = Math.min(364, vw * 0.27);
  const inboxX = vw - inboxW - EDGE_MARGIN;
  const chatX = x0 + leftW + SNAP_GAP;
  const chatW = Math.max(280, inboxX - SNAP_GAP - chatX);
  const thH = Math.max(220, Math.round((colH - SNAP_GAP) * 0.62));
  push({ id: "h-threads", ws: "home", type: "threads", brain: "luna", x: x0, y: TOP_MIN, w: leftW, h: thH });
  push({ id: "h-pip", ws: "home", type: "pip", x: x0, y: TOP_MIN + thH + SNAP_GAP, w: leftW, h: colH - thH - SNAP_GAP });
  push({ id: "h-chat", ws: "home", type: "chat", brain: "luna", x: chatX, y: TOP_MIN, w: chatW, h: colH });
  push({ id: "h-inbox", ws: "home", type: "inbox", brain: "luna", x: inboxX, y: TOP_MIN, w: inboxW, h: colH });

  /* --- The City --- */
  const cChatW = Math.min(338, vw * 0.25);
  const cChatX = vw - cChatW - EDGE_MARGIN;
  const mapW = Math.max(420, cChatX - SNAP_GAP - x0);
  const weatherH = Math.max(120, Math.min(220, Math.round(colH * 0.34)));
  const cChatH = colH - weatherH - SNAP_GAP;
  push({ id: "c-map", ws: "city", type: "map", brain: "luna", x: x0, y: TOP_MIN, w: mapW, h: colH });
  push({ id: "c-chat", ws: "city", type: "chat", brain: "luna", x: cChatX, y: TOP_MIN, w: cChatW, h: cChatH });
  push({ id: "c-weather", ws: "city", type: "weather", x: cChatX, y: TOP_MIN + cChatH + SNAP_GAP, w: cChatW, h: weatherH });

  /* --- Build (two harnesses + chat, runs start when you first visit) --- */
  const bChatW = Math.min(300, vw * 0.22);
  const bChatX = vw - bChatW - EDGE_MARGIN;
  const taskArea = bChatX - SNAP_GAP - x0;
  const taskW = Math.floor((taskArea - SNAP_GAP) / 2);
  push({ id: "b-claw", ws: "build", type: "task", brain: "openclaw", title: TASK_DEFS.flights.title, def: TASK_DEFS.flights, startedAt: null, x: x0, y: TOP_MIN, w: taskW, h: colH });
  push({ id: "b-herm", ws: "build", type: "task", brain: "hermes", title: TASK_DEFS.landing.title, def: TASK_DEFS.landing, startedAt: null, x: x0 + taskW + SNAP_GAP, y: TOP_MIN, w: taskW, h: colH });
  push({ id: "b-chat", ws: "build", type: "chat", brain: "luna", x: bChatX, y: TOP_MIN, w: bChatW, h: colH });

  return P;
}

const DEFS = {
  chat:    { title: "luna", render: (ctx) => <ThreadChat threads={ctx.threads} activeId={ctx.activeThread} onSwitch={ctx.openThread} onNew={ctx.newThread} onAppend={ctx.appendMsg} onThreadNote={ctx.threadNote} onSpawn={ctx.spawn} onVoice={ctx.openVoice} onFocus={ctx.focusInbox} brain={ctx.chatBrain} setBrain={ctx.setChatBrain} /> },
  threads: { title: "threads", render: (ctx) => <ThreadsApp threads={ctx.threads} activeId={ctx.activeThread} onOpen={ctx.openThread} /> },
  inbox:   { title: "inbox", render: (ctx) => <FinalInbox onDelegate={ctx.delegate} onToast={ctx.toast} onOpenThread={ctx.openThread} /> },
  map:     { title: "the city", render: (ctx) => <MapApp onToast={ctx.toast} /> },
  task:    { title: "task", render: (ctx, p) => <TaskRunner def={p.def} startedAt={p.startedAt} /> },
  widget:  { title: "widget", render: (ctx, p) => <GeneratedWidget spec={p.spec} fresh={p.fresh} /> },
  pip:     { title: "pip", render: () => <PipApp /> },
  timer:   { title: "focus timer", w: 240, h: 200, render: () => <TimerApp /> },
  weather: { title: "weather", w: 260, h: 250, render: () => <WeatherApp /> },
  music:   { title: "music", w: 280, h: 170, render: () => <MusicApp /> },
  habit:   { title: "habits", w: 300, h: 230, render: () => <HabitApp /> },
  sticky:  { title: "sticky note", w: 250, h: 220, render: (ctx, p) => <StickyApp initial={p.request} /> },
  secure:  { title: "secure", w: 300, h: 290, render: (ctx, p) => <SecureApp request={p.request} kind={p.kind} onSubmit={(pl) => ctx.submitSecure(p.id, pl)} onCancel={() => ctx.close(p.id)} /> },
};
const DEFAULT_SIZE = { task: { w: 304, h: 330 }, widget: { w: 262, h: 244 }, map: { w: 440, h: 360 }, inbox: { w: 340, h: 420 }, chat: { w: 420, h: 460 }, threads: { w: 260, h: 380 } };

function snapAxis(raw, candidates, thresh) {
  let best = null;
  for (const c of candidates) {
    const d = Math.abs(raw - c.pos);
    if (d <= thresh && (!best || d < best.d)) best = { ...c, d };
  }
  return best;
}

export function StudioApp() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [workspaces, setWorkspaces] = useState(WORKSPACES_SEED);
  const [ws, setWs] = useState("home");
  const [panels, setPanels] = useState(() => buildPanels(window.innerWidth, window.innerHeight));
  const [threads, setThreads] = useState(THREADS_SEED);
  const [activeThread, setActiveThread] = useState("morning");
  const [guides, setGuides] = useState([]);
  const [snappedId, setSnappedId] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [chatBrain, setChatBrain] = useState(TWEAK_DEFAULTS.defaultBrain || "luna");
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [switching, setSwitching] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [ready, setReady] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(false);

  const panelsRef = useRef(panels); panelsRef.current = panels;
  const zTop = useRef(60);
  const dragRef = useRef(null);
  const toastTimer = useRef(null);
  const wsCount = useRef(0);

  /* live tick — only while a task is running (anywhere) */
  const anyRunning = panels.some((p) => p.type === "task" && !p.closed && p.startedAt != null && (now - p.startedAt) / 1000 < p.def.dur);
  useEffect(() => {
    if (!anyRunning) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [anyRunning]);

  /* reflow seed layout while the iframe's box settles (see studio-app notes) */
  useEffect(() => {
    let revealT;
    function reflow() {
      const vw = window.innerWidth, vh = window.innerHeight;
      setPanels((prev) => {
        const seed = buildPanels(vw, vh);
        const byId = {};
        seed.forEach((s) => { byId[s.id] = s; });
        return prev.map((p) => {
          if (p.userMoved || !byId[p.id]) return p;
          const s = byId[p.id];
          if (p.x === s.x && p.y === s.y && p.w === s.w && p.h === s.h) return p;
          return { ...p, x: s.x, y: s.y, w: s.w, h: s.h };
        });
      });
      clearTimeout(revealT);
      revealT = setTimeout(() => setReady(true), 140);
    }
    let ro;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => reflow());
      ro.observe(document.documentElement);
    }
    const timers = [0, 120, 360, 700].map((ms) => setTimeout(reflow, ms));
    const hardReveal = setTimeout(() => setReady(true), 1200);
    window.addEventListener("resize", reflow);
    return () => {
      if (ro) ro.disconnect();
      timers.forEach(clearTimeout);
      clearTimeout(revealT); clearTimeout(hardReveal);
      window.removeEventListener("resize", reflow);
    };
  }, []);

  function showToast(msg, brain) {
    setToast({ msg, brain: brain || "luna" });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }
  function focusInbox() {
    if (ws !== "home") switchWs("home");
    setTimeout(() => window.dispatchEvent(new CustomEvent("studio:focus")), ws !== "home" ? 420 : 0);
  }

  function switchWs(id) {
    if (id === ws) return;
    setPanels((ps) => ps.map((p) => (p.ws === id && p.type === "task" && p.startedAt == null ? { ...p, startedAt: Date.now() } : p)));
    setWs(id);
    setSwitching(true);
    setTimeout(() => setSwitching(false), 540);
  }
  const switchWsRef = useRef(switchWs); switchWsRef.current = switchWs;

  /* keyboard: 1–9 jumps between spaces */
  const kbRef = useRef({ workspaces, ws }); kbRef.current = { workspaces, ws };
  useEffect(() => {
    function onKey(e) {
      const tag = (e.target && e.target.tagName) || "";
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= kbRef.current.workspaces.length) {
        const id = kbRef.current.workspaces[n - 1].id;
        if (id !== kbRef.current.ws) switchWsRef.current(id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function addWorkspace() {
    wsCount.current += 1;
    const n = wsCount.current;
    const id = "ws" + n;
    const tints = ["var(--wash-1)", "var(--wash-3)", "var(--wash-0)", "var(--wash-4)"];
    setWorkspaces((w) => [...w, { id, name: "Space " + n, icon: "blank", tint: tints[n % tints.length] }]);
    const vw = window.innerWidth, vh = window.innerHeight;
    const colH = Math.max(260, vh - TOP_MIN - EDGE_MARGIN);
    setPanels((ps) => [...ps, { id: id + "-chat", ws: id, type: "chat", brain: "luna", x: Math.round(vw / 2 - 230), y: TOP_MIN, w: 460, h: colH, z: zTop.current++ }]);
    switchWs(id);
    showToast("new space ✦ ask Luna to fill it", "luna");
  }

  const bringToFront = useCallback((id) => {
    zTop.current += 1;
    setPanels((ps) => ps.map((p) => (p.id === id ? { ...p, z: zTop.current } : p)));
  }, []);

  /* ---------- threads ---------- */
  function appendMsg(id, msg) {
    setThreads((ts) => ts.map((th) => (th.id === id
      ? { ...th, msgs: [...th.msgs, msg], status: th.status === "quiet" || th.status === "done" ? "active" : th.status }
      : th)));
  }
  function threadNote(id, patch) {
    setThreads((ts) => ts.map((th) => (th.id === id ? { ...th, ...patch } : th)));
  }
  function openThread(id) {
    setThreads((ts) => ts.map((th) => (th.id === id ? { ...th, unread: 0, status: th.status === "needs" ? "active" : th.status } : th)));
    setActiveThread(id);
    const chat = panelsRef.current.find((p) => p.type === "chat" && p.ws === ws && !p.closed)
      || panelsRef.current.find((p) => p.type === "chat" && p.ws === "home");
    if (chat) {
      if (chat.ws !== ws) switchWs(chat.ws);
      bringToFront(chat.id);
    }
  }
  function newThread() {
    const id = "th" + Date.now();
    const tints = ["var(--wash-1)", "var(--wash-3)", "var(--wash-0)", "var(--wash-4)", "var(--wash-2)"];
    const tint = tints[threads.length % tints.length];
    setThreads((ts) => [{ id, name: "new thread", tint, brain: "luna", status: "active", note: "a fresh page", msgs: [
      { who: "luna", text: "fresh page ✦ what's this one about?" },
    ] }, ...ts]);
    setActiveThread(id);
  }

  /* listen for thread-opens from other panels (inbox) */
  const openThreadRef = useRef(openThread); openThreadRef.current = openThread;
  useEffect(() => {
    function h(e) { if (e.detail && e.detail.id) openThreadRef.current(e.detail.id); }
    window.addEventListener("studio:openThread", h);
    return () => window.removeEventListener("studio:openThread", h);
  }, []);

  /* ---------- magnetic snap ---------- */
  function computeSnap(id, rx, ry, w, h, wsId) {
    const thresh = t.snap;
    const vw = window.innerWidth, vh = window.innerHeight;
    const candX = [{ pos: LEFT_EDGE, line: LEFT_EDGE }, { pos: vw - w - EDGE_MARGIN, line: vw - EDGE_MARGIN }];
    const candY = [{ pos: TOP_MIN, line: TOP_MIN }, { pos: vh - h - EDGE_MARGIN, line: vh - EDGE_MARGIN }];
    for (const p of panelsRef.current) {
      if (p.id === id || p.closed || p.ws !== wsId) continue;
      const ph = p.min ? HEAD_H : p.h;
      candX.push({ pos: p.x, line: p.x }, { pos: p.x + p.w - w, line: p.x + p.w }, { pos: p.x + p.w + SNAP_GAP, line: p.x + p.w + SNAP_GAP / 2 }, { pos: p.x - w - SNAP_GAP, line: p.x - SNAP_GAP / 2 });
      candY.push({ pos: p.y, line: p.y }, { pos: p.y + ph - h, line: p.y + ph }, { pos: p.y + ph + SNAP_GAP, line: p.y + ph + SNAP_GAP / 2 }, { pos: p.y - h - SNAP_GAP, line: p.y - SNAP_GAP / 2 });
    }
    const sx = thresh > 0 ? snapAxis(rx, candX, thresh) : null;
    const sy = thresh > 0 ? snapAxis(ry, candY, thresh) : null;
    const g = [];
    if (sx && t.guides) g.push({ type: "v", at: sx.line });
    if (sy && t.guides) g.push({ type: "h", at: sy.line });
    return { x: sx ? sx.pos : rx, y: sy ? sy.pos : ry, guides: g, snapped: !!(sx || sy) };
  }

  function startDrag(e, id, mode) {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = panelsRef.current.find((q) => q.id === id);
    dragRef.current = { id, mode, startX: e.clientX, startY: e.clientY, ox: p.x, oy: p.y, ow: p.w, oh: p.h, ws: p.ws };
    bringToFront(id);
    setDragId(id);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }
  function onPointerMove(e) {
    const d = dragRef.current; if (!d) return;
    if (!d.moved) {
      d.moved = true;
      setPanels((ps) => ps.map((p) => (p.id === d.id ? { ...p, userMoved: true } : p)));
    }
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (d.mode === "move") {
      const p = panelsRef.current.find((q) => q.id === d.id);
      const res = computeSnap(d.id, d.ox + dx, d.oy + dy, p.w, p.min ? HEAD_H : p.h, d.ws);
      setGuides(res.guides);
      setSnappedId(res.snapped ? d.id : null);
      setPanels((ps) => ps.map((q) => (q.id === d.id ? { ...q, x: res.x, y: res.y } : q)));
    } else {
      const w = Math.max(200, d.ow + dx), h = Math.max(140, d.oh + dy);
      setPanels((ps) => ps.map((q) => (q.id === d.id ? { ...q, w, h } : q)));
    }
  }
  function onPointerUp() {
    dragRef.current = null;
    setDragId(null);
    setGuides([]);
    setTimeout(() => setSnappedId(null), 240);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }

  /* ---------- spawn / close / restore / tidy ---------- */
  const spawnN = useRef(0);
  function spawn(req) {
    const def = DEFS[req.type]; if (!def) return;
    const n = spawnN.current++;
    const vw = window.innerWidth;
    const sz = DEFAULT_SIZE[req.type] || { w: def.w || 264, h: def.h || 230 };
    const w = req.w || sz.w, h = req.h || sz.h;
    const id = req.type + "-" + Date.now();
    const rawX = Math.min(vw - w - EDGE_MARGIN, vw * 0.4 + (n % 4) * 30);
    const rawY = TOP_MIN + 36 + (n % 5) * 34;
    const pos = computeSnap(id, rawX, rawY, w, h, ws);
    zTop.current += 1;
    setPanels((ps) => [...ps, {
      id, ws, type: req.type, brain: req.brain, title: req.title,
      def: req.def, startedAt: req.def ? Date.now() : undefined,
      spec: req.spec, fresh: req.fresh, request: req.request, kind: req.kind,
      x: pos.x, y: pos.y, w, h, z: zTop.current, entering: true,
    }]);
    setTimeout(() => setPanels((ps) => ps.map((p) => (p.id === id ? { ...p, entering: false, fresh: false } : p))), 760);
  }
  function close(id) { setPanels((ps) => ps.map((p) => (p.id === id ? { ...p, closed: true } : p))); }
  function toggleMin(id) { setPanels((ps) => ps.map((p) => (p.id === id ? { ...p, min: !p.min } : p))); }
  function restore(id) {
    zTop.current += 1;
    setPanels((ps) => ps.map((p) => (p.id === id ? { ...p, closed: false, entering: true, z: zTop.current } : p)));
    setTimeout(() => setPanels((ps) => ps.map((p) => (p.id === id ? { ...p, entering: false } : p))), 760);
  }
  function tidy() {
    setPanels((ps) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const cols = Math.max(2, Math.min(4, Math.round((vw - LEFT_EDGE) / 380)));
      const colW = Math.floor((vw - LEFT_EDGE - EDGE_MARGIN - (cols - 1) * SNAP_GAP) / cols);
      const maxH = vh - EDGE_MARGIN - TOP_MIN;
      const heights = Array(cols).fill(TOP_MIN);
      const placed = {};
      for (const p of ps) {
        if (p.closed || p.ws !== ws) continue;
        let c = 0; for (let i = 1; i < cols; i++) if (heights[i] < heights[c]) c = i;
        const effH = p.min ? HEAD_H : Math.min(p.h, maxH);
        placed[p.id] = { x: LEFT_EDGE + c * (colW + SNAP_GAP), y: heights[c], w: colW, h: p.min ? p.h : effH };
        heights[c] += effH + SNAP_GAP;
      }
      return ps.map((p) => (placed[p.id] ? { ...p, ...placed[p.id] } : p));
    });
  }

  function delegate(item, brain) {
    // delegating spins up a live run in Build AND opens a thread for it
    const variant = brain === "openclaw" ? "computer" : "dev";
    const def = makeTaskDef(brain === "hermes" ? "research" : variant, item.title, brain);
    def.brain = brain;
    setPanels((ps) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const colH = Math.max(260, vh - TOP_MIN - EDGE_MARGIN);
      const id = "task-" + Date.now();
      return [...ps, { id, ws: "build", type: "task", brain, title: def.title, def, startedAt: Date.now(), x: LEFT_EDGE, y: TOP_MIN, w: 320, h: colH, z: zTop.current++, entering: true }];
    });
    const tid = "th" + Date.now();
    setThreads((ts) => [{
      id: tid, name: shortName(item.title), tint: "var(--wash-1)", brain, status: "running",
      note: "handed to " + (BRAINS[brain] ? BRAINS[brain].name : "Hermes") + " · live in Build",
      msgs: [
        { who: "user", text: item.title },
        { who: "luna", brain, text: "picked it up — progress is streaming in Build. I'll nudge this thread the moment it's done." },
      ],
    }, ...ts]);
  }

  const ctx = {
    spawn, close,
    openVoice: () => setVoiceOpen(true),
    chatBrain, setChatBrain,
    focusInbox, toast: showToast, delegate,
    threads, activeThread, openThread, newThread, appendMsg, threadNote,
    submitSecure: (id, pl) => { close(id); showToast("sent securely ✦", "luna"); },
  };

  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const closed = panels.filter((p) => p.closed && p.ws === ws);
  const wsRunning = {};
  for (const p of panels) if (p.type === "task" && !p.closed && p.startedAt != null && (now - p.startedAt) / 1000 < p.def.dur) wsRunning[p.ws] = true;
  const activeThreadObj = threads.find((x) => x.id === activeThread);

  return (
    <div className="luna-root studio" data-palette={t.palette} data-theme={t.theme} data-chrome={t.chrome} data-grain={t.grain ? "on" : "off"} data-motion={t.motion} data-ready={ready ? "true" : "false"}>
      <div className="bg-blooms"><div className="bloom b1"></div><div className="bloom b2"></div><div className="bloom b3"></div></div>

      {/* workspace rail */}
      <div className="ws-rail">
        <div className="ws-moon" title="Luna Studio"></div>
        <div className="ws-list">
          {workspaces.map((w, i) => (
            <button key={w.id} className={"ws-tab" + (w.id === ws ? " active" : "")} style={{ "--ws-tint": w.tint }} onClick={() => switchWs(w.id)} title={w.name + " — press " + (i + 1)}>
              <span className="ws-wash">{WS_ICONS[w.icon] || WS_ICONS.blank}{wsRunning[w.id] && <span className="ws-activity"></span>}</span>
              <span className="ws-name">{w.name}</span>
              {i < 9 && <span className="ws-num">{i + 1}</span>}
            </button>
          ))}
          <button className="ws-add" title="new space" onClick={addWorkspace}>+</button>
        </div>
        <div className="ws-kbd-hint">press <b>1–{Math.min(workspaces.length, 9)}</b><br />to jump</div>
      </div>

      {/* top bar */}
      <div className="topbar">
        <div className="wordmark"><span className="name">Luna</span><span className="sub">studio</span></div>
        <div className="topbar-actions">
          {closed.length > 0 && (
            <div className="shelf">
              {closed.slice(0, 3).map((p) => (
                <button key={p.id} className="shelf-chip" onClick={() => restore(p.id)} title={"reopen " + (p.title || DEFS[p.type].title)}>
                  <span className="wash-dot" style={{ "--panel-tint": p.brain ? "var(--brain-" + p.brain + ")" : "var(--wash-2)" }}></span>
                  <span className="shelf-name">{p.title || DEFS[p.type].title}</span>
                </button>
              ))}
              {closed.length > 3 && <button className="shelf-chip more" onClick={() => setShelfOpen((o) => !o)}>+{closed.length - 3}</button>}
              {shelfOpen && closed.length > 3 && (
                <div className="shelf-pop">
                  {closed.slice(3).map((p) => (
                    <button key={p.id} className="shelf-chip" onClick={() => { restore(p.id); setShelfOpen(false); }}>
                      <span className="wash-dot" style={{ "--panel-tint": p.brain ? "var(--brain-" + p.brain + ")" : "var(--wash-2)" }}></span>
                      <span className="shelf-name">{p.title || DEFS[p.type].title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="arrange-group">
            <button title="tidy into a grid" onClick={tidy}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="2"></rect><rect x="13" y="3" width="8" height="8" rx="2"></rect><rect x="3" y="13" width="8" height="8" rx="2"></rect><rect x="13" y="13" width="8" height="8" rx="2"></rect></svg>
            </button>
          </div>
          <span className="date">{dateStr}</span>
        </div>
      </div>

      {/* panels */}
      {panels.map((p) => {
        const def = DEFS[p.type];
        const active = p.ws === ws;
        const live = p.type === "task" && p.startedAt != null && (now - p.startedAt) / 1000 < p.def.dur;
        const brain = p.type === "chat" ? chatBrain : p.brain;
        let title = p.title || def.title;
        if (p.type === "chat" && activeThreadObj) title = activeThreadObj.name;
        return (
          <div
            key={p.id}
            className={"panel" + (p.entering ? " entering" : "") + (active && switching ? " wsenter" : "") + (snappedId === p.id ? " snapped" : "") + (p.min ? " minimized" : "") + (dragId === p.id ? " dragging" : "")}
            data-screen-label={title}
            style={{ left: p.x, top: p.y, width: p.w, height: p.min ? HEAD_H : p.h, zIndex: p.z, display: active ? undefined : "none", "--panel-tint": brain ? "var(--brain-" + brain + ")" : "var(--wash-2)" }}
            onPointerDown={() => bringToFront(p.id)}
          >
            <div className="panel-wash"></div>
            <div className="panel-head" onPointerDown={(e) => startDrag(e, p.id, "move")}>
              <span className="wash-dot"></span>
              <span className="panel-title">{title}</span>
              {brain && <BrainBadge brain={brain} live={live} showName={p.w >= 320} />}
              <button className="panel-min" title={p.min ? "expand" : "minimize"} onClick={() => toggleMin(p.id)} onPointerDown={(e) => e.stopPropagation()}>{p.min ? "+" : "–"}</button>
              <button className="panel-close" title="close" onClick={() => close(p.id)} onPointerDown={(e) => e.stopPropagation()}>✕</button>
            </div>
            <div className="panel-body">{def.render(ctx, p)}</div>
            {!p.min && <div className="resize-handle" onPointerDown={(e) => { e.stopPropagation(); startDrag(e, p.id, "resize"); }}></div>}
          </div>
        );
      })}

      {guides.map((g, i) => (g.type === "v" ? <div key={i} className="guide-v" style={{ left: g.at }}></div> : <div key={i} className="guide-h" style={{ top: g.at }}></div>))}

      {toast && (
        <div className="studio-toast">
          <span className="tt-ic"><BrainBadge brain={toast.brain} bare showName={false} /></span>
          {toast.msg}
        </div>
      )}

      <div className="grain"></div>

      {t.ambient && !voiceOpen && <AmbientLuna onOpen={() => setVoiceOpen(true)} />}
      {voiceOpen && <VoiceScene onClose={() => setVoiceOpen(false)} onSpawn={(req) => { switchWs(req.type === "map" ? "city" : req.type === "task" ? "build" : ws); spawn(req); }} />}

      <TweaksPanel>
        <TweakSection label="Watercolor" />
        <TweakRadio label="Appearance" value={t.theme} options={["light", "dark"]} onChange={(v) => setTweak("theme", v)} />
        <TweakColor label="Palette" value={LUNA_PALETTES[t.palette]} options={[LUNA_PALETTES.dawn, LUNA_PALETTES.meadow, LUNA_PALETTES.tide]} onChange={(v) => {
          const name = Object.keys(LUNA_PALETTES).find((k) => LUNA_PALETTES[k].join() === (Array.isArray(v) ? v.join() : v));
          if (name) setTweak("palette", name);
        }} />
        <TweakRadio label="Panel chrome" value={t.chrome} options={["wash", "ink"]} onChange={(v) => setTweak("chrome", v)} />
        <TweakToggle label="Paper grain" value={t.grain} onChange={(v) => setTweak("grain", v)} />
        <TweakSection label="Presence" />
        <TweakRadio label="Motion" value={t.motion} options={["calm", "lively", "showy"]} onChange={(v) => setTweak("motion", v)} />
        <TweakToggle label="Ambient Luna" value={t.ambient} onChange={(v) => setTweak("ambient", v)} />
        <TweakSelect label="Default brain" value={t.defaultBrain} options={[{ value: "luna", label: "Luna" }, { value: "hermes", label: "Hermes" }, { value: "openclaw", label: "OpenClaw" }]} onChange={(v) => { setTweak("defaultBrain", v); setChatBrain(v); }} />
        <TweakSection label="Canvas" />
        <TweakSlider label="Magnet strength" value={t.snap} min={0} max={40} step={1} unit="px" onChange={(v) => setTweak("snap", v)} />
        <TweakToggle label="Snap guides" value={t.guides} onChange={(v) => setTweak("guides", v)} />
      </TweaksPanel>
    </div>
  );
}
