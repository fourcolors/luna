# Moon Uploads — Design & Phased Plan

Status: **Design / discussion** (branch `feat/moon-uploads`)
Author: Sterling Cobb + Claude
Date: 2026-06-03

## Goal

Add file/image upload to the **moon** Tauri client via three input methods:
file-picker, copy/paste, and drag-and-drop. The longer-term ambition: Luna
can accept **any** file, store it, and dynamically figure out how to handle
it (inspect, unzip, transcode, even install tooling) — **securely**.

## The load-bearing insight

"Attach a file" has two completely different meanings, needing different infra:

- **Perception** — the file becomes a *content block the model sees this turn*
  (image / PDF / text). Inline, stateless, bounded by model modalities.
  **Luna is built for this today.**
- **Filesystem/compute** — the file is *placed where tools can operate on it*
  (read a zip, transcode a video, install software). Needs a **store + a
  workspace the agent can execute in**. **Luna has none of this today.**

"Truly anything" is a small feature (perception) wearing a large feature's
(compute) clothes. We phase accordingly.

## What exists today (verified)

- **Server already does images end-to-end.** Wire `attachments` field
  (`packages/ui-ws/src/protocol.ts:312`), `validateAttachments`
  (`server.ts:259`, 4 image types / 4 MB / 8 per turn), and `buildUserMessage`
  emits Anthropic `image` content blocks (`chat-service.ts`).
- **moon is the only client missing the UI.** Composer is a single-line text
  input (`apps/ui-moon-tauri/frontend/index.html:1457`); `handleSubmit` sends
  `{type, threadId, text}` with no attachments.
- **Reference UX exists** in `ui-web` (React) and `ui-shared-solid/ChatPanel.tsx`
  (picker + paste + drop). moon is vanilla HTML/JS **with no build step**, so
  these are **ported**, not imported.
- **Agent runs server-side with `tools: []`** — only MCP tools (memory,
  scheduler, observability, `local_shell`). `local_shell` executes on the
  **client**, not the server. There is **no blob store, no per-thread
  workspace**. Attachments are inline base64 in the SQLite message stream.
- **Transport ceiling:** 4 MB inline base64 inside an 8 MB WS frame.

## Phased plan

### Phase 1 — Uploads that work this week (the actual feature)
moon composer gains picker + paste + drag-drop; readable files become content
blocks. This is "uploads" for ~95% of real use and ships now.

- **Images** (jpeg/png/gif/webp): existing `attachments` path. Client-only.
- **Text/code** (.txt .md .csv .json .py …): read text client-side, send as a
  filename-tagged text block. Client-only — no protocol/server change (it's
  just text).
- **PDFs**: small **server change** — extend the media-type union +
  `validateAttachments` + `buildUserMessage` to emit Anthropic `document`
  blocks; raise size caps for PDFs.
- **Drag-drop gotcha:** Tauri v2 intercepts OS file drops at the window level
  (`dragDropEnabled` defaults on). HTML5 `ondrop` may not fire with files —
  needs verification / a Tauri drag-drop event listener.
- **Binaries in Phase 1:** surfaced in the picker but clearly marked
  "stored, not yet readable" (full handling lands in Phase 3).

### Phase 2 — File store + reference-in-message
Binary (and large) files get **stored server-side** and the agent is *told*
"file X is available at handle Y" — **no execution yet**.

- **New upload transport** — inline base64 won't carry video/large binaries.
  Needs chunked WS or an HTTP multipart endpoint → returns a file handle.
- **Workspace store** — per-thread (or per-account) directory + metadata,
  with lifecycle/cleanup.
- **Message integration** — inject a note so the agent knows the file exists
  and where, even before it can act on it.

### Phase 3 — Sandboxed agent workspace (the hard, security-critical track)
Honest name: **give the agent a server-side sandboxed compute environment
with arbitrary code execution and network egress.** This is where "the AI
downloads the right software and figures it out" lives.

- **New component that does not exist today:** a server-side execution surface
  (new MCP `workspace`/`exec` tools) scoped to the per-thread workspace,
  running inside the sandbox. (Today's `local_shell` is client-side; the
  server agent has `tools: []`.)
- **Security IS the feature, not a footnote.** RCE + package installation +
  outbound network is the hardest security surface there is. Design must
  cover: container isolation / escape, network egress policy (allowlist?
  off-by-default?), resource limits, per-thread cleanup, and the trust
  boundary.
- **The blob store is the easy 10%; the sandboxed exec surface is the 90%.**

## The one fact that most changes Phase 3 difficulty: tenancy

