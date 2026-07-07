// studio-data.jsx — brains, workspace/inbox/place/task seed data, and the
// "describe it → Luna paints a widget" compiler. Pure data + helpers; no JSX.

/* ---------------- brains (harnesses) ---------------- */
// Each panel can be powered by a "brain". Luna is the house companion; Hermes
// is the swift research/messenger agent; OpenClaw is the heavy compute / dev /
// computer-use harness. Colors are defined as --brain-* vars in studio.css.
export const BRAINS = {
  luna: {
    key: "luna",
    name: "Luna",
    icon: "luna",
    blurb: "your companion — warm, quick, always here",
    tag: "companion",
  },
  hermes: {
    key: "hermes",
    name: "Hermes",
    icon: "hermes",
    blurb: "swift research & messages",
    tag: "research",
  },
  openclaw: {
    key: "openclaw",
    name: "OpenClaw",
    icon: "claw",
    blurb: "heavy compute — browses, builds, runs",
    tag: "compute",
  },
};
export const BRAIN_ORDER = ["luna", "hermes", "openclaw"];

/* ---------------- inbox seed (Today) ---------------- */
// Each item can carry a `lead` (rich intro) + `rich` blocks + `options` (choice
// cards) so Focus can open it "in full", and `prio` for the needs-you tag.
export const INBOX_SEED = [
  { id: "i1", kind: "email", from: "Priya", title: "Re: studio launch — can we move the date?", sub: "…thinking the 14th gives us room to breathe", time: "9:02a", prio: "act",
    lead: "<b>Priya</b> · to you · Studio",
    rich: [
      { t: "quote", who: "Priya wrote", html: "Hey — thinking the 14th gives us room to breathe before launch. The watercolor set still needs one more pass and I'd rather not rush it. Does moving a week work on your end?" },
      { t: "detail", rows: [["Proposed", "Tue, Apr 14"], ["Current", "Tue, Apr 7"], ["Impact", "launch + 1 week"]] },
    ] },
  { id: "i2", kind: "todo", title: "Send Mateo the watercolor exports", sub: "he's blocked on the deck", time: "today",
    lead: "He's blocked on the deck until these land.",
    rich: [ { t: "attach", name: "watercolor-set-v3.zip", meta: "18 PNGs · 24 MB" } ] },
  { id: "i3", kind: "ping", from: "OpenClaw", brain: "openclaw", title: "Flight search is done — pick one?", sub: "3 options under €400 · wants a pick", time: "8:47a", prio: "act",
    lead: "Three under <b>€400</b> for Apr 12 — all refundable, all morning departures.",
    options: [
      { name: "TAP · 09:10", meta: "€312 · direct · 2h45" },
      { name: "Vueling · 11:40", meta: "€286 · direct · 2h50" },
      { name: "ITA · 07:25", meta: "€344 · 1 stop · roomier seat" },
    ] },
  { id: "i4", kind: "email", from: "The Roxy", title: "Your matinee tickets for Saturday", sub: "2 seats held · row F", time: "8:30a",
    lead: "<b>The Roxy</b> · tickets · Saturday",
    rich: [
      { t: "detail", rows: [["Show", "2:00 PM matinee"], ["Seats", "Row F · 14–15"], ["Doors", "1:30 PM"]] },
      { t: "callout", html: "Held under your name — just show this at the door ✦" },
    ] },
  { id: "i5", kind: "todo", title: "Water the studio plants 🌿", sub: "the fern is dramatic again", time: "today",
    lead: "The fern is being dramatic again." },
  { id: "i6", kind: "calendar", title: "Coffee with Dana", sub: "11:00a · the corner place", time: "11:00a", prio: "soon",
    lead: "Starts at <b>11:00</b> · the corner place",
    rich: [
      { t: "detail", rows: [["Where", "Corner Coffee · 4 min walk"], ["Bring", "the residency contract"]] },
      { t: "attendees", label: "you + Dana", names: ["You", "Dana"], colors: ["var(--wash-2)", "var(--wash-0)"] },
    ] },
  { id: "i7", kind: "email", from: "Stripe", title: "Your payout is on the way", sub: "$2,480 arriving Thursday", time: "Yest",
    lead: "<b>Stripe</b> · payouts",
    rich: [ { t: "fig", rows: [["Amount", "$2,480"], ["Arrives", "Thursday"], ["To account", "•• 4291", true]] } ] },
  { id: "i8", kind: "ping", from: "Hermes", brain: "hermes", title: "Tide-pool digest is ready", sub: "12 sources · 3 themes", time: "Yest",
    lead: "Three themes across the 12 — saved to your reading shelf.",
    rich: [
      { t: "list", items: ["Tides set the whole clock — go at low tide", "Six creatures worth knowing by name", "Best window this week: <b>Thu 4:10 PM</b>"] },
      { t: "callout", html: "Want me to turn this into a one-page guide?" },
    ] },
  { id: "i9", kind: "todo", title: "Reply to the residency invite", sub: "they need an answer by Friday", time: "Fri", prio: "soon",
    lead: "They need an answer by <b>Friday</b>. How should we respond?",
    options: [
      { name: "Accept", meta: "I'm in — send the yes" },
      { name: "Ask for time", meta: "love it, need a week to decide" },
      { name: "Decline", meta: "not this season" },
    ] },
];

