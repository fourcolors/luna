// studio-map.jsx — painterly city explorer. Pins → cards → "add to today".
import React from "react";
import { Card, Button } from "./astryx-kit.tsx";
import { PLACES_SEED, PLACE_KINDS } from "./studio-data.jsx";

const MpReact = React;

const PLACE_ICONS = {
  food: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3v7a2 2 0 0 0 4 0V3M7 10v11M17 3c-1.5 0-2.5 2-2.5 5s1 4 2.5 4 2.5-1 2.5-4-1-5-2.5-5ZM17 16v5"></path></svg>,
  culture: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9a2 2 0 0 0 2-2V6h14v1a2 2 0 0 0 0 4v1H5v-1a2 2 0 0 0-2-2Z"></path><path d="M5 12v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"></path></svg>,
  outdoors: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 6 11h3l-4 6h6v5h2v-5h6l-4-6h3Z"></path></svg>,
  nightlife: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4h14l-7 8zM12 12v8M8 20h8"></path></svg>,
};

function MapApp({ onToast }) {
  const { useState } = MpReact;
  const [sel, setSel] = useState(null);
  const [added, setAdded] = useState({});
  const place = PLACES_SEED.find((p) => p.id === sel);
  const kind = place ? PLACE_KINDS[place.kind] : null;

  function addToToday(p) {
    setAdded((a) => ({ ...a, [p.id]: true }));
    window.dispatchEvent(new CustomEvent("studio:capture", {
      detail: { title: p.name, sub: p.note, kind: "todo" },
    }));
    onToast && onToast("added to Today ✦", "luna");
  }

  return (
    <div className="map-wrap">
      <div className="map-canvas">
        <div className="map-park"></div>
        <div className="map-water"></div>
        <svg className="map-roads" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d="M2 38 Q30 32 52 46 T98 50"></path>
          <path d="M20 4 Q26 40 40 60 T58 98"></path>
          <path className="thin" d="M2 70 Q40 64 70 78 T99 74"></path>
          <path className="thin" d="M66 2 Q60 30 78 48 T86 96"></path>
        </svg>
        {PLACES_SEED.map((p) => (
          <button
            key={p.id}
            className={"map-pin" + (sel === p.id ? " active" : "")}
            style={{ left: p.x + "%", top: p.y + "%", "--pin-wash": PLACE_KINDS[p.kind].wash }}
            onClick={() => setSel(p.id === sel ? null : p.id)}
            title={p.name}
          >
            <span className="map-pin-label">{p.name}</span>
            <span className="map-pin-dot">{PLACE_ICONS[p.kind]}</span>
            <span className="map-pin-tail"></span>
          </button>
        ))}
      </div>

      {place ? (
        <Card className="map-card" variant="transparent" padding={0} style={{ "--pin-wash": kind.wash }}>
          <div className="map-card-thumb"></div>
          <div className="map-card-body">
            <div className="map-card-kind">{kind.label}</div>
            <div className="map-card-name">{place.name}</div>
            <div className="map-card-note">{place.note}</div>
            <Button
              className="map-card-add"
              variant="secondary"
              size="sm"
              label={added[place.id] ? "✓ in Today" : "add to Today"}
              icon={added[place.id] ? undefined : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14"></path></svg>
              )}
              isDisabled={added[place.id]}
              onClick={() => addToToday(place)}
            />
          </div>
        </Card>
      ) : (
        <div className="map-empty">tap a pin — Luna pinned a few things for tonight ✦</div>
      )}
    </div>
  );
}

export { MapApp };