- **Single-tenant** (Luna runs on Mr. Cobb's own jax-box, agent executes code
  on *his* box against files *he* uploaded): roughly "the user ran a command
  on his own machine" — a tractable sandbox-hardening problem (incus container
  already provides a boundary; harden egress, limits, cleanup).
- **Multi-tenant** (multiple users sharing a Luna server): a far worse problem;
  arbitrary RCE on shared infra. This single bit decides whether Phase 3 is
  "a few weeks of careful work" or "don't."

Current read from the code: multi-account but OAuth-token-centric, **single
user in practice**.

**CONFIRMED (2026-06-03): Luna is single-tenant** — runs on Mr. Cobb's own
jax-box, agent executes against his own files. Phase 3 is therefore the
tractable "harden a container the user already controls" problem, not the
multi-tenant-RCE problem. Phase 1 greenlit to start now.

## Recommended next move

1. **Start Phase 1 now** — it's the deliverable; it's mostly client-side.
2. Confirm **tenancy** → scope Phase 3 as its own deliberate design track.
3. Don't build Phase 3 this session.

## Anthropic file-handling research (2026-06-03, cited)

Authoritative limits (Claude API; follow these, not guesses). Sources:
platform.claude.com `/build-with-claude/{vision,pdf-support,files}` and
`/agents-and-tools/tool-use/code-execution-tool`.

| Capability | Limit |
|------------|-------|
| Image media types | jpeg, png, gif, webp only |
| Image max size (Claude API) | **10 MB/image** (5 MB on Bedrock/Vertex) |
| Image max dims | 8000×8000 px; model auto-downsamples (Opus 4.8 ≈ 2576 px long edge) |
| Image token cost | ≈ (w × h) / 750 |
| **Total request payload** | **32 MB** (the real per-turn ceiling) |
| PDF (`document` block) | **GA, no beta header**; ≤ 32 MB req, ≤ 600 pages (100 on 200k-ctx) |
| `document` also accepts | `text/plain` (NOT docx/csv/xlsx — convert/inline those) |
| Files API (`file_id`) | upload once, ref by id; **500 MB/file**, 500 GB/workspace; **beta** `files-api-2025-04-14`; free |
| Code-exec container | `container_upload` + `code_execution` tool; CSV/Excel/JSON/XML/img/text; **NO network**; 30-day artifacts; **beta** |

**Agent SDK passthrough (verified against installed `@anthropic-ai/claude-agent-sdk@0.2.119`):**
`SDKUserMessage.message: MessageParam` (raw Anthropic type) → content accepts
the full block union incl. `document`, `file_id`, `container_upload`
(`sdk.d.ts:3412, 2794`). So PDF document blocks are **low-risk** (GA, same path
as the working image blocks). **Open question:** whether the SDK subprocess sets
the *beta headers* for Files API / code-execution — gates the managed store/exec
route; verify empirically before relying on it. Note Luna sets `tools: []` so
enabling Anthropic's `code_execution` tool is an explicit config change.

**Pivotal finding — Anthropic already ships "store + agent-operates-on-it":**
Files API (`file_id`, 500 MB) = the store; `container_upload` + `code_execution`
= a **sandboxed, no-network** environment where the model runs code against the
file. This *is* Phase 2 + much of Phase 3, official and secure-by-default.
**Tradeoff vs Mr. Cobb's vision:** the managed container has **no network and
can't install arbitrary software** — so "download the right software" needs our
OWN incus sandbox (reopens the security problem). Likely hybrid: managed
container for analysis (covers most cases), self-hosted only for install/network.

**Resize tooling:** repo is **Bun**, no image lib today; `screen-capture` shells
out to the macOS `screencapture` CLI (project already favors native CLIs).
- *Client-side downscale-to-inline* (keep big photos perceivable): **Canvas API
  in the moon webview — zero dependency.** Best for Phase 1.5.
- *Server/agent-side image ops*: **MiniMagick is Ruby — N/A here.** Use `sharp`
  (npm/libvips, bundled binary, Bun-compatible, portable for the installer) or
  shell out to the ImageMagick `magick` CLI (matches screen-capture style but
  adds a system dep to the incus image). Lean `sharp` for portability.

**Caps decision (decoupled from images):** client-side downscale reduces every
non-GIF image to ≤ 1568 px long edge, which lands it **under the existing 4 MB
cap / 8 MB WS frame** — so the **image + text path needs ZERO server change.**
The cap raise (per-image ≤ 10 MB, per-turn decoded ≤ ~20 MB so base64 ≤ ~27 MB
under the 32 MB request ceiling, WS `maxPayload` 8 → ~32 MB) is **PDF-only** and
belongs to the PDF slice — PDFs are large and can't be downscaled.