/* ---------------- city places (The City) ---------------- */
// x / y are percentages on the painterly map canvas.
export const PLACES_SEED = [
  { id: "p1", name: "Cloudline Rooftop", kind: "nightlife", note: "open till 1 · skyline + low jazz", x: 30, y: 26 },
  { id: "p2", name: "The Roxy", kind: "culture", note: "matinee at 2 · old velvet seats", x: 62, y: 34 },
  { id: "p3", name: "Fourth St. Ramen", kind: "food", note: "12 min walk · usually a line by 7", x: 47, y: 58 },
  { id: "p4", name: "Tide Pool Walk", kind: "outdoors", note: "low tide 4:10p · bring the good shoes", x: 76, y: 66 },
  { id: "p5", name: "Marrow & Vine", kind: "food", note: "natural wine · they know Dana", x: 22, y: 62 },
  { id: "p6", name: "Glasshouse Gallery", kind: "culture", note: "new ceramics show · free Thursdays", x: 68, y: 16 },
];
export const PLACE_KINDS = {
  food: { label: "eat", wash: "var(--wash-1)" },
  culture: { label: "see", wash: "var(--wash-3)" },
  outdoors: { label: "roam", wash: "var(--wash-4)" },
  nightlife: { label: "night", wash: "var(--wash-0)" },
};

/* ---------------- task definitions (Build / spawned) ---------------- */
// Steps stream by elapsed time so a task keeps "running" even when its
// workspace isn't on screen. dur = total seconds.
export const TASK_DEFS = {
  flights: {
    variant: "computer",
    brain: "openclaw",
    title: "rooftop tables",
    target: "maps.studio.city",
    dur: 38,
    result: "3 rooftop tables held for tonight. Cloudline at 7:30 is my favorite — tap to lock it in.",
    steps: [
      { at: 0, label: "opening the city map", view: "maps.studio.city", act: "loading neighborhoods…" },
      { at: 6, label: "searching rooftop bars", view: "maps · search", act: "typing “rooftop · open late”" },
      { at: 14, label: "reading tonight's hours", view: "Cloudline Rooftop", act: "checking 7–9pm availability" },
      { at: 22, label: "cross-checking reviews", view: "reviews · 4.6★", act: "skimming the last 20 reviews" },
      { at: 30, label: "holding a table at 7:30", view: "booking · party of 2", act: "confirming the hold…" },
      { at: 37, label: "3 options ready for you", view: "done", act: "passing them to Luna ✦" },
    ],
  },
  landing: {
    variant: "dev",
    brain: "hermes",
    title: "studio site",
    target: "~/studio-site",
    dur: 44,
    result: "Landing page is live at studio-site.local — want me to open a preview?",
    steps: [
      { at: 0, label: "reading the brief", line: "$ luna read brief.md  → 2 sections, watercolor mood" },
      { at: 7, label: "scaffolding the project", line: "$ npm create studio@latest  ✓ 214 files" },
      { at: 16, label: "writing the hero", line: "+ Hero.jsx   “paint your day, then let it run.”" },
      { at: 25, label: "styling with the palette", line: "+ theme.css   --accent, --wash-0…4 wired" },
      { at: 33, label: "running tests", line: "$ npm test   ✓ 18 passed  (1.2s)" },
      { at: 41, label: "preview is live", line: "▲ ready at studio-site.local — want a look?" },
    ],
  },
  research: {
    variant: "dev",
    brain: "hermes",
    title: "tide-pool digest",
    target: "12 sources",
    dur: 30,
    result: "Digest saved to your reading shelf — 6 citations, ~340 words. Two themes you'll like.",
    steps: [
      { at: 0, label: "gathering sources", line: "$ hermes fetch  → 12 articles queued" },
      { at: 6, label: "reading in parallel", line: "reading 12 · highlighting as I go" },
      { at: 14, label: "clustering themes", line: "3 themes: tides, creatures, timing" },
      { at: 22, label: "writing the digest", line: "+ digest.md  ~340 words, 6 citations" },
      { at: 28, label: "digest ready", line: "done — saved to your reading shelf" },
    ],
  },
};

