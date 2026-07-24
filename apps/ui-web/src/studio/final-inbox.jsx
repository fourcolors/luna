// final-inbox.jsx — the natural inbox: priority-ordered list + one-at-a-time
// Focus triage that opens each item in full, with thread links back to chat.
// Astryx-ified: focus-actions row (primary/thread/snooze) -> Astryx Button,
// mark-done/open-thread/capture/exit-focus icon controls -> Astryx
// IconButton, delegate popover -> Astryx DropdownMenu (same DropdownMenu +
// DropdownMenuItem shape studio-brain.jsx's BrainPicker already uses for
// "who should answer?" - this was the same hand-rolled "open state + no
// outside-click/Escape/focus-trap" popover pattern BrainPicker used to be,
// so swapping it in here is a real bug fix (light-dismiss + Escape +
// focus-trap now free), not just a paint job.
// Rich focus-card blocks (quote/detail/fig/callout/list/attach/thread/
// attendees) and the choice cards stay hand-rolled - Astryx has no primitive
// for this per-block-type sanitized-HTML rendering, and the choice cards'
// numbered-pick layout doesn't map onto SelectableCard without fighting
// studio.css. Do not add a second HTML-injection path here: any block that
// carries agent-authored HTML must keep going through safeHtml() below.
import React from "react";
import { BRAINS, BRAIN_ORDER } from "./studio-data.jsx";
import { BrainBadge, BrainIcon } from "./studio-brain.jsx";
import { Button, IconButton, DropdownMenu, DropdownMenuItem } from "./astryx-kit.tsx";
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

// which inbox items belong to a thread (mock-data demo links only — a real
// projected item's `thread` field, if any, would come from the agent).
const FB_THREAD_LINKS = { i3: "lisbon", i9: "residency" };
const FB_PRIO_ORD = { act: 0, soon: 1 };
function fbSeed(list) {
  return list
    .map((x) => ({ ...x, thread: x.thread ?? FB_THREAD_LINKS[x.id] }))
    .sort((a, b) => (FB_PRIO_ORD[a.prio] ?? 2) - (FB_PRIO_ORD[b.prio] ?? 2));
}

// Inbox blocks can carry agent-projected HTML that quotes ATTACKER-CONTROLLED
// third-party content (email bodies via connectors). Rendering it raw through
// dangerouslySetInnerHTML is stored XSS (`<img onerror=…>` fires). Sanitize to
// an inline-formatting allowlist, dropping every other tag + ALL attributes.
// DOMParser never executes scripts, so parsing untrusted input here is safe.
const SAFE_INLINE_TAGS = new Set(["B", "I", "EM", "STRONG", "U", "CODE", "SMALL", "BR", "SPAN"]);
function safeHtml(input) {
  if (typeof input !== "string" || input === "") return "";
  try {
    const doc = new DOMParser().parseFromString(input, "text/html");
    const scrub = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 1) {
          if (SAFE_INLINE_TAGS.has(child.tagName)) {
            for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name);
            scrub(child);
          } else {
            // Disallowed element (img/svg/script/a/…): flatten to its text.
            child.replaceWith(doc.createTextNode(child.textContent || ""));
          }
        } else if (child.nodeType === 8) {
          child.remove(); // comments
        }
      }
    };
    scrub(doc.body);
    return doc.body.innerHTML;
  } catch {
    return "";
  }
}

