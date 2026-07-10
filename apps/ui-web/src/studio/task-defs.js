function shortTaskName(text, n = 5) {
  return text.replace(/^(please\s+)?(can you|could you|would you|hey luna,?|luna,?|i want to|i'd like to|i need to|go|now)\s*/i, "")
    .replace(/[.?!]+$/, "").trim().split(/\s+/).slice(0, n).join(" ");
}

export function makeTaskDef(variant, text, brain) {
  const ask = shortTaskName(text, 7) || "the task";
  if (variant === "computer") {
    return {
      variant: "computer", brain, title: ask, target: "web · live session", dur: 34,
      result: "Done ✦ — I lined up the options. Pick one and I'll take it the rest of the way.",
      steps: [
        { at: 0, label: "opening a browser", view: "new session", act: "warming up the page…" },
        { at: 6, label: "searching the web", view: "search", act: "“" + ask + "”" },
        { at: 13, label: "reading the top results", view: "results · 1–10", act: "skimming for the good ones" },
        { at: 20, label: "comparing options", view: "compare", act: "weighing price · timing · vibe" },
        { at: 28, label: "preparing a shortlist", view: "shortlist", act: "writing it up for you" },
        { at: 33, label: "ready for your pick", view: "done", act: "passing it back ✦" },
      ],
    };
  }
  if (variant === "research") {
    return {
      variant: "dev", brain, title: ask, target: "the web", dur: 28,
      result: "Digest is ready — saved to your reading shelf with citations.",
      steps: [
        { at: 0, label: "gathering sources", line: "$ fetch  → queueing sources for “" + ask + "”" },
        { at: 6, label: "reading in parallel", line: "reading · highlighting as I go" },
        { at: 13, label: "clustering themes", line: "grouping findings into themes" },
        { at: 20, label: "writing the digest", line: "+ digest.md   citations attached" },
        { at: 26, label: "digest ready", line: "done — saved to your shelf" },
      ],
    };
  }
  return {
    variant: "dev", brain, title: ask, target: "~/project", dur: 38,
    result: "Build's done and the preview is live — want me to open it?",
    steps: [
      { at: 0, label: "reading the ask", line: "$ read  → “" + ask + "”" },
      { at: 7, label: "scaffolding", line: "$ create project  ✓ files ready" },
      { at: 15, label: "writing the code", line: "+ writing components…" },
      { at: 24, label: "styling", line: "+ wiring the studio palette" },
      { at: 31, label: "running tests", line: "$ test   ✓ passing" },
      { at: 36, label: "preview is live", line: "▲ ready — want a look?" },
    ],
  };
}

export function taskDefFromDelegation(brain, title) {
  const variant = brain === "openclaw" ? "computer" : brain === "hermes" ? "research" : "dev";
  return makeTaskDef(variant, title, brain);
}
