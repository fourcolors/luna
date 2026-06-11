/**
 * seed-probe-widgets.ts — Phase 0.5 mini-app probes (widget-system.md).
 *
 * Pins the three probe widgets into a server's ArtifactStore (luna.db):
 *
 *   probe-workspace-pulse   live obs-event dashboard      bridge_caps obs:*
 *   probe-tamagotchi        "Mochi", fed by Luna's work   obs:ToolCall/CostAccrued/Error
 *   probe-widget-system-doc the design doc, readable      no caps (pure document)
 *
 * Content sources live in apps/ui-moon-tauri/design/probes/. The doc probe is
 * assembled here: widget-system.md → minimal markdown→HTML → injected into
 * doc-shell.html at the `<!-- DOC_BODY -->` placeholder.
 *
 * Idempotent: re-running pins missing probes and version-bumps changed ones
 * (so iterating a probe = edit the file, re-run). The probes appear in every
 * connected client's artifacts panel on its next artifact-list (reconnect or
 * pin event); pop them out via the existing widget pop-out button.
 *
 * Usage:
 *   bun apps/ui-web/scripts/seed-probe-widgets.ts --db /path/to/luna.db
 *
 * ⚠️ Writes via bun:sqlite WAL. Safe alongside a running server for these
 * seed-sized writes, but already-connected clients only learn of the new
 * artifacts on their next connect — open the widget windows after seeding.
 */
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { Effect, Layer } from "effect"
import { ArtifactStore, Clock, type PinInput } from "@luna/core"
import { LunaSqliteBootstrapLive } from "@luna/memory"

// ── minimal markdown → HTML (the constructs widget-system.md uses) ──────────
//
// Security note: the doc is repo-authored (trusted), but we still escape
// everything before transforming so stray angle brackets in code fences or
// table cells can't smuggle markup into the sandboxed iframe.

const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

/** Inline transforms on already-escaped text: code spans first (their content
 *  is protected from the later passes via placeholders), then links, bold,
 *  italic. */
