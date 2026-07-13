// final-app.jsx — Luna Studio (final): Home space with inbox + threads,
// City and Build spaces, keyboard jumping, and threads woven through chat.
import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "react";
import { LUNA_PALETTES, PipApp, TimerApp, WeatherApp, MusicApp, HabitApp, StickyApp, SecureApp } from "./luna-mini-apps.jsx";
import { TASK_DEFS, BRAINS } from "./studio-data.jsx";
import { BrainBadge } from "./studio-brain.jsx";
import { TaskRunner } from "./studio-task.jsx";
import { MapApp } from "./studio-map.jsx";
import { taskDefFromDelegation } from "./task-defs.js";
import { AmbientLuna, VoiceScene } from "./studio-voice.jsx";
import { useLunaData } from "../data/useLunaData";
import { useStudioNotifier } from "../data/useStudioNotifier";
import { useStudioActiveThreadName } from "../data/useStudioThreads";
import { useUiSelector } from "../data/useUiStore";
import { createFrameCoalescer } from "../data/frame-coalescer";
import { STUDIO_LIVE_PANELS } from "./studio-live-panels.jsx";

// Dev-ops panels reachable from the topbar settings-gear launcher. Settings +
// Events always show; the rest gate on the hello capability.
const LAUNCHER_ITEMS = [
  { type: "settings", label: "Settings", show: () => true },
  { type: "obs", label: "Events", show: () => true },
  { type: "artifacts", label: "Artifacts", show: (c) => c.artifacts === true },
  { type: "skills", label: "Skills", show: (c) => c.skills === true },
  { type: "connectors", label: "Connectors", show: (c) => c.connectors === true },
  { type: "vault", label: "Vault", show: (c) => c.vault === true },
  { type: "workflows", label: "Workflows", show: (c) => c.workflows === true },
];

const TWEAK_DEFAULTS = { theme: "light", palette: "tide", chrome: "wash", grain: false, motion: "lively", ambient: true, defaultBrain: "luna", snap: 28, guides: true };

// Appearance/presence/canvas state, edited from the Settings panel (the old
// floating dev-only Tweaks panel is gone — its controls live in Settings now).
// setTweak accepts setTweak('key', value) or setTweak({ key: value, ... }).
function useTweaks(defaults) {
  const [values, setValues] = useState(defaults);
  const setTweak = useCallback((keyOrEdits, val) => {
    const edits = typeof keyOrEdits === "object" && keyOrEdits !== null
      ? keyOrEdits : { [keyOrEdits]: val };
    setValues((prev) => ({ ...prev, ...edits }));
  }, []);
  return [values, setTweak];
}

// React 18 has no useEffectEvent. This keeps board commands stable for memoized
// panels while always dispatching through the newest implementation/state.
function useStableEvent(callback) {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback((...args) => callbackRef.current(...args), []);
}

const RAIL_W = 78;
const EDGE_MARGIN = 24;
const LEFT_EDGE = RAIL_W + EDGE_MARGIN;
const SNAP_GAP = 16;
const TOP_MIN = 64;
const HEAD_H = 40;

