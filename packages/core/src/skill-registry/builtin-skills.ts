/**
 * Built-in skill seeds — the in-repo half of the skill catalog.
 *
 * These ship with Luna and load into the SkillRegistry at boot
 * (`SkillRegistry.layer({ seeds: BUILTIN_SKILLS })`). User-authored skills
 * (`~/.luna/skills/<id>/SKILL.md`) join them at decorate-time with
 * source:"user".
 *
 * Authoring rules:
 *   - `description` is ONE sentence — it powers settings search and the
 *     index line the agent sees, so make it discriminating.
 *   - `whenToUse` is the trigger hint; write it for the agent, not the UI.
 *   - Bodies are plain prompt text. Nothing operator-specific, nothing
 *     deployment-specific — this file is public.
 */
import type { SkillManifest } from "./skill-registry.js"

export const BUILTIN_SKILLS: ReadonlyArray<SkillManifest> = [
  {
    id: "clear-writing",
    name: "Clear Writing",
    description: "Strunk-style rules for writing prose that is clear, direct, and short.",
    whenToUse:
      "Writing anything a human will read — summaries, documents, messages, reports, explanations.",
    category: "writing",
    tags: ["writing", "style", "editing"],
    source: "builtin",
    body: [
      "Write plainly. These rules outrank stylistic flourish:",
      "",
      "1. Omit needless words. Every word must earn its place; cut hedges (\"quite\", \"very\", \"in order to\"), throat-clearing openers, and restatements.",
      "2. Use the active voice. \"The job failed because X\" — not \"it was found that a failure had occurred\".",
      "3. Put statements in positive form. Say what something IS, not a list of what it isn't.",
      "4. Use concrete language. Numbers, names, file paths, and dates beat abstractions.",
      "5. One idea per paragraph; lead with it. The reader should get the point from the first sentence alone.",
      "6. Keep parallel ideas in parallel form — especially in lists.",
      "7. Place the emphatic word at the end of the sentence.",
      "8. Revise: after drafting, reread once solely to delete.",
      "",
      "When summarizing for the operator: lead with the outcome, keep supporting detail after it, and never bury a decision they need to make.",
    ].join("\n"),
  },
  {
    id: "luna-self-inspection",
    name: "Self Inspection",
    description: "How to answer questions about Luna's own history, jobs, memory, and usage from its state stores.",
    whenToUse:
      "The operator asks what Luna has done, scheduled, remembered, or spent — anything answerable from Luna's own databases and logs.",
    category: "data",
    tags: ["introspection", "sqlite", "duckdb", "jobs", "memory"],
    source: "builtin",
    body: [
      "Luna's state lives in well-defined stores (SYSTEM.md is the authoritative map). Answer self-inspection questions from the right store, read-only:",
      "",
      "- Scheduled jobs and their history → `jobs` and `job_runs` tables in luna.db.",
      "- Cross-workspace registry → `workspaces` table in luna.db; each workspace's own facts → its `.workspace/workspace.db`.",
      "- Behavioral self-reports → `agent_notes` in luna.db.",
      "- Operator identity and durable facts → global memory (use the memory MCP tools, not raw SQL).",
      "- Session/tool usage and cost telemetry → analytics.duckdb and events.jsonl.",
      "",
      "Discipline:",
      "1. Prefer the purpose-built MCP tools (memory, scheduler, obs) over raw SQL — they encode the write rules.",
      "2. When raw SQL is the right read, use the local shell with a read-only query; never INSERT/UPDATE/DELETE a table a service owns.",
      "3. Quote what you found (counts, timestamps, ids) rather than characterizing it; if a store is missing or empty, say so plainly.",
    ].join("\n"),
  },
  {
    id: "deep-research-discipline",
    name: "Deep Research Discipline",
    description: "A verification-first method for open-ended research questions: decompose, source widely, verify load-bearing claims, cite.",
    whenToUse:
      "Open-ended research requests where the answer must be trustworthy — comparisons, state-of-the-art surveys, decisions with consequences.",
    category: "workflow",
    tags: ["research", "verification", "citations"],
    source: "builtin",
    body: [
      "Research is verification, not collection. Method:",
      "",
      "1. Decompose the question into the claims that would settle it. Note which are load-bearing (the answer flips if they're wrong).",
      "2. Search wide before deep: multiple independent sources, different vantage points (official docs, practitioner reports, primary data). One source family is one source.",
      "3. Date everything. A true-in-2024 claim may be false now; prefer the newest primary source and say when it was published.",
      "4. Verify every load-bearing claim against at least two independent sources, or label it explicitly as single-sourced.",
      "5. Separate fact from inference in the write-up; attach the citation to the claim it supports, not in a pile at the end.",
      "6. Deliver: the answer first, the evidence after, the uncertainties last — including what you could NOT verify.",
    ].join("\n"),
  },
  {
    id: "screenshot-intake",
    name: "Screenshot Intake",
    description: "Keep every image the operator sends as a durable, reviewable record: copy it out of the temporary upload folder into a workspace, log it with the facts read from it, and link it to any task or memory it produces.",
    whenToUse:
      "The operator sends an image (screenshot, photo, scan) with a request like \"remember this\", \"track this\" or \"save this\", or the answer depends on facts in the image. Also when the operator asks to find or review an image sent earlier.",
    category: "workflow",
    tags: ["screenshots", "images", "attachments", "workspace", "memory"],
    source: "builtin",
    body: [
      "Images sent in chat arrive in a temporary folder (the path appears in the message as `[Image: source: <path>]`). That folder is cleared, so an image you only describe is lost. Always keep the file.",
      "",
      "Steps:",
      "",
      "1. Pick the workspace the image belongs to, from the conversation. If none fits, ask once or use the operator's general-purpose workspace.",
      "2. Copy the `source:` file to `<workspace>/.workspace/attachments/YYYY-MM-DD-<short-slug>.<ext>` (create the folder if needed). Use today's UTC date and a slug that says what the image shows.",
      "3. Log it in the workspace database. Create the table if it is missing:",
      "",
      "   CREATE TABLE IF NOT EXISTS attachments (",
      "     id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "     path TEXT NOT NULL,           -- relative to .workspace/",
      "     sha256 TEXT NOT NULL UNIQUE,  -- stops the same image being logged twice",
      "     kind TEXT NOT NULL DEFAULT 'screenshot',",
      "     captured_on TEXT NOT NULL,    -- ISO date",
      "     source TEXT,                  -- which service or app the image shows",
      "     summary TEXT NOT NULL,        -- one sentence",
      "     extracted TEXT,               -- JSON of the facts read from the image",
      "     task_id INTEGER,",
      "     created_at INTEGER NOT NULL",
      "   );",
      "",
      "   Compute sha256 with `sha256sum`. If the hash already exists, reuse that row. Write the SQL through a single-quoted heredoc, not an inline shell string.",
      "4. Read out the facts: who (names, emails), what (the action or state shown), where (service, project, account), when (dates, deadlines, expiry), and status. Store them as JSON in `extracted`.",
      "5. Name the source. If the service is not visible (no logo, no address bar), set `source` to `unknown` plus the visible clues and ask the operator once. Do not guess a vendor from page layout. Update the row when they answer.",
      "6. Link it. A deadline becomes a task in the workspace, with `task_id` set on the attachment and the file path in the task notes. A saved memory includes the file path.",
      "7. If the workspace's `workspace.md` has no `attachments` entity yet, add it.",
      "8. Report in one or two lines: where the file is saved and what was recorded.",
      "",
      "To review later, query `SELECT id, captured_on, source, summary, path FROM attachments ORDER BY captured_on DESC`, then open the file with the Read tool.",
      "",
      "Privacy: images can show private data. Keep them inside the workspace on the server. Never upload them to an outside service or commit them to a git repository.",
    ].join("\n"),
  },
]
