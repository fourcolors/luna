/**
 * Artifact extraction — pulls "interesting" code/file payloads out of a
 * finalized assistant turn so the UI can pin them into a side panel.
 *
 * Two sources:
 *   1. Fenced code blocks in `message.text` whose body is "substantial"
 *      (≥10 lines or ≥400 chars). Drive-by snippets (a 2-line shell
 *      command, an inline JSON example) stay inline in the bubble.
 *   2. Tool-use blocks for filesystem writes (`Write`, `Edit`,
 *      `MultiEdit`, `NotebookEdit`). Each becomes an artifact whose
 *      `path` reflects the file the assistant wrote.
 *
 * Pure function — given the same ChatMessage, it always returns the
 * same artifacts in the same order. Source-of-truth for the UI's side
 * panel; the panel never re-parses the message text itself.
 */
import type { ChatMessage, ChatToolUse } from "@experiment-agent/core"

export type ArtifactSource = "code-fence" | "tool-write"

export interface Artifact {
  /** Stable id within a thread: `${messageId}:${index}`. */
  readonly id: string
  readonly source: ArtifactSource
  /** Optional file path (only present for tool-write artifacts). */
  readonly path: string | null
  /** Inferred language tag (e.g. "ts", "json", "bash"). May be null. */
  readonly lang: string | null
  /** Short label for the side-panel list. */
  readonly title: string
  /** Full content (the file body, or the code-fence body). */
  readonly content: string
}

/* ── thresholds ──────────────────────────────────────────────────────── */
/** Code fences must be at least one of these to qualify as an artifact. */
const MIN_FENCE_LINES = 10
const MIN_FENCE_CHARS = 400

/* ── code-fence parser ──────────────────────────────────────────────── */
/**
 * Match fenced code blocks. We use a multiline regex so a `\`\`\`` inside
 * a string literal in some other code block doesn't false-match — we
 * pair opening fences with the next closing fence at column 0.
 *
 *   ```lang
 *   …body…
 *   ```
 */
const FENCE_RE = /^```([\w-]*)\n([\s\S]*?)\n```$/gm

const isSubstantialFence = (body: string): boolean => {
  if (body.length >= MIN_FENCE_CHARS) return true
  const lines = body.split("\n").length
  return lines >= MIN_FENCE_LINES
}

const extractFromText = (
  messageId: string,
  text: string,
): ReadonlyArray<Artifact> => {
  const out: Artifact[] = []
  let i = 0
  for (const m of text.matchAll(FENCE_RE)) {
    const rawLang = (m[1] ?? "").trim()
    const body = m[2] ?? ""
    if (!isSubstantialFence(body)) continue
    const lang = rawLang.length > 0 ? rawLang : null
    out.push({
      id: `${messageId}:${i}`,
      source: "code-fence",
      path: null,
      lang,
      title: lang ? `code (${lang})` : "code",
      content: body,
    })
    i++
  }
  return out
}

/* ── tool-use parser ────────────────────────────────────────────────── */

const FILE_WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
])

/** Lang inferred from a file extension. Aligned with the UI's allowlist
 *  so the side panel can re-use the existing Shiki <CodeBlock>. */
const langFromExt = (path: string): string | null => {
  const m = /\.([a-zA-Z0-9]+)$/.exec(path)
  if (!m) return null
  const ext = m[1]!.toLowerCase()
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "json":
    case "md":
    case "rs":
    case "go":
      return ext
    case "sh":
    case "bash":
    case "zsh":
      return "bash"
    case "py":
      return "python"
    default:
      return null
  }
}

interface ToolFileFields {
  readonly path: string
  readonly content: string
}

/** Best-effort extraction of (path, content) from a Write/Edit tool input.
 *  Different tools spell these fields differently; we try the common
 *  shapes the SDK adapter persists. */
const fileFieldsFrom = (tu: ChatToolUse): ToolFileFields | null => {
  const input = tu.input
  if (!input || typeof input !== "object") return null
  const obj = input as Record<string, unknown>

  const path =
    (typeof obj["file_path"] === "string" && obj["file_path"]) ||
    (typeof obj["path"] === "string" && obj["path"]) ||
    (typeof obj["notebook_path"] === "string" && obj["notebook_path"]) ||
    null
  if (!path) return null

  // Write: { content }, Edit: { new_string }, NotebookEdit: { new_source }
  const content =
    (typeof obj["content"] === "string" && obj["content"]) ||
    (typeof obj["new_string"] === "string" && obj["new_string"]) ||
    (typeof obj["new_source"] === "string" && obj["new_source"]) ||
    null
  if (content === null) return null

  return { path, content }
}

const extractFromToolUses = (
  messageId: string,
  toolUses: ReadonlyArray<ChatToolUse>,
  startIdx: number,
): ReadonlyArray<Artifact> => {
  const out: Artifact[] = []
  let i = startIdx
  for (const tu of toolUses) {
    if (!FILE_WRITE_TOOLS.has(tu.name)) continue
    const f = fileFieldsFrom(tu)
    if (!f) continue
    out.push({
      id: `${messageId}:${i}`,
      source: "tool-write",
      path: f.path,
      lang: langFromExt(f.path),
      title: f.path.split("/").pop() ?? f.path,
      content: f.content,
    })
    i++
  }
  return out
}

/* ── public ─────────────────────────────────────────────────────────── */

/** Extract every artifact-shaped payload from a finalized assistant turn.
 *  Returns [] if nothing qualifies (the side panel just hides for that
 *  message). Order: tool-writes first (they're the higher-signal ones —
 *  files actually committed to disk), then code fences. */
export const extractArtifacts = (
  message: ChatMessage,
): ReadonlyArray<Artifact> => {
  const toolArts = extractFromToolUses(message.id, message.toolUses, 0)
  const fenceArts = extractFromText(message.id, message.text).map(
    (a, j) => ({ ...a, id: `${message.id}:${toolArts.length + j}` }),
  )
  return [...toolArts, ...fenceArts]
}