const selectCapabilities = (state) => state.capabilities;
const selectPinnedArtifacts = (state) => state.pinnedArtifacts;

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
  chat:    { title: "luna", Content: STUDIO_LIVE_PANELS.chat },
  threads: { title: "threads", Content: STUDIO_LIVE_PANELS.threads },
  inbox:   { title: "inbox", Content: STUDIO_LIVE_PANELS.inbox },
  map:     { title: "the city", render: (ctx) => <MapApp onToast={ctx.toast} /> },
  task:    { title: "task", render: (ctx, p) => <TaskRunner def={p.def} startedAt={p.startedAt} /> },
  widget:  { title: "widget", Content: STUDIO_LIVE_PANELS.widget },
  pip:     { title: "pip", render: () => <PipApp /> },
  timer:   { title: "focus timer", w: 240, h: 200, render: () => <TimerApp /> },
  weather: { title: "weather", w: 260, h: 250, render: () => <WeatherApp /> },
  music:   { title: "music", w: 280, h: 170, render: () => <MusicApp /> },
  habit:   { title: "habits", w: 300, h: 230, render: () => <HabitApp /> },
  sticky:  { title: "sticky note", w: 250, h: 220, render: (ctx, p) => <StickyApp initial={p.request} /> },
  secure:  { title: "secure", w: 300, h: 290, render: (ctx, p) => <SecureApp request={p.request} kind={p.kind} onSubmit={(pl) => ctx.submitSecure(p.id, pl)} onCancel={() => ctx.close(p.id)} /> },
  settings:   { title: "settings",   Content: STUDIO_LIVE_PANELS.settings },
  connectors: { title: "connectors", Content: STUDIO_LIVE_PANELS.connectors },
  obs:        { title: "events",     Content: STUDIO_LIVE_PANELS.obs },
  artifacts:  { title: "artifacts",  Content: STUDIO_LIVE_PANELS.artifacts },
  skills:     { title: "skills",     Content: STUDIO_LIVE_PANELS.skills },
  vault:      { title: "vault",      Content: STUDIO_LIVE_PANELS.vault },
  workflows:  { title: "workflows",  Content: STUDIO_LIVE_PANELS.workflows },
};
const DEFAULT_SIZE = { task: { w: 304, h: 330 }, widget: { w: 262, h: 244 }, map: { w: 440, h: 360 }, inbox: { w: 340, h: 420 }, chat: { w: 420, h: 460 }, threads: { w: 260, h: 380 }, settings: { w: 340, h: 540 }, connectors: { w: 380, h: 480 }, obs: { w: 560, h: 400 }, artifacts: { w: 360, h: 500 }, skills: { w: 400, h: 460 }, vault: { w: 400, h: 560 }, workflows: { w: 380, h: 460 } };

function snapAxis(raw, candidates, thresh) {
  let best = null;
  for (const c of candidates) {
    const d = Math.abs(raw - c.pos);
    if (d <= thresh && (!best || d < best.d)) best = { ...c, d };
  }
  return best;
}

function sameGuides(a, b) {
  return a.length === b.length && a.every((guide, index) => (
    guide.type === b[index].type && guide.at === b[index].at
  ));
}

function StudioDate() {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const next = new Date(today);
    next.setHours(24, 0, 0, 25);
    const timer = setTimeout(() => setToday(new Date()), next.getTime() - Date.now());
    return () => clearTimeout(timer);
  }, [today]);
  return (
    <span className="date">
      {today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
    </span>
  );
}

const PanelWindow = React.memo(function PanelWindow({
  panel,
  active,
  switching,
  snapped,
  dragging,
  title,
  brain,
  live,
  ctx,
  onBringToFront,
  onStartDrag,
  onToggleMin,
  onClose,
}) {
  const def = DEFS[panel.type];
  const Content = def.Content;
  return (
    <div
      className={"panel" + (panel.entering ? " entering" : "") + (active && switching ? " wsenter" : "") + (snapped ? " snapped" : "") + (panel.min ? " minimized" : "") + (dragging ? " dragging" : "")}
      data-screen-label={title}
      style={{
        left: panel.x,
        top: panel.y,
        width: panel.w,
        height: panel.min ? HEAD_H : panel.h,
        zIndex: panel.z,
        display: active && !panel.closed ? undefined : "none",
        "--panel-tint": brain ? "var(--brain-" + brain + ")" : "var(--wash-2)",
      }}
      onPointerDown={() => onBringToFront(panel.id)}
    >
      <div className="panel-wash"></div>
      <div className="panel-head" onPointerDown={(event) => onStartDrag(event, panel.id, "move")}>
        <span className="wash-dot"></span>
        <span className="panel-title">{title}</span>
        {brain && <BrainBadge brain={brain} live={live} showName={panel.w >= 320} />}
        <button className="panel-min" title={panel.min ? "expand" : "minimize"} onClick={() => onToggleMin(panel.id)} onPointerDown={(event) => event.stopPropagation()}>{panel.min ? "+" : "–"}</button>
        <button className="panel-close" title="close" onClick={() => onClose(panel.id)} onPointerDown={(event) => event.stopPropagation()}>✕</button>
      </div>
      <div className="panel-body">
        {Content ? <Content ctx={ctx} panel={panel} /> : def.render(ctx, panel)}
      </div>
      {!panel.min && <div className="resize-handle" onPointerDown={(event) => { event.stopPropagation(); onStartDrag(event, panel.id, "resize"); }}></div>}
    </div>
  );
});

