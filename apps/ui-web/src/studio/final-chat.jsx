// final-chat.jsx — Luna's chat with the slide-out threads rail.
// The conversation layer slides right to reveal the rail beneath (the
// "Slide-out" threads concept), so every chat panel is also a thread switcher.
import React from "react";
import { THREAD_SECTIONS, THREAD_STATUS_LABEL } from "./final-threads.jsx";
import { BRAINS } from "./studio-data.jsx";
import { BrainPicker } from "./studio-brain.jsx";
import { SuggestedActionChips } from "./SuggestedActionChips.jsx";
import { Button, IconButton } from "./astryx-kit.tsx";
const TcReact = React;

export function ThreadChat({ threads, activeId, onSwitch, onNew, onAppend, onThreadNote, onSpawn, onVoice, onFocus, brain, setBrain, suggestedActions, onAcceptAction, onDismissAction }) {
  const { useState, useRef, useEffect } = TcReact;
  const [railOpen, setRailOpen] = useState(false);
  const [input, setInput] = useState("");
  const streamRef = useRef(null);
  const thread = threads.find((t) => t.id === activeId) || threads[0];
  // Typing dots show while an assistant turn is streaming but no text has
  // landed yet; once tokens arrive they render as a growing luna bubble.
  const lastIsLuna = thread && thread.msgs.length > 0 && thread.msgs[thread.msgs.length - 1].who === "luna";
  const typing = !!(thread && thread.awaiting && !lastIsLuna);

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread && thread.msgs.length, typing, activeId]);

  function send(textArg) {
    const text = (textArg ?? input).trim();
    if (!text || !thread || thread.awaiting) return;
    setInput("");
    // Real send: the user turn goes to the server; the assistant reply streams
    // back into `threads` via the reducer. No synthetic brain.
    onAppend(thread.id, { who: "user", text });
    window.dispatchEvent(new CustomEvent("luna:chirp"));
  }

  const chips = ["what needs me today?", "find rooftop bars for tonight", "make me a water tracker", "build the landing page"];

  if (!thread) {
    return (
      <div className="tc-stage">
        <div className="tc-main">
          <div className="chat-stream">
            <div className="msg luna">
              <div className="bubble"><span className="bubble-text">connecting to Luna…</span></div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tc-stage">
      {/* threads rail — sits underneath, revealed on slide */}
      <div className="tc-rail">
        <div className="tc-rail-top">
          <span className="h">threads</span>
          <IconButton
            className="tc-new"
            label="new thread"
            tooltip="new thread"
            icon="+"
            variant="ghost"
            onClick={() => { onNew(); setRailOpen(false); }}
          />
        </div>
        <div className="tc-list">
          {THREAD_SECTIONS.map((sec) => {
            const rows = threads.filter(sec.match);
            if (!rows.length) return null;
            return (
              <TcReact.Fragment key={sec.key}>
                <div className="tc-sec">{sec.label}</div>
                {rows.map((t) => (
                  <button key={t.id} className={"tc-row" + (t.id === activeId ? " active" : "")} style={{ "--tint": t.tint }}
                    onClick={() => { onSwitch(t.id); setRailOpen(false); }}>
                    <span className="tc-dot"></span>
                    <span className="tc-name">{t.name}</span>
                    {t.unread ? <span className="th-unread">{t.unread}</span> : <span className="tc-meta">{THREAD_STATUS_LABEL[t.status] || ""}</span>}
                  </button>
                ))}
              </TcReact.Fragment>
            );
          })}
        </div>
        <div className="tc-rail-foot">every side-quest keeps its own thread ✦</div>
      </div>

      {/* conversation layer — slides right to reveal the rail */}
      <div className={"tc-main" + (railOpen ? " open" : "")}>
        <IconButton
          className="tc-handle"
          label={railOpen ? "close threads" : "threads"}
          tooltip={railOpen ? "close threads" : "threads"}
          variant="ghost"
          icon={<svg width="9" height="12" viewBox="0 0 10 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 2l5 5-5 5"></path></svg>}
          onClick={() => setRailOpen((o) => !o)}
        />

        <div className="chat-stream" ref={streamRef}>
          {thread.msgs.map((m, i) => (
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

        <SuggestedActionChips actions={suggestedActions} onAccept={onAcceptAction} onDismiss={onDismissAction} />

        <div className="chip-row">
          {chips.map((c) => <Button className="chip" key={c} label={c} variant="ghost" onClick={() => send(c)} />)}
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
          <IconButton
            className="mic-btn"
            label="voice mode"
            tooltip="voice mode"
            variant="ghost"
            icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><path d="M12 18v3"></path></svg>}
            onClick={onVoice}
          />
          <Button className="send-btn" label="send" tooltip="send" onClick={() => send()}>✦</Button>
        </div>

        {railOpen && <div className="tc-scrim" onClick={() => setRailOpen(false)}></div>}
      </div>
    </div>
  );
}