function FbRichBlock({ b }) {
  switch (b.t) {
    case "detail":
      return <div className="rc-detail">{b.rows.map((r, i) => <div className="rc-drow" key={i}><span className="dl">{r[0]}</span><span className="dv">{r[1]}</span></div>)}</div>;
    case "quote":
      return <div className="rc-quote">{b.who && <span className="qwho">{b.who}</span>}<span dangerouslySetInnerHTML={{ __html: safeHtml(b.html) }}></span></div>;
    case "fig":
      return <div className="rc-fig">{b.rows.map((r, i) => <div className={"rc-fig-row" + (r[2] ? " total" : "")} key={i}><span>{r[0]}</span><span className="v">{r[1]}</span></div>)}</div>;
    case "callout":
      return <div className="rc-callout"><span className="sp">✦</span><span dangerouslySetInnerHTML={{ __html: safeHtml(b.html) }}></span></div>;
    case "list":
      return <ul className="rc-list">{b.items.map((it, i) => <li key={i}><span className="bullet">✦</span><span dangerouslySetInnerHTML={{ __html: safeHtml(it) }}></span></li>)}</ul>;
    case "attach":
      return <div className="rc-attach">{FB_CLIP}<span className="an">{b.name}</span><span className="am">{b.meta}</span></div>;
    case "thread":
      return <div className="rc-thread">{b.msgs.map((m, i) => <div className="rc-msg" key={i}><span className="rw">{m.who}</span><span dangerouslySetInnerHTML={{ __html: safeHtml(m.html) }}></span></div>)}</div>;
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

// `itemsProp` is the P3 real-data seam (useLunaInbox). Demo seed data must not
// appear in the production Studio: null means no projection yet; [] means the
// connected accounts genuinely returned inbox-zero.
export function FinalInbox({ items: itemsProp, connected = true, projectionAvailable = true, loading = false, onDelegate, onToast, onOpenThread }) {
  const { useState, useRef, useEffect } = FbReact;
  const [items, setItems] = useState(() => fbSeed(itemsProp ?? []));
  const [draft, setDraft] = useState("");
  const [focus, setFocus] = useState(false);
  const [done, setDone] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [clearing, setClearing] = useState(null);
  const totalRef = useRef(0);
  const nextId = useRef(1);

  // Real projection arriving/refreshing (useLunaInbox): replace the working
  // list once per new batch, including a valid empty result. Only re-seeds on
  // an actual new array
  // (not every parent re-render), so in-flight local triage (done/snooze/
  // capture) isn't clobbered by an unrelated re-render.
  const lastItemsPropRef = useRef(itemsProp);
  useEffect(() => {
    if (itemsProp !== lastItemsPropRef.current) {
      lastItemsPropRef.current = itemsProp;
      setItems(fbSeed(itemsProp ?? []));
    }
  }, [itemsProp]);

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
        <Button
          className="focus-start"
          label="focus"
          icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="3.4"></circle></svg>}
          onClick={startFocus}
          isDisabled={!items.length}
        />
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
              <IconButton
                className="ib-thread"
                label="open thread"
                tooltip="open thread"
                variant="ghost"
                icon={FB_THREAD_IC}
                onClick={() => openThread(it.thread)}
              />
            )}
            <span className="ib-time">{it.time}</span>
            <IconButton
              className="ib-check"
              label="mark done"
              tooltip="mark done"
              variant="ghost"
              icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12l5 5L20 6"></path></svg>}
              onClick={() => clearRow(it.id, "done ✦", "luna")}
            />
          </div>
        ))}
        {items.length === 0 && (
          <div className="map-empty" style={{ marginTop: 16 }}>
            {loading
              ? "checking connected accounts…"
              : !connected
                ? "connect Luna to load your inbox"
                : !projectionAvailable
                  ? "connect an account in Settings to bring its inbox here"
                  : "inbox zero ✦ go make something"}
          </div>
        )}
      </div>

      <div className="inbox-capture">
        <input
          className="capture-input"
          placeholder="capture a todo…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") capture(); }}
        />
        <IconButton
          className="capture-add"
          label="capture"
          tooltip="capture"
          variant="ghost"
          icon="+"
          onClick={capture}
        />
      </div>

      {focus && (
        <div className="focus-mode">
          <div className="focus-top">
            <span className="focus-count">{done ? "all clear" : `${Math.min(cleared + 1, totalRef.current)} of ${totalRef.current}`}</span>
            <Button
              className="focus-exit"
              variant="ghost"
              label="exit focus"
              onClick={() => { setFocus(false); setDelOpen(false); }}
            >
              exit focus ✕
            </Button>
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
                <div className="focus-lead" dangerouslySetInnerHTML={{ __html: safeHtml(cur.lead || cur.sub || "") }}></div>
                {cur.rich && <FbRichBody blocks={cur.rich} />}
                {cur.options && <FbChoiceCards options={cur.options} onPick={(name) => handle("choice", null, name)} />}
              </div>
              <div className="focus-actions">
                {!cur.options &&
                  <Button
                    className="fa-btn primary"
                    variant="primary"
                    label={prim.label}
                    icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">{prim.act === "reply" ? <path d="M5 12h14M13 6l6 6-6 6"></path> : <path d="M4 12l5 5L20 6"></path>}</svg>}
                    onClick={() => handle(prim.act)}
                  />
                }
                {cur.thread && (
                  <Button
                    className="fa-btn"
                    variant="ghost"
                    label="thread"
                    icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12Z"></path></svg>}
                    onClick={() => openThread(cur.thread)}
                  />
                )}
                <Button
                  className="fa-btn"
                  variant="ghost"
                  label="snooze"
                  icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="13" r="8"></circle><path d="M12 9v4l2 2M9 2h6"></path></svg>}
                  onClick={() => handle("snooze")}
                />
                {/* Was hand-rolled: local open state + a manual toggle with no
                    outside-click/Escape handling (only closed by re-toggling
                    the button). Astryx's DropdownMenu owns light-dismiss +
                    Escape + focus-trap internally, same fix already applied to
                    BrainPicker's "who should answer?" menu in
                    studio-brain.jsx - this is that same menu shape, just
                    action items instead of a radio group. */}
                <DropdownMenu
                  button={{
                    className: "fa-btn",
                    variant: "ghost",
                    label: "delegate",
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12h12M11 6l6 6-6 6"></path><circle cx="20" cy="12" r="1.6"></circle></svg>,
                  }}
                  isMenuOpen={delOpen}
                  onOpenChange={setDelOpen}
                  placement="above"
                  data-testid="delegate-menu"
                >
                  {BRAIN_ORDER.map((k) => (
                    <DropdownMenuItem
                      key={k}
                      icon={<BrainIcon icon={BRAINS[k].icon} />}
                      label={BRAINS[k].name}
                      description={BRAINS[k].blurb}
                      onClick={() => handle("delegate", k)}
                    />
                  ))}
                </DropdownMenu>
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
