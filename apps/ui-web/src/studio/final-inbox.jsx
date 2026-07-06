// final-inbox.jsx — the natural inbox: priority-ordered list + one-at-a-time
// Focus triage that opens each item in full, with thread links back to chat.
import React from "react";
import { INBOX_SEED, BRAINS, BRAIN_ORDER } from "./studio-data.jsx";
import { BrainBadge, BrainIcon } from "./studio-brain.jsx";
const FbReact = React;

const FB_ICONS = {
  email: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3 7 9 6 9-6"></path></svg>,
  todo: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="m8 12 3 3 5-6"></path></svg>,
  ping: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.7 21a2 2 0 0 1-3.4 0"></path></svg>,
  calendar: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M3 9h18M8 3v4M16 3v4"></path></svg>,
};
function FbGlyph({ kind }) {
  return <span className="ib-glyph">{FB_ICONS[kind] || FB_ICONS.todo}</span>;
}

const FB_CLIP = <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"></path></svg>;
const FB_THREAD_IC = <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12Z"></path></svg>;

// which inbox items belong to a thread
const FB_THREAD_LINKS = { i3: "lisbon", i9: "residency" };
const FB_PRIO_ORD = { act: 0, soon: 1 };
function fbSeed() {
  return INBOX_SEED
    .map((x) => ({ ...x, thread: FB_THREAD_LINKS[x.id] }))
    .sort((a, b) => (FB_PRIO_ORD[a.prio] ?? 2) - (FB_PRIO_ORD[b.prio] ?? 2));
}

function FbRichBlock({ b }) {
  switch (b.t) {
    case "detail":
      return <div className="rc-detail">{b.rows.map((r, i) => <div className="rc-drow" key={i}><span className="dl">{r[0]}</span><span className="dv">{r[1]}</span></div>)}</div>;
    case "quote":
      return <div className="rc-quote">{b.who && <span className="qwho">{b.who}</span>}<span dangerouslySetInnerHTML={{ __html: b.html }}></span></div>;
    case "fig":
      return <div className="rc-fig">{b.rows.map((r, i) => <div className={"rc-fig-row" + (r[2] ? " total" : "")} key={i}><span>{r[0]}</span><span className="v">{r[1]}</span></div>)}</div>;
    case "callout":
      return <div className="rc-callout"><span className="sp">✦</span><span dangerouslySetInnerHTML={{ __html: b.html }}></span></div>;
    case "list":
      return <ul className="rc-list">{b.items.map((it, i) => <li key={i}><span className="bullet">✦</span><span dangerouslySetInnerHTML={{ __html: it }}></span></li>)}</ul>;
    case "attach":
      return <div className="rc-attach">{FB_CLIP}<span className="an">{b.name}</span><span className="am">{b.meta}</span></div>;
    case "thread":
      return <div className="rc-thread">{b.msgs.map((m, i) => <div className="rc-msg" key={i}><span className="rw">{m.who}</span><span dangerouslySetInnerHTML={{ __html: m.html }}></span></div>)}</div>;
    case "attendees":
      return <div className="rc-att"><div className="rc-att-faces">{b.names.map((nm, i) => <span className="face" key={i} style={{ background: b.colors[i % b.colors.length] }}>{nm[0]}</span>)}</div><span className="rc-att-label">{b.label}</span></div>;
    default:
      return null;
  }
}
function FbRichBody({ blocks }) {
  return <div className="focus-rich">{blocks.map((b, i) => <FbRichBlock key={i} b={b} />)}</div>;
}
function FbChoiceCards({ options, onPick }) {
  return (
    <div className="rc-choices">
      {options.map((o, i) => (
        <button className="rc-choice" key={i} onClick={() => onPick(o.name)}>
          <span className="pick"></span>
          <span className="cgrow"><span className="cn">{o.name}</span><span className="cm">{o.meta}</span></span>
          <span className="ck">{i + 1}</span>
        </button>
      ))}
    </div>
  );
}