export function StudioApp() {
  const luna = useLunaData();
  // Phase 2 notifications: self-subscribes to the raw frame side-channel and
  // owns focus-regain routing. StudioApp holds the full LunaData.
  useStudioNotifier(luna);
  const client = useMemo(() => ({
    store: luna.store,
    status: luna.status,
    connected: luna.connected,
    openThread: luna.openThread,
    newThread: luna.newThread,
    appendMsg: luna.appendMsg,
    threadNote: luna.threadNote,
    suggestedActions: luna.suggestedActions,
    respondToAction: luna.respondToAction,
    send: luna.send,
    onServerFrame: luna.onServerFrame,
    config: luna.config,
    updateConfig: luna.updateConfig,
    reconnect: luna.reconnect,
    disconnect: luna.disconnect,
    selectAccount: luna.selectAccount,
    restartServer: luna.restartServer,
    model: luna.model,
    mcp: luna.mcp,
    focusArtifact: luna.focusArtifact,
    widgetOpen: luna.widgetOpen,
    deepLinkThread: luna.deepLinkThread,
  }), [
    luna.store, luna.status, luna.connected, luna.openThread, luna.newThread,
    luna.appendMsg, luna.threadNote, luna.suggestedActions, luna.respondToAction,
    luna.send, luna.onServerFrame, luna.config, luna.updateConfig, luna.reconnect,
    luna.disconnect, luna.selectAccount, luna.restartServer, luna.model, luna.mcp,
    luna.focusArtifact, luna.widgetOpen, luna.deepLinkThread,
  ]);
  return <StudioBoard luna={client} />;
}

