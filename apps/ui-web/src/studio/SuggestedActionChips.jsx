// SuggestedActionChips.jsx — Luna proposes an action inline in the chat ->
// a single chip with Accept/Dismiss, in the design's chip-row visual
// language. REAL data only: actions are server-pushed (suggested-action-set
// / -update), never the design's canned prompt chips (those stay separate,
// rendered by ThreadChat itself).
//
// Only the NEWEST non-terminal action for the active thread is shown (one
// chip at a time keeps the composer calm — the full history lives in a
// future Actions panel). "Non-terminal" = proposed | accepted | in_progress;
// completed/failed/dismissed actions drop out of view here (their outcome
// surfaces via the existing result-delivered toast).
//
// Gracefully handles a row stuck at "accepted" (scheduler-V2 off, so it never
// advances to in_progress/completed): once accepted the chip settles into a
// quiet "queued" state with no buttons and no spinner that implies progress
// that isn't happening.
import React from "react";

function newestOpenAction(actions) {
  let best = null;
  for (const a of actions) {
    if (a.status !== "proposed" && a.status !== "accepted" && a.status !== "in_progress") continue;
    if (!best || a.createdAt > best.createdAt) best = a;
  }
  return best;
}

export function SuggestedActionChips({ actions, onAccept, onDismiss }) {
  const action = newestOpenAction(actions || []);
  if (!action) return null;

  const busy = action.status !== "proposed";

  return (
    <div className="sa-chip-row">
      <div className={"sa-chip" + (busy ? " settled" : "")}>
        <span className="sa-chip-title" title={action.detail || action.title}>{action.title}</span>
        {action.status === "proposed" && (
          <span className="sa-chip-actions">
            <button type="button" className="sa-chip-btn accept" onClick={() => onAccept(action.id)}>accept</button>
            <button type="button" className="sa-chip-btn dismiss" onClick={() => onDismiss(action.id)}>dismiss</button>
          </span>
        )}
        {action.status === "accepted" && <span className="sa-chip-badge">queued ✦</span>}
        {action.status === "in_progress" && <span className="sa-chip-badge">running…</span>}
      </div>
    </div>
  );
}
