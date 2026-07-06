// final-threads.jsx — shared thread seed + the Threads overview panel.
// A "thread" is a side-quest conversation: it keeps its own history, its own
// brain, and a live status (needs you / running / quiet / done).
import React from "react";
import { BrainBadge } from "./studio-brain.jsx";

export const THREADS_SEED = [
  {
    id: "morning", name: "morning", tint: "var(--wash-2)", brain: "luna", status: "active",
    note: "the open studio thread",
    msgs: [
      { who: "luna", text: "morning ✦ I tidied the inbox overnight — 9 things, only 2 really need you. want to run Focus, or peek at tonight first?" },
    ],
  },
  {
    id: "lisbon", name: "lisbon trip", tint: "var(--wash-0)", brain: "openclaw", status: "needs", unread: 1,
    note: "3 flights held — waiting on your pick",
    msgs: [
      { who: "user", text: "find flights to lisbon for apr 12, under €400" },
      { who: "luna", brain: "openclaw", text: "Search complete. 3 options under €400 — all refundable, all morning departures. They're in your inbox; pick one and I'll book it." },
    ],
  },
  {
    id: "site", name: "studio site", tint: "var(--wash-4)", brain: "hermes", status: "running",
    note: "build live in Build · writing the hero",
    msgs: [
      { who: "user", text: "build the studio landing page from the brief" },
      { who: "luna", brain: "hermes", text: "On it. Scaffolded, palette wired — writing the hero now. Watch the run in Build; I'll nudge this thread when the preview's live." },
    ],
  },
  {
    id: "residency", name: "residency", tint: "var(--wash-1)", brain: "luna", status: "quiet",
    note: "reply due friday",
    msgs: [
      { who: "user", text: "should I take the residency?" },
      { who: "luna", text: "I keep coming back to it too. six weeks is long — but it's by the sea, and April-you is usually braver than March-you. they need a reply by friday. want me to draft both versions so you can feel the difference?" },
    ],
  },
  {
    id: "tax", name: "tax quarter", tint: "var(--wash-3)", brain: "luna", status: "done",
    note: "reviewed · €4,210 set aside",
    msgs: [
      { who: "luna", text: "quarter's crunched — you're 4% under last quarter. €4,210 is set aside and waiting on your say-so to move to savings." },
    ],
  },
];

export const THREAD_SECTIONS = [
  { key: "needs", label: "needs you", match: (t) => t.status === "needs" },
  { key: "live", label: "live", match: (t) => t.status === "active" || t.status === "running" },
  { key: "earlier", label: "earlier", match: (t) => t.status === "quiet" || t.status === "done" },
];
export const THREAD_STATUS_LABEL = { needs: "needs you", running: "running", active: "now", done: "done ✦", quiet: "" };

function ThreadStatusTag({ status }) {
  if (status === "needs") return <span className="th-tag needs">needs you</span>;
  if (status === "running") return <span className="th-tag running">running</span>;
  if (status === "done") return <span className="th-tag done">done ✦</span>;
  return null;
}

export function ThreadsApp({ threads, activeId, onOpen }) {
  const waiting = threads.filter((t) => t.status === "needs").length;
  return (
    <div className="thv-wrap">
      <div className="thv-bar"><b>{waiting}</b> waiting on you · {threads.length} threads</div>
      <div className="thv-list">
        {THREAD_SECTIONS.map((sec) => {
          const rows = threads.filter(sec.match);
          if (!rows.length) return null;
          return (
            <React.Fragment key={sec.key}>
              <div className="thv-sec">{sec.label}</div>
              {rows.map((t) => (
                <button key={t.id} className={"thv-row" + (t.id === activeId ? " active" : "")} onClick={() => onOpen(t.id)}>
                  <span className="thv-dot" style={{ background: t.tint }}></span>
                  <span className="thv-main">
                    <span className="thv-name">{t.name}<BrainBadge brain={t.brain} bare showName={false} /></span>
                    <span className="thv-note">{t.note}</span>
                  </span>
                  <span className="thv-side">
                    {t.unread ? <span className="th-unread">{t.unread}</span> : <ThreadStatusTag status={t.status} />}
                  </span>
                </button>
              ))}
            </React.Fragment>
          );
        })}
      </div>
      <div className="thv-foot">tap a thread to pick it up in chat ✦</div>
    </div>
  );
}