/* ===================================================================
   describe → widget compiler
   Turns a free-text request into a real, interactive widget spec.
   =================================================================== */
function _firstNumber(s, fallback) {
  const m = s.replace(/,/g, "").match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : fallback;
}
function _titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
// pull a short label out of a request like "a widget to track my water intake"
function _labelFrom(text, fallback) {
  let s = " " + text.toLowerCase() + " ";
  s = s.replace(/\b(make|build|paint|create|give|get|add|me|a|an|the|please|widget|panel|tool|tracker|to|that|for|my|of|some|can you|could you|i want|i'd like|i need)\b/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return fallback;
  // keep it short
  s = s.split(" ").slice(0, 4).join(" ");
  return _titleCase(s);
}
function _listItems(text) {
  // items after a colon / "with" / "for", split on commas + "and"
  const m = text.match(/(?:with|for|:|of)\s+(.+)$/i);
  if (!m) return null;
  const raw = m[1].replace(/\band\b/gi, ",").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  const items = raw.map((x) => _titleCase(x)).slice(0, 6);
  return items.length ? items : null;
}

export function describeToWidget(text) {
  const s = text.toLowerCase();

  // counters: water, cups, steps, reps, coffee, glasses…
  if (/\b(water|cups?|glass(es)?|hydrat|drink|coffee|steps?|reps?|push[\s-]?ups?|pages?|count|tally|intake)\b/.test(s)) {
    let unit = "today";
    if (/water|cups?|glass|hydrat|drink/.test(s)) unit = "cups";
    else if (/coffee/.test(s)) unit = "cups";
    else if (/steps?/.test(s)) unit = "steps";
    else if (/reps?|push/.test(s)) unit = "reps";
    else if (/pages?/.test(s)) unit = "pages";
    const goal = _firstNumber(s, unit === "steps" ? 8000 : 8);
    let label = "Water";
    if (/coffee/.test(s)) label = "Coffee";
    else if (/steps?/.test(s)) label = "Steps";
    else if (/reps?|push/.test(s)) label = "Reps";
    else if (/pages?/.test(s)) label = "Pages read";
    else if (/water|cups?|glass|hydrat|drink|intake/.test(s)) label = "Water";
    else label = _labelFrom(text, "Counter");
    return { kind: "counter", title: label.toLowerCase(), props: { label, unit, goal, value: 0 } };
  }

  // countdown: days until, countdown to, launch, trip, deadline
  if (/\b(countdown|days? until|days? till|until|count down|launch|deadline|trip|vacation|wedding|due)\b/.test(s)) {
    const days = _firstNumber(s, 30);
    const label = _labelFrom(text.replace(/\b(countdown|days?|until|till|to)\b/gi, " "), "The big day");
    return { kind: "countdown", title: "countdown", props: { label: label || "The big day", days: Math.round(days) } };
  }

  // money / budget / savings goal
  if (/\b(budget|save|saving|savings|spend|money|goal|fund|\$|dollars?)\b/.test(s)) {
    const goal = _firstNumber(s.replace(/\b(of|out)\b/g, ""), 1000);
    const label = _labelFrom(text, "Savings");
    return { kind: "gauge", title: "goal", props: { label: label || "Savings", value: Math.round(goal * 0.35), goal: Math.round(goal), unit: "$" } };
  }

  // mood / journal / check-in
  if (/\b(mood|feeling|feel|journal|check[\s-]?in|energy|vibe)\b/.test(s)) {
    const label = _labelFrom(text, "How are you?");
    return { kind: "mood", title: "check-in", props: { label: label && label.length < 18 ? label : "How are you?" } };
  }

  // checklist / list / todo / groceries / packing
  if (/\b(checklist|list|todo|to-do|groceries|grocery|packing|pack|shopping|errands?|tasks?)\b/.test(s)) {
    const items = _listItems(text) || [];
    const label = _labelFrom(text.replace(/\bwith\b.*$/i, ""), "Checklist");
    return { kind: "checklist", title: "list", props: { label: label || "Checklist", items } };
  }

  // habit / streak
  if (/\b(habit|streak|every ?day|daily)\b/.test(s)) {
    const label = _labelFrom(text, "New habit");
    return { kind: "habit", title: "habit", props: { label: label || "New habit" } };
  }

  // fallback — a soft stat / focus card
  const label = _labelFrom(text, "New widget");
  return { kind: "stat", title: "widget", props: { label: label || "New widget", note: text } };
}