export function FinalInbox({ onDelegate, onToast, onOpenThread }) {
  const { useState, useRef, useEffect } = FbReact;
  const [items, setItems] = useState(fbSeed);
  const [draft, setDraft] = useState("");
  const [focus, setFocus] = useState(false);
  const [done, setDone] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [clearing, setClearing] = useState(null);
  const totalRef = useRef(0);
  const nextId = useRef(1);

  // captures from elsewhere (e.g. the map's "add to Today")
  useEffect(() => {
    function onCap(e) {
      const d = e.detail || {};
      setItems((l) => [{ id: "c" + nextId.current++, kind: d.kind || "todo", title: d.title || "New todo", sub: d.sub || "captured just now", time: "now" }, ...l]);
    }
    window.addEventListener("studio:capture", onCap);
    return () => window.removeEventListener("studio:capture", onCap);
  }, []);

  // chat's "let's hit focus" action
  const startFocusRef = useRef(null);
  useEffect(() => {
    function onFocusEvt() { startFocusRef.current && startFocusRef.current(); }
    window.addEventListener("studio:focus", onFocusEvt);
    return () => window.removeEventListener("studio:focus", onFocusEvt);
  }, []);

  function capture() {
    const t = draft.trim();
    if (!t) return;
    setItems((l) => [{ id: "c" + nextId.current++, kind: "todo", title: t, sub: "captured just now", time: "now" }, ...l]);
    setDraft("");
    onToast && onToast("captured ✦", "luna");
  }

  function clearRow(id, msg, brain) {
    setClearing(id);
    setTimeout(() => {
      setItems((l) => l.filter((x) => x.id !== id));
      setClearing(null);
      if (msg) onToast && onToast(msg, brain);
    }, 240);
  }

  function startFocus() {
    if (!items.length) return;
    totalRef.current = items.length;
    setDone(false);
    setFocus(true);
  }
  startFocusRef.current = startFocus;

  function handle(action, brain, val) {
    const cur = items[0];
    if (!cur) return;
    setDelOpen(false);
    let msg = null, toastBrain = "luna";
    if (action === "done") msg = "done ✦";
    else if (action === "snooze") msg = "snoozed till tomorrow";
    else if (action === "reply") msg = "drafted a reply for you ✦";
    else if (action === "choice") { msg = val + " ✦"; toastBrain = cur.brain || "luna"; }
    else if (action === "delegate") {
      msg = "handed to " + (BRAINS[brain] ? BRAINS[brain].name : "Hermes") + " ✦";
      toastBrain = brain;
      onDelegate && onDelegate(cur, brain);
    }
    const remaining = items.length - 1;
    setItems((l) => l.slice(1));
    if (msg) onToast && onToast(msg, toastBrain);
    if (remaining <= 0) {
      setDone(true);
      setTimeout(() => { setFocus(false); setDone(false); }, 1900);
    }
  }

  function openThread(id) {
    setFocus(false);
    setDelOpen(false);
    onOpenThread && onOpenThread(id);
  }

  const cur = items[0];
  const next = items[1];
  const PRIMARY = { email: { act: "reply", label: "reply" }, ping: { act: "done", label: "looks good" }, calendar: { act: "done", label: "got it" } };
  const prim = cur ? (PRIMARY[cur.kind] || { act: "done", label: "done" }) : null;
  const cleared = totalRef.current - items.length;
  const pct = totalRef.current ? (cleared / totalRef.current) * 100 : 0;
  const needsYou = items.filter((i) => i.prio === "act").length;

  return (
    <div className="inbox-wrap">
      <div className="inbox-bar">
        <div className="inbox-count"><b>{items.length}</b> in your inbox{needsYou > 0 && <React.Fragment> · <b>{needsYou}</b> need you</React.Fragment>}</div>
        <button className="focus-start" onClick={startFocus} disabled={!items.length}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="3.4"></circle></svg>
          focus
        </button>
      </div>

      <div className="inbox-list">
        {items.map((it) => (
          <div key={it.id} className={"inbox-row" + (clearing === it.id ? " clearing" : "")} data-kind={it.kind}>
            <FbGlyph kind={it.kind} />
            <div className="ib-main">
              <div className="ib-title">
                {it.from && <span className="ib-from">{it.from} · </span>}{it.title}
              </div>
              <div className="ib-sub">{it.sub}</div>
            </div>
            {it.prio === "act" && <span className="ib-prio" title="needs you"></span>}
            {it.thread && (
              <button className="ib-thread" title="open thread" onClick={() => openThread(it.thread)}>{FB_THREAD_IC}</button>
            )}
            <span className="ib-time">{it.time}</span>
            <button className="ib-check" title="mark done" onClick={() => clearRow(it.id, "done ✦", "luna")}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12l5 5L20 6"></path></svg>
            </button>
          </div>
        ))}
        {items.length === 0 && <div className="map-empty" style={{ marginTop: 16 }}>inbox zero ✦ go make something</div>}
      </div>

      <div className="inbox-capture">
        <input
          className="capture-input"
          placeholder="capture a todo…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") capture(); }}
        />
        <button className="capture-add" onClick={capture} title="capture">+</button>
      </div>

      {focus && (
        <div className="focus-mode">
          <div className="focus-top">
            <span className="focus-count">{done ? "all clear" : `${Math.min(cleared + 1, totalRef.current)} of ${totalRef.current}`}</span>
            <button className="focus-exit" onClick={() => { setFocus(false); setDelOpen(false); }}>
              exit focus ✕
            </button>
          </div>
          <div className="focus-track"><i style={{ width: (done ? 100 : pct) + "%" }}></i></div>

          {done || !cur ? (
            <div className="focus-done">
              <div className="fd-orb"></div>
              <div className="fd-line">inbox zero ✦</div>
              <div className="fd-sub">nice. the studio feels lighter already.</div>
            </div>
          ) : (
            <div className="focus-card">
              <div className="focus-scroll">
                <span className="focus-kind">
                  {cur.brain ? <BrainBadge brain={cur.brain} /> : <React.Fragment><FbGlyph kind={cur.kind} /><span className="fk-label">{cur.kind}</span></React.Fragment>}
                  {cur.prio === "act" && <span className="fc-tag now">needs you</span>}
                  {cur.prio === "soon" && <span className="fc-tag soon">today</span>}
                </span>
                <div className="focus-q">{cur.title}</div>
                <div className="focus-lead" dangerouslySetInnerHTML={{ __html: cur.lead || cur.sub || "" }}></div>
                {cur.rich && <FbRichBody blocks={cur.rich} />}
                {cur.options && <FbChoiceCards options={cur.options} onPick={(name) => handle("choice", null, name)} />}
              </div>
              <div className="focus-actions">
                {!cur.options &&
                  <button className="fa-btn primary" onClick={() => handle(prim.act)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">{prim.act === "reply" ? <path d="M5 12h14M13 6l6 6-6 6"></path> : <path d="M4 12l5 5L20 6"></path>}</svg>
                    {prim.label}
                  </button>
                }
                {cur.thread && (
                  <button className="fa-btn" onClick={() => openThread(cur.thread)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12Z"></path></svg>
                    thread
                  </button>
                )}
                <button className="fa-btn" onClick={() => handle("snooze")}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="13" r="8"></circle><path d="M12 9v4l2 2M9 2h6"></path></svg>
                  snooze
                </button>
                <button className="fa-btn" onClick={() => setDelOpen((o) => !o)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12h12M11 6l6 6-6 6"></path><circle cx="20" cy="12" r="1.6"></circle></svg>
                  delegate
                </button>
                {delOpen && (
                  <div className="delegate-pop">
                    <div className="delegate-head">hand it to…</div>
                    {BRAIN_ORDER.map((k) => (
                      <button key={k} className="brain-opt" style={{ "--bo": "var(--brain-" + k + ")" }} onClick={() => handle("delegate", k)}>
                        <span className="bo-ic"><BrainIcon icon={BRAINS[k].icon} /></span>
                        <span style={{ flex: 1 }}>
                          <span className="bo-name">{BRAINS[k].name}</span>
                          <span className="bo-blurb">{BRAINS[k].blurb}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {next && !done && (
                <div className="fx-peek"><span className="pd"></span>next: <b>{next.from ? next.from + " — " : ""}{next.title}</b></div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