**PDF passthrough is type-accepted but behaviourally UNVERIFIED.** The Agent SDK
is Claude Code under the hood, whose native file ingestion is its Read tool, not
base64 `document` blocks in a user message — it may strip/ignore/error on one.
**Spike one tiny PDF document-block round-trip live BEFORE the 5-package change.**

## Implementation status (2026-06-03)

**Phase 1 client slice — BUILT** (all in `apps/ui-moon-tauri`):
- `tauri.conf.json`: `dragDropEnabled: false` so the webview gets HTML5
  drag/drop (Tauri otherwise swallows OS file drops).
- `frontend/index.html`: new `Attachments` module (classify / read / validate /
  render / wire), composer UI (paperclip button, hidden file input, chip strip,
  error line), `formatTextAttachment()` text-fold wrapper, `handleSubmit`
  integration, queued-message path threads attachments, close-on-blur guard
  (`State.suppressBlurClose`) so the file dialog doesn't collapse the chat,
  event wiring for picker + paste + drag-drop. Image previews use `data:` URLs
  (CSP blocks `blob:`). Fixed a pre-existing missing `}` on `.send-btn svg`.

**Behaviour:** images → `attachments` frame (server-ready); text/code → folded
into message text; PDFs → declined behind `Attachments.PDF_ENABLED=false`
(flip with the server slice); binaries → declined with a clear message.

**Client-side downscaler ADDED** (`processImage`): non-GIF images downscaled to
≤ `MAX_EDGE` (1568 px) long edge, re-encoded preserving png/jpeg/webp, guaranteed
≤ `MAX_IMAGE_BYTES` (PNG falls back to JPEG / quality steps down). GIFs over cap
are rejected (can't flatten animation). Keeps the image path server-change-free.

**Verified:** JS syntax (`node --check`), JSON validity, and **16 logic
assertions** against the real module source (classify / reject / wire / fold /
PDF-flag / downscale branch control-flow). **NOT yet verified live:** DOM render,
events (picker/paste/drag), the canvas pixel downscale itself, WS round-trip,
CSP — all need the running moon app.

**Phase-1 scope (all BUILT, pending live run):**
- **Images + text = pure-client, COMPLETE** (downscaler keeps them under the
  existing server caps — zero server change).
- **PDF = BUILT (SDK leg spiked; full moon→model round-trip pending live run).**
  Spike **PASSED** — a base64 `document` block sent through the real
  `@anthropic-ai/claude-agent-sdk@0.2.119` `query()` with **no tools allowed**
  returned the PDF's secret phrase, proving the SDK forwards document blocks to
  the model. NOTE: the spike hand-fed `query()` directly; the production path
  (moon → `buildUserMessage` → adapter → SessionStore mirror → SDK) and the
  SessionStore write→read→reproject round-trip for a PDF are still live-unverified
  (the reproject is now unit-covered in projection.test.ts). Then the 5-package
  contract landed:
  - `protocol.ts` `WireAttachment` + `ui-shared/wire.ts` + `core/projection.ts`
    `ChatAttachment` unions → add `application/pdf`.
  - `core/projection.ts` `extractAttachments` → also reconstruct `document`
    blocks from stored payloads (snapshot replay).
  - `server.ts` `validateAttachments` → allow pdf; type-aware caps (image 10MB,
    pdf 20MB, turn-total 20MB); WS `maxPayload` 8→32MB.
  - `chat-service.ts` `buildUserMessage` → emit `document` block for pdf.
  - moon `index.html` → `PDF_ENABLED=true`, `MAX_PDF_BYTES=20MB`.
  **Typecheck: 0 errors** across the root project (all touched packages).

**Verified without the app:** spike (live SDK), tsc (0 err), 16 logic asserts,
JS syntax, JSON. **STILL needs the running moon app:** the whole UI, events
(picker/paste/drag), canvas downscale pixels, CSP, and the moon→server→SDK→model
round-trip for both image and PDF.

**Known out-of-scope nit:** `ui-shared/attachments.ts` `ALLOWED_ATTACH_TYPES`
(web/solid file-picker allowlist) still lists images only — web/solid won't
*offer* PDFs client-side yet, though the server now accepts them. Update there
when those clients want PDF.

**Next: live-run the moon app.** Phases 2-3 (store/exec engine) deferred by
Mr. Cobb until P1 is live.