const inline = (escaped: string): string => {
  const codeSpans: string[] = []
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${code}</code>`)
    return `\u0000${codeSpans.length - 1}\u0000`
  })
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, text: string, href: string) =>
      /^https?:\/\//.test(href)
        ? `<a href="${href}" title="${href}">${text}</a>`
        : text,
  )
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:])/g, "$1<em>$2</em>")
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codeSpans[Number(i)])
}

export const markdownToHtml = (md: string): string => {
  const lines = md.split("\n")
  const out: string[] = []
  let i = 0

  const isTableLine = (l: string) => /^\s*\|.*\|\s*$/.test(l)
  const tableCells = (l: string) =>
    l
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => inline(escapeHtml(c.trim())))

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === "") {
      i++
      continue
    }
    // fenced code
    if (line.trim().startsWith("```")) {
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(escapeHtml(lines[i]))
        i++
      }
      i++ // closing fence
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`)
      continue
    }
    // hr
    if (/^-{3,}\s*$/.test(line.trim())) {
      out.push("<hr>")
      i++
      continue
    }
    // headings
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      out.push(`<h${level}>${inline(escapeHtml(h[2]))}</h${level}>`)
      i++
      continue
    }
    // table
    if (isTableLine(line) && i + 1 < lines.length && /^\s*\|[\s|:-]+\|\s*$/.test(lines[i + 1])) {
      const header = tableCells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && isTableLine(lines[i])) {
        rows.push(tableCells(lines[i]))
        i++
      }
      out.push(
        "<table><thead><tr>" +
          header.map((c) => `<th>${c}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows
            .map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>")
            .join("") +
          "</tbody></table>",
      )
      continue
    }
    // lists (the doc uses flat "- " and "1." items with indented wraps)
    const li = line.match(/^(\s*)(?:-|\d+\.)\s+(.*)$/)
    if (li) {
      const ordered = /^\s*\d+\./.test(line)
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)(?:-|\d+\.)\s+(.*)$/)
        if (m) {
          items.push(m[2])
          i++
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length > 0) {
          items[items.length - 1] += " " + lines[i].trim()
          i++
        } else {
          break
        }
      }
      const tag = ordered ? "ol" : "ul"
      out.push(
        `<${tag}>` +
          items.map((t) => `<li>${inline(escapeHtml(t))}</li>`).join("") +
          `</${tag}>`,
      )
      continue
    }
    // paragraph: gather until blank/structural line
    const buf: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,3}\s|```|-{3,}\s*$|\s*\|)/.test(lines[i]) &&
      !/^(\s*)(?:-|\d+\.)\s+/.test(lines[i])
    ) {
      buf.push(lines[i])
      i++
    }
    out.push(`<p>${inline(escapeHtml(buf.join(" ")))}</p>`)
  }
  return out.join("\n")
}

// ── script entrypoint (skipped on import, so tests can use markdownToHtml) ──

const sameCaps = (
  a: ReadonlyArray<string> | null,
  b: ReadonlyArray<string> | null | undefined,
) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const main = async () => {
  const argv = process.argv.slice(2)
  const argValue = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
  }

  const dbPath = argValue("--db")
  if (!dbPath) {
    console.error(
      "Usage: bun apps/ui-web/scripts/seed-probe-widgets.ts --db /path/to/luna.db",
    )
    process.exit(1)
  }

  const repoRoot = path.resolve(import.meta.dirname, "../../..")
  const probesDir =
    argValue("--probes-dir") ??
    path.join(repoRoot, "apps/ui-moon-tauri/design/probes")
  const docPath =
    argValue("--doc") ??
    path.join(repoRoot, "apps/ui-moon-tauri/design/widget-system.md")

  const readProbe = (file: string): string =>
    readFileSync(path.join(probesDir, file), "utf8")

  const docShell = readProbe("doc-shell.html")
  if (!docShell.includes("<!-- DOC_BODY -->")) {
    console.error("doc-shell.html is missing its <!-- DOC_BODY --> placeholder")
    process.exit(1)
  }
  const docHtml = docShell.replace(
    "<!-- DOC_BODY -->",
    markdownToHtml(readFileSync(docPath, "utf8")),
  )

  const ORIGIN = "probe-seed (widget-system.md Phase 0.5)"

  const probes: ReadonlyArray<PinInput> = [
    {
      id: "probe-workspace-pulse",
      kind: "widget",
      title: "Workspace Pulse",
      lang: "html",
      content: readProbe("workspace-pulse.html"),
      origin: ORIGIN,
      bridgeCaps: ["obs:*"],
      editedBy: "user",
    },
    {
      id: "probe-tamagotchi",
      kind: "widget",
      title: "Mochi",
      lang: "html",
      content: readProbe("tamagotchi.html"),
      origin: ORIGIN,
      bridgeCaps: ["obs:ToolCall", "obs:CostAccrued", "obs:Error"],
      editedBy: "user",
    },
    {
      id: "probe-widget-system-doc",
      kind: "widget",
      title: "Widget System — Design v2",
      lang: "html",
      content: docHtml,
      origin: ORIGIN,
      bridgeCaps: null,
      editedBy: "user",
    },
  ]

  const program = Effect.gen(function* () {
    const store = yield* ArtifactStore
    for (const probe of probes) {
      const existing = yield* store.get(probe.id)
      if (!existing) {
        const pinned = yield* store.pin(probe)
        console.log(`pinned   ${probe.id}  v${pinned.version}  (${probe.content.length} bytes)`)
      } else if (
        existing.content !== probe.content ||
        !sameCaps(existing.bridgeCaps, probe.bridgeCaps)
      ) {
        const updated = yield* store.update(
          probe.id,
          probe.content,
          "user",
          probe.bridgeCaps ?? null,
        )
        console.log(`updated  ${probe.id}  v${updated?.version}  (${probe.content.length} bytes)`)
      } else {
        console.log(`current  ${probe.id}  v${existing.version}  (unchanged)`)
      }
    }
  })

  const storeLayer = ArtifactStore.makeLayer(dbPath).pipe(
    Layer.provide(Clock.Default),
    Layer.provide(LunaSqliteBootstrapLive),
  )

  await Effect.runPromise(program.pipe(Effect.provide(storeLayer)))
  console.log(`\nSeeded into ${dbPath} — reconnect a client (or just open the\nartifacts panel) and pop each probe out into its widget window.`)
}

if (import.meta.main) await main()