const StudioBoard = React.memo(function StudioBoard({ luna }) {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [workspaces, setWorkspaces] = useState(WORKSPACES_SEED);
  const [ws, setWs] = useState("home");
  const [panels, setPanels] = useState(() => buildPanels(window.innerWidth, window.innerHeight));
  const pinnedArtifacts = useUiSelector(luna.store, selectPinnedArtifacts);
  const capabilities = useUiSelector(luna.store, selectCapabilities);
  const activeThreadName = useStudioActiveThreadName(luna.store);
  // P4 vibe-coded widgets: pinned artifacts keyed for board-level focus/open
  // effects. The widget panel owns its separate live selector projection.
  const widgetArtifacts = useMemo(
    () => new Map(pinnedArtifacts.map((artifact) => [artifact.id, artifact])),
    [pinnedArtifacts],
  );
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
  const [menuOpen, setMenuOpen] = useState(false);

  const panelsRef = useRef(panels); panelsRef.current = panels;
  const zTop = useRef(60);
  const dragRef = useRef(null);
  const toastTimer = useRef(null);
  const wsCount = useRef(0);
  const applyPointerPosition = useStableEvent(({ clientX, clientY }) => {
    applyPointerMove(clientX, clientY);
  });
  const pointerFrames = useMemo(
    () => createFrameCoalescer(applyPointerPosition),
    [applyPointerPosition],
  );
  const pointerMoveListener = useStableEvent((event) => {
    pointerFrames.push({ clientX: event.clientX, clientY: event.clientY });
  });
  const pointerUpListener = useStableEvent(() => {
    pointerFrames.flush();
    finishPointerDrag();
  });

  useEffect(() => () => {
    pointerFrames.cancel();
    window.removeEventListener("pointermove", pointerMoveListener);
    window.removeEventListener("pointerup", pointerUpListener);
  }, [pointerFrames, pointerMoveListener, pointerUpListener]);

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
        let changed = false;
        const next = prev.map((p) => {
          if (p.userMoved || !byId[p.id]) return p;
          const s = byId[p.id];
          if (p.x === s.x && p.y === s.y && p.w === s.w && p.h === s.h) return p;
          changed = true;
          return { ...p, x: s.x, y: s.y, w: s.w, h: s.h };
        });
        return changed ? next : prev;
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

  /* ---------- threads (real, via useLunaData) ---------- */
  const appendMsg = luna.appendMsg;
  const threadNote = luna.threadNote;
  function openThread(id) {
    luna.openThread(id);
    const chat = panelsRef.current.find((p) => p.type === "chat" && p.ws === ws && !p.closed)
      || panelsRef.current.find((p) => p.type === "chat" && p.ws === "home");
    if (chat) {
      if (chat.ws !== ws) switchWs(chat.ws);
      bringToFront(chat.id);
    }
  }
  function newThread() {
    luna.newThread();
    const chat = panelsRef.current.find((p) => p.type === "chat" && p.ws === ws && !p.closed);
    if (chat) bringToFront(chat.id);
  }

  /* listen for thread-opens from other panels (inbox) */
  const openThreadRef = useRef(openThread); openThreadRef.current = openThread;
  useEffect(() => {
    function h(e) { if (e.detail && e.detail.id) openThreadRef.current(e.detail.id); }
    window.addEventListener("studio:openThread", h);
    return () => window.removeEventListener("studio:openThread", h);
  }, []);

  /* ---------- vibe-coded widgets (P4): persist + agent-driven open ---------- */
  // Pinned widget/mcp-app artifacts are durable server-side (luna.db) and
  // resent after every hello — reconstructing a board panel for each one we
  // don't already have (every time the pinned list changes) is what makes a
  // summoned widget survive a reload with zero client-side caching.
  useEffect(() => {
    for (const a of pinnedArtifacts) {
      if (a.kind === "widget" || a.kind === "mcp-app") {
        ensureWidgetPanel(a.id, { title: a.title, fresh: false });
      }
    }
  }, [pinnedArtifacts]);

  // An open-artifact-widget frame: widget_write/mcp_app_write just created
  // one (auto-open), or the user asked Luna to reopen a closed one. Focus an
  // existing panel, or spawn fresh if the pinned-artifacts effect above
  // hasn't caught up to it yet.
  useEffect(() => {
    const f = luna.focusArtifact;
    if (!f) return;
    const artifact = widgetArtifacts.get(f.id);
    if (!artifact || (artifact.kind !== "widget" && artifact.kind !== "mcp-app")) return;
    const existing = panelsRef.current.find((p) => p.type === "widget" && p.artifactId === f.id);
    if (existing) {
      if (existing.closed) restore(existing.id);
      if (existing.ws !== ws) switchWs(existing.ws);
      bringToFront(existing.id);
    } else {
      ensureWidgetPanel(f.id, { title: artifact.title, fresh: true });
    }
  }, [luna.focusArtifact, widgetArtifacts]);

  // A widget-open frame naming one of useLunaData's WIDGET_DIRECTORY kinds
  // (chat/threads/inbox) — focus that panel, switching workspace if needed.
  useEffect(() => {
    const w = luna.widgetOpen;
    if (!w) return;
    const target =
      panelsRef.current.find((p) => p.type === w.kind && p.ws === ws) ||
      panelsRef.current.find((p) => p.type === w.kind);
    if (!target) return;
    if (target.closed) restore(target.id);
    if (target.ws !== ws) switchWs(target.ws);
    bringToFront(target.id);
  }, [luna.widgetOpen]);

  // A luna://thread/<id> deep link fired. Selection + subscribe already
  // happened in useLunaData's bootstrap effect, so this ONLY surfaces the chat
  // panel: switch to the home workspace and bring the chat panel to front.
  // Do NOT call openThread here - it would re-select and re-trigger the
  // stale-selection guard override in useLunaData.
  useEffect(() => {
    const d = luna.deepLinkThread;
    if (!d) return;
    if (ws !== "home") switchWs("home");
    const chat = panelsRef.current.find((p) => p.type === "chat" && p.ws === "home");
    if (chat) {
      if (chat.closed) restore(chat.id);
      bringToFront(chat.id);
    }
  }, [luna.deepLinkThread]);

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
    if (!p) return;
    dragRef.current = { id, mode, startX: e.clientX, startY: e.clientY, ox: p.x, oy: p.y, ow: p.w, oh: p.h, ws: p.ws };
    bringToFront(id);
    setDragId(id);
    window.addEventListener("pointermove", pointerMoveListener);
    window.addEventListener("pointerup", pointerUpListener);
  }
  function applyPointerMove(clientX, clientY) {
    const d = dragRef.current; if (!d) return;
    if (!d.moved) {
      d.moved = true;
      setPanels((ps) => ps.map((p) => (p.id === d.id ? { ...p, userMoved: true } : p)));
    }
    const dx = clientX - d.startX, dy = clientY - d.startY;
    if (d.mode === "move") {
      const p = panelsRef.current.find((q) => q.id === d.id);
      if (!p) return;
      const res = computeSnap(d.id, d.ox + dx, d.oy + dy, p.w, p.min ? HEAD_H : p.h, d.ws);
      setGuides((current) => sameGuides(current, res.guides) ? current : res.guides);
      setSnappedId((current) => {
        const next = res.snapped ? d.id : null;
        return current === next ? current : next;
      });
      setPanels((ps) => {
        let changed = false;
        const next = ps.map((q) => {
          if (q.id !== d.id || (q.x === res.x && q.y === res.y)) return q;
          changed = true;
          return { ...q, x: res.x, y: res.y };
        });
        return changed ? next : ps;
      });
    } else {
      const w = Math.max(200, d.ow + dx), h = Math.max(140, d.oh + dy);
      setPanels((ps) => {
        let changed = false;
        const next = ps.map((q) => {
          if (q.id !== d.id || (q.w === w && q.h === h)) return q;
          changed = true;
          return { ...q, w, h };
        });
        return changed ? next : ps;
      });
    }
  }
  function finishPointerDrag() {
    dragRef.current = null;
    setDragId(null);
    setGuides([]);
    setTimeout(() => setSnappedId(null), 240);
    window.removeEventListener("pointermove", pointerMoveListener);
    window.removeEventListener("pointerup", pointerUpListener);
  }

  /* ---------- spawn / close / restore / tidy ---------- */
  const spawnN = useRef(0);
  // Vibe-coded widgets (P4): dedup guard so the pinned-artifact restore
  // effect and the agent's live open-artifact-widget signal can't both spawn
  // a second panel for the same artifact — checked+claimed synchronously (a
  // plain Set, not React state) so it's race-safe within one render's effects.
  const widgetPanelRef = useRef(new Set());
  function ensureWidgetPanel(artifactId, opts) {
    if (widgetPanelRef.current.has(artifactId)) return false;
    if (panelsRef.current.some((p) => p.type === "widget" && p.artifactId === artifactId)) {
      widgetPanelRef.current.add(artifactId);
      return false;
    }
    widgetPanelRef.current.add(artifactId);
    spawn({ type: "widget", artifactId, title: opts && opts.title, fresh: !!(opts && opts.fresh) });
    return true;
  }
  function spawn(req) {
    const def = DEFS[req.type]; if (!def) return;
    const n = spawnN.current++;
    const vw = window.innerWidth;
    const sz = DEFAULT_SIZE[req.type] || { w: def.w || 264, h: def.h || 230 };
    const w = req.w || sz.w, h = req.h || sz.h;
    // Widgets get a DETERMINISTIC id keyed on the pinned artifact (not
    // Date.now()) — the restore effect can spawn several in one tick and
    // Date.now() collides at millisecond resolution; this also makes the
    // same artifact resolve to the same panel id every reload.
    const id = req.type === "widget" && req.artifactId ? "widget-" + req.artifactId : req.type + "-" + Date.now();
    const rawX = Math.min(vw - w - EDGE_MARGIN, vw * 0.4 + (n % 4) * 30);
    const rawY = TOP_MIN + 36 + (n % 5) * 34;
    const pos = computeSnap(id, rawX, rawY, w, h, ws);
    zTop.current += 1;
    setPanels((ps) => [...ps, {
      id, ws, type: req.type, brain: req.brain, title: req.title,
      def: req.def, startedAt: req.def ? Date.now() : undefined,
      spec: req.spec, fresh: req.fresh, request: req.request, kind: req.kind,
      artifactId: req.artifactId,
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
    const def = taskDefFromDelegation(brain, item.title);
    setPanels((ps) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const colH = Math.max(260, vh - TOP_MIN - EDGE_MARGIN);
      const id = "task-" + Date.now();
      return [...ps, { id, ws: "build", type: "task", brain, title: def.title, def, startedAt: Date.now(), x: LEFT_EDGE, y: TOP_MIN, w: 320, h: colH, z: zTop.current++, entering: true }];
    });
    // Real delegation (server-driven task runs + a thread) lands in the P3
    // tasks seam; for now spinning the Build panel + a toast is the feedback.
    showToast("handed to " + (BRAINS[brain] ? BRAINS[brain].name : "a brain") + " ✦ live in Build", brain);
  }

  // Summon a dev-ops panel by type: focus if open, restore if closed, else spawn.
  function summonPanel(type) {
    const existing = panelsRef.current.find((p) => p.type === type && p.ws === ws && !p.closed);
    if (existing) { bringToFront(existing.id); }
    else {
      const closedP = panelsRef.current.find((p) => p.type === type && p.ws === ws && p.closed);
      if (closedP) restore(closedP.id); else spawn({ type });
    }
    setMenuOpen(false);
  }

  // First run: the Studio has no other connect UI — auto-open Settings once
  // while disconnected so the user can enter the server URL + token. (Native
  // Studio may auto-provision the loopback token via load_local_connection
  // and connect on its own; the panel still opens once as the status surface.)
  const settingsAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (!settingsAutoOpenedRef.current && !luna.connected && luna.status.kind !== "connecting") {
      settingsAutoOpenedRef.current = true;
      summonPanel("settings");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [luna.connected, luna.status.kind]);

  const spawnCommand = useStableEvent(spawn);
  const closeCommand = useStableEvent(close);
  const openVoiceCommand = useStableEvent(() => setVoiceOpen(true));
  const focusInboxCommand = useStableEvent(focusInbox);
  const toastCommand = useStableEvent(showToast);
  const delegateCommand = useStableEvent(delegate);
  const openThreadCommand = useStableEvent(openThread);
  const newThreadCommand = useStableEvent(newThread);
  const acceptActionCommand = useStableEvent((id) => luna.respondToAction(id, "accept"));
  const dismissActionCommand = useStableEvent((id) => luna.respondToAction(id, "dismiss"));
  const submitSecureCommand = useStableEvent((id) => {
    close(id);
    showToast("sent securely ✦", "luna");
  });
  const pinArtifactCommand = useStableEvent((artifact) => luna.send({
    type: "artifact-pin",
    id: artifact.id,
    title: artifact.title,
    content: artifact.content,
    lang: artifact.lang,
    origin: artifact.path ?? luna.store.getState().selectedThreadId ?? null,
  }));
  const unpinArtifactCommand = useStableEvent((id) => luna.send({ type: "artifact-unpin", id }));
  const ctx = useMemo(() => ({
    store: luna.store,
    spawn: spawnCommand,
    close: closeCommand,
    openVoice: openVoiceCommand,
    chatBrain,
    setChatBrain,
    focusInbox: focusInboxCommand,
    toast: toastCommand,
    delegate: delegateCommand,
    openThread: openThreadCommand,
    newThread: newThreadCommand,
    appendMsg,
    threadNote,
    suggestedActions: luna.suggestedActions,
    acceptAction: acceptActionCommand,
    dismissAction: dismissActionCommand,
    submitSecure: submitSecureCommand,
    mcp: luna.mcp,
    send: luna.send,
    connected: luna.connected,
    status: luna.status,
    onServerFrame: luna.onServerFrame,
    config: luna.config,
    updateConfig: luna.updateConfig,
    connect: luna.reconnect,
    disconnect: luna.disconnect,
    restartServer: luna.restartServer,
    selectAccount: luna.selectAccount,
    model: luna.model,
    tweaks: t,
    setTweak,
    focusArtifact: luna.focusArtifact,
    pinArtifact: pinArtifactCommand,
    unpinArtifact: unpinArtifactCommand,
  }), [
    luna.store, spawnCommand, closeCommand, openVoiceCommand, chatBrain, setChatBrain,
    focusInboxCommand, toastCommand, delegateCommand, openThreadCommand,
    newThreadCommand, appendMsg, threadNote, luna.suggestedActions,
    acceptActionCommand, dismissActionCommand, submitSecureCommand, luna.mcp,
    luna.send, luna.connected, luna.status,
    luna.onServerFrame, luna.config, luna.updateConfig, luna.reconnect,
    luna.disconnect, luna.restartServer, luna.selectAccount, luna.model, t, setTweak,
    luna.focusArtifact,
    pinArtifactCommand, unpinArtifactCommand,
  ]);

  const bringToFrontCommand = useStableEvent(bringToFront);
  const startDragCommand = useStableEvent(startDrag);
  const toggleMinCommand = useStableEvent(toggleMin);
  const closed = panels.filter((p) => p.closed && p.ws === ws);
  const wsRunning = {};
  for (const p of panels) if (p.type === "task" && !p.closed && p.startedAt != null && (now - p.startedAt) / 1000 < p.def.dur) wsRunning[p.ws] = true;

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
          <div className="settings-launcher" style={{ position: "relative" }}>
            <button title="settings & panels" onClick={() => setMenuOpen((o) => !o)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            </button>
            {menuOpen && (
              <div className="shelf-pop settings-menu">
                {LAUNCHER_ITEMS.filter((it) => it.show(capabilities)).map((it) => (
                  <button key={it.type} className="shelf-chip" onClick={() => summonPanel(it.type)}>
                    <span className="wash-dot" style={{ "--panel-tint": "var(--wash-2)" }}></span>
                    <span className="shelf-name">{it.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="arrange-group">
            <button title="tidy into a grid" onClick={tidy}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="2"></rect><rect x="13" y="3" width="8" height="8" rx="2"></rect><rect x="3" y="13" width="8" height="8" rx="2"></rect><rect x="13" y="13" width="8" height="8" rx="2"></rect></svg>
            </button>
          </div>
          <StudioDate />
        </div>
      </div>

      {/* panels */}
      {panels.map((p) => {
        const active = p.ws === ws;
        const live = p.type === "task" && p.startedAt != null && (now - p.startedAt) / 1000 < p.def.dur;
        const brain = p.type === "chat" ? chatBrain : p.brain;
        let title = p.title || DEFS[p.type].title;
        if (p.type === "chat" && activeThreadName) title = activeThreadName;
        return (
          <PanelWindow
            key={p.id}
            panel={p}
            active={active}
            switching={switching}
            snapped={snappedId === p.id}
            dragging={dragId === p.id}
            title={title}
            brain={brain}
            live={live}
            ctx={ctx}
            onBringToFront={bringToFrontCommand}
            onStartDrag={startDragCommand}
            onToggleMin={toggleMinCommand}
            onClose={closeCommand}
          />
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

    </div>
  );
});
