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
    description: "Keep every image the operator sends as a durable, reviewable record: write a copy into the workspace notes folder, fingerprint it, and record the facts in the stores Luna already has.",
    whenToUse:
      "The operator sends an image (screenshot, photo, scan) with a request like \"remember this\", \"track this\" or \"save this\", or the answer depends on facts in the image. Also when the operator asks to find or review an image sent earlier.",
    category: "workflow",
    tags: ["screenshots", "images", "attachments", "workspace", "memory"],
    source: "builtin",
    body: [
      "Chat images arrive as Anthropic `image` / `document` blocks on the user message (base64 `source.data`). Luna already persists those blocks in the session store (`messages.content_json`). A temp filesystem path, if a client materializes one, can still be cleared — so when the operator wants the file kept, write a real copy into the workspace notes folder.",
      "",
      "Steps:",
      "",
      "1. Pick the workspace the image belongs to, from the conversation. If none fits, ask once or use the operator's general-purpose workspace.",
      "2. Write the bytes to `<workspace>/.workspace/notes/YYYY-MM-DD-<short-slug>.<ext>` (create `notes/` if needed). `notes/` is the documented optional folder inside `.workspace/`. Use today's UTC date and a slug that says what the image shows. If a filesystem path is already available, copy that file; otherwise decode the message block's base64 `source.data`.",
      "3. Fingerprint the file the same way Luna hashes elsewhere (`node:crypto` `createHash(\"sha256\")`), not a Linux-only hasher:",
      "",
      "   node -e \"const {createHash}=require('node:crypto');const {readFileSync}=require('node:fs');console.log(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))\" -- <file>",
      "",
      "   If a file in `.workspace/notes/` already has that digest in its name, reuse it. Otherwise rename to `YYYY-MM-DD-<first-16-hex>-<slug>.<ext>`.",
      "4. Read out the facts: who (names, emails), what (the action or state shown), where (service, project, account), when (dates, deadlines, expiry), and status.",
      "5. Name the source. If the service is not visible (no logo, no address bar), record `unknown` plus the visible clues and ask the operator once. Do not guess a vendor from page layout.",
      "6. Record in the stores that exist — never CREATE TABLE, never invent an `attachments` entity:",
      "   - Durable facts / \"remember this\" → `memory_save` (include the notes/ path and sha256).",
      "   - A deadline or follow-up → a `next_actions` row; put the file path in its `notes` column.",
      "   - The session ledger → `obs_note` (`kind: \"decision\"` or `\"progress\"`) with path + sha256 in the payload.",
      "   - A short sibling markdown in `.workspace/notes/` is fine for extracted facts the Read tool should reopen next to the image.",
      "7. Report in one or two lines: where the file is saved and what was recorded.",
      "",
      "To review later: list `<workspace>/.workspace/notes/`, `memory_search` for the path or facts, `obs_notes_recent`, or `SELECT id, action, notes FROM next_actions ORDER BY created_at DESC`. Then open the file with the Read tool.",
      "",
      "Privacy: images can show private data. Keep them inside the workspace on the server. Never upload them to an outside service or commit them to a git repository.",
    ].join("\n"),
  },
]
