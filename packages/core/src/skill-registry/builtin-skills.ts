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

/**
 * One-shot extractor for the screenshot-intake skill. Runs under `node -e` inside
 * single shell quotes, so it must not contain a single quote. Reads a
 * `messages.content_json` document on stdin, decodes one base64 attachment, and
 * writes it once under a content-addressed name (reusing an existing copy).
 */
const SAVE_ATTACHMENT_JS = [
  'const fs=require("node:fs"),path=require("node:path"),{createHash}=require("node:crypto");',
  'const [dir,day,slug,idx="0"]=process.argv.slice(1);',
  'const parts=JSON.parse(fs.readFileSync(0,"utf8")).message.content;',
  'console.log(parts.filter(p=>p.type==="text").map(p=>p.text).join(" ").slice(0,200));',
  'const files=parts.filter(p=>p.source&&p.source.type==="base64");',
  'const b=files[Number(idx)];',
  'if(!b){console.error("no attachment at index "+idx+" of "+files.length);process.exit(1)}',
  'const buf=Buffer.from(b.source.data,"base64");',
  'const hex=createHash("sha256").update(buf).digest("hex");',
  'const ext={"image/png":"png","image/jpeg":"jpg","image/gif":"gif","image/webp":"webp","application/pdf":"pdf"}[b.source.media_type]||"bin";',
  'fs.mkdirSync(dir,{recursive:true});',
  'const have=fs.readdirSync(dir).find(n=>n.includes("-"+hex.slice(0,16)+"-"));',
  'const out=path.join(dir,have||day+"-"+hex.slice(0,16)+"-"+slug+"."+ext);',
  'if(!have)fs.writeFileSync(out,buf);',
  'console.log(JSON.stringify({file:out,existed:!!have,mediaType:b.source.media_type,bytes:buf.length,sha256:hex}));',
].join("")

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
      "Chat images arrive as Anthropic `image` / `document` blocks on the user message (base64 `source.data`). Luna persists those blocks in the session store (`messages.content_json` in luna.db), and that is the only copy of the bytes - you cannot re-type base64 from an image you were shown, so always extract it from the database. When the operator wants the file kept, write a real copy into the workspace notes folder.",
      "",
      "Steps:",
      "",
      "1. Pick the workspace the image belongs to, from the conversation. If none fits, ask once or use the operator's general-purpose workspace. The target folder is `<workspace>/.workspace/notes/` (the documented optional folder inside `.workspace/`).",
      "2. Keep the image out of git BEFORE writing anything. If `git -C <workspace> rev-parse --is-inside-work-tree` succeeds and `git -C <workspace> check-ignore -q .workspace/notes/probe.png` fails, append these lines to `<workspace>/.workspace/.gitignore` (create it if needed): `notes/*.png`, `notes/*.jpg`, `notes/*.jpeg`, `notes/*.gif`, `notes/*.webp`, `notes/*.pdf`. Re-run the `check-ignore` and stop if it still fails.",
      "3. Find the message. Set `DB=\"${LUNA_DB_PATH:-${LUNA_HOME:-$HOME/.luna}/luna.db}\"` and read it read-only. List the newest top-level user messages that carry an attachment:",
      "",
      "   sqlite3 -readonly \"$DB\" \"SELECT id, datetime(ts/1000,'unixepoch'), length(content_json) FROM messages WHERE kind='user' AND parent_id IS NULL AND (content_json LIKE '%\\\"type\\\":\\\"image\\\"%' OR content_json LIKE '%\\\"type\\\":\\\"document\\\"%') ORDER BY ts DESC LIMIT 5\"",
      "",
      "   The newest row is normally the image the operator just sent. If you cannot tell which row is right, check the request text printed in step 4 and the timestamps, or ask.",
      "4. Save the attachment with one command. It decodes the base64, hashes the bytes with `node:crypto` (not a Linux-only hasher), reuses an existing `*-<first-16-hex>-*` file if the same bytes were saved before, and otherwise writes exactly one file named `YYYY-MM-DD-<first-16-hex>-<slug>.<ext>` (today's UTC date, and a slug that says what the image shows). `<index>` is the 0-based position among the message's attachments (0 for a single image). It prints the message text, then a JSON line with the file path, media type, byte count and sha256 - confirm the media type and byte count look right:",
      "",
      "   sqlite3 -readonly \"$DB\" \"SELECT content_json FROM messages WHERE id='<message-id>'\" | node -e '" + SAVE_ATTACHMENT_JS + "' -- <workspace>/.workspace/notes <YYYY-MM-DD> <slug> <index>",
      "",
      "5. Read out the facts: who (names, emails), what (the action or state shown), where (service, project, account), when (dates, deadlines, expiry), and status.",
      "6. Name the source. If the service is not visible (no logo, no address bar), record `unknown` plus the visible clues and ask the operator once. Do not guess a vendor from page layout.",
      "7. Record in the stores that exist - never CREATE TABLE, never invent an `attachments` entity, never write raw rows into a table a service owns:",
      "   - Durable facts / \"remember this\" -> `mcp__memory__memory_save` (include the notes/ path and sha256).",
      "   - A deadline or follow-up -> put the date and the notes/ path in the `mcp__memory__memory_save` entry; for a dated reminder that should fire, use the `mcp__scheduler__schedule_create` tool.",
      "   - The session ledger -> `mcp__observability__obs_note` (`kind: \"decision\"` or `\"progress\"`) with path + sha256 in the payload.",
      "   - A short sibling markdown in `.workspace/notes/` is fine for extracted facts the Read tool should reopen next to the image.",
      "8. Report in one or two lines: where the file is saved and what was recorded.",
      "",
      "To review later: list `<workspace>/.workspace/notes/`, then use `mcp__memory__memory_search` for the path or facts and `mcp__observability__obs_notes_recent` for the session ledger. Open the file with the Read tool.",
      "",
      "Privacy: images can show private data. Keep them inside the workspace on the server. Never upload them to an outside service, and never commit them to a git repository - step 2 exists for this.",
    ].join("\n"),
  },
]
