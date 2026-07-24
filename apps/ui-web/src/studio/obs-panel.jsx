// obs-panel.jsx — Luna Studio observability panel: kind chips, drop banner,
// meta line, and the streaming event log.
//
// React port of packages/ui-shared-solid/src/{ObsPanel,EventRow}.tsx (which
// themselves ported the original apps/ui-web/src/App.tsx ObsPanel/EventRow +
// filter-state wiring at App.tsx L406-421: allKinds/filtered/toggleKind).
//
// Unlike the Solid version (which took selectedKinds/toggleKind/clearKinds as
// props from the owning App), this panel OWNS its filter state: Studio's
// final-app has no parent store for it, so selectedKinds lives here as a
// plain useState<Set<string>>. Everything else — data in, no frames out — is
// a pure client-side view over ctx.state; it renders empty until connected
// and needs no capability gate.
//
// Astryx conversion notes:
// - Kind chips -> ToggleButtonGroup (type="multiple") + ToggleButton, which
//   gives real aria-pressed group semantics for free (the old hand-rolled
//   <button className="obs-chip"> row had none) while keeping the exact same
//   multi-select toggle behavior. "clear" stays a plain Button (it isn't a
//   toggle - it's a one-shot action that empties the selection).
// - Drop-count notice -> Banner (status="warning"), the direct equivalent of
//   the old hand-rolled `.obs-banner.drop` div.
// - EventRow's click-to-expand is intentionally left as hand-rolled markup,
//   not Astryx's Collapsible: Collapsible enforces a trigger+content split
//   with its own chevron button, which would require re-plumbing the shared
//   `.obs-row-event` CSS grid (devops-panels.css, also consumed by
//   skills-panel.jsx) rather than a clean drop-in. Instead this port adds the
//   missing accessibility semantics (role="button", aria-expanded, keyboard
//   activation) directly, preserving the exact whole-row-clickable behavior.
//   redactSecrets() -> JSON.stringify remains untouched either way.
import React, { useCallback, useMemo, useState } from "react";
import { filterEvents, formatVal } from "@luna/ui-shared/core";
import { Button, ToggleButton, ToggleButtonGroup, Banner } from "./astryx-kit.tsx";

// Defense-in-depth: ObsEvent's `[key: string]: unknown` index signature means
// a future event kind could carry a credential-shaped field. Nothing in the
// current wire shape does, but per project rule ("never render secret
// values") we redact anything that *looks* like one before it ever reaches
// JSON.stringify or the summary preview, rather than trusting the server.
const SECRET_KEY_RE = /token|secret|password|passwd|authoriz|api[-_]?key|credential/i;
const REDACTED = "••••";

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactSecrets(v);
    }
    return out;
  }
  return value;
}

/**
 * Single ObsEvent row in the event log. Click toggles a JSON-formatted
 * detail view. Summary line previews up to three non-meta keys via
 * formatVal, same as the Solid original.
 */
export function EventRow({ event }) {
  const [open, setOpen] = useState(false);

  const summary = useMemo(() => {
    const { ts, kind, level, ...rest } = event;
    void ts;
    void kind;
    void level;
    const keys = Object.keys(rest).slice(0, 3);
    const preview = keys
      .map((k) => `${k}=${formatVal(SECRET_KEY_RE.test(k) ? REDACTED : rest[k])}`)
      .join(" ");
    return preview || event.kind;
  }, [event]);

  const toggle = useCallback(() => setOpen((o) => !o), []);

  return (
    <div
      className={`obs-row-event level-${event.level}`}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <span className="obs-ts">{event.ts.slice(11, 23)}</span>
      <span className={`obs-kind kind-${event.kind}`}>{event.kind}</span>
      <span className="obs-summary">{summary}</span>
      {open && (
        <pre className="obs-json">
          {JSON.stringify(redactSecrets(event), null, 2)}
        </pre>
      )}
    </div>
  );
}

/**
 * ObsPanel — kind chips, drop banner, meta line, and the event log.
 *
 * Props are plain data read off ctx.state (see integration spec); this
 * component computes allKinds/filtered/toggleKind/clearKinds itself instead
 * of receiving them, since Studio has no parent store to hold them.
 */
export function ObsPanel({
  events,
  seenKinds,
  advertisedKinds,
  lastDrop,
  droppedTotal,
  lastPingAt,
}) {
  const [selectedKinds, setSelectedKinds] = useState(() => new Set());

  const allKinds = useMemo(() => {
    const set = new Set(advertisedKinds || []);
    for (const k of seenKinds || []) set.add(k);
    return Array.from(set).sort();
  }, [advertisedKinds, seenKinds]);

  const filtered = useMemo(
    () => filterEvents(events || [], selectedKinds),
    [events, selectedKinds],
  );

  // ToggleButtonGroup (type="multiple") is controlled via a string[], while
  // the rest of this panel (and filterEvents) works off a Set<string> - kept
  // as the source of truth since it's what the original component used and
  // what toggleKind/allKinds.includes checks are cheapest against.
  const selectedKindsList = useMemo(() => Array.from(selectedKinds), [selectedKinds]);

  const onSelectedKindsChange = useCallback((next) => {
    setSelectedKinds(new Set(next));
  }, []);

  const clearKinds = useCallback(() => setSelectedKinds(new Set()), []);

  const totalEvents = (events || []).length;

  return (
    <div className="obs-panel">
      <div className="obs-topbar">
        <div className="obs-row obs-chips">
          {allKinds.length === 0 && (
            <span className="obs-muted">no kinds yet — connect to see events</span>
          )}
          {allKinds.length > 0 && (
            <ToggleButtonGroup
              type="multiple"
              label="Filter by event kind"
              size="sm"
              value={selectedKindsList}
              onChange={onSelectedKindsChange}
            >
              {allKinds.map((k) => (
                <ToggleButton key={k} value={k} label={k} />
              ))}
            </ToggleButtonGroup>
          )}
          {selectedKinds.size > 0 && (
            <Button label="clear" variant="ghost" size="sm" clickAction={clearKinds} />
          )}
        </div>
        {lastDrop && (
          <Banner
            status="warning"
            title={`Dropped ${droppedTotal} event(s) total`}
            description={`most recent burst: ${lastDrop.n} since ${lastDrop.since}`}
          />
        )}
      </div>
      <main className="obs-log">
        <div className="obs-meta">
          {filtered.length} / {totalEvents} event(s) shown
          {lastPingAt && <span className="obs-muted"> · last ping {lastPingAt}</span>}
        </div>
        {filtered.map((ev, i) => (
          <EventRow key={`${ev.ts}_${ev.kind}_${i}`} event={ev} />
        ))}
      </main>
    </div>
  );
}

export default ObsPanel;
