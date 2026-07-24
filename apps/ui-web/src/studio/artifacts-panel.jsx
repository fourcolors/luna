// artifacts-panel.jsx — React port of packages/ui-shared-solid/src/ArtifactPanel.tsx
// (PRD Part C / W1): the this-session (ephemeral) + pinned artifact list,
// with a kind-aware detail preview.
//
// This component is presentational only — it takes its data and handlers as
// props (fed from ctx.state / ctx by the DEFS entry in final-app.jsx; see the
// integration spec returned alongside this file). It owns only the local
// `selectedId` UI toggle.
//
// Idiom translation from Solid: createSignal -> useState, For -> .map,
// Show -> && / ternary, createEffect -> useEffect, createMemo -> useMemo,
// class -> className. Each row is a div[role=button] (not <button>) so the
// pin/unpin chip — itself a <button> — is a valid child (a button may not
// nest a button); this is also the pattern WorkflowGallery.jsx mirrors back
// from this file, so `.artifact-panel` / `.artifact-head` / `.artifact-list`
// / `.artifact-row` / `.artifact-title` / `.artifact-meta` / `.muted` /
// `.small` are SHARED base classes — don't fork them per-panel.
//
// kind=widget / kind=mcp-app REUSE the existing real WidgetFrame.jsx (the
// sandboxed-iframe host already wired for both kinds, including its own
// graceful "no live MCP relay" source fallback) rather than re-porting the
// Solid LiveWidgetFrame/McpAppFrame. This intentionally simplifies one
// Solid-only nuance: Solid only renders a rich iframe for kind="mcp-app" when
// `props.mcp` is set (else falls through to the source view); here both
// kinds always render through <WidgetFrame>, which itself already renders a
// plain <pre> source view when `mcp` is undefined — same end result, fewer
// branches. See the returned integration notes for detail.
//
// kind=code (and any kind not otherwise matched) renders a plain, un-
// highlighted <pre><code> block — porting Shiki's CodeBlock is explicitly
// out of scope for v1 per the brief.
//
// kind=markdown renders through <MiniMarkdown>, a small hand-rolled
// block/inline parser that builds React elements directly (never a raw HTML
// string, never dangerouslySetInnerHTML) — this is itself the sanitizer: a
// malicious `<script>` or `<img onerror=...>` in agent/user text is just
// inert text content in the output tree. Link hrefs are allowlisted to
// https:/mailto: only (mirrors MarkdownView.tsx's isAllowedHref), and links
// open in a new tab with rel="noopener noreferrer".
//
// kind=html renders a hard-sandboxed iframe via buildMcpSrcdoc (the SAME
// cage Moon/WidgetFrame use: sandbox="allow-scripts", strict CSP, no
// allow-same-origin, no luna.* bridge — a preview has no live-data door).
//
// Never renders a secret value: artifacts are user/agent content (code,
// docs, generated UI), never vault/credential material.
import React, { useEffect, useMemo, useState } from "react";
import { Button } from "./astryx-kit.tsx";
import { downloadArtifact, countLines, formatBytes } from "@luna/ui-shared/core";
import { SANDBOX_ATTR, buildMcpSrcdoc } from "@luna/ui-shared/widget-sandbox";
import { WidgetFrame } from "./WidgetFrame.jsx";

// Astryx conversion (single-file scope, mirrors workflows-panel.jsx's notes):
//   - Pin/unpin chips and the download/copy chips are clean 1:1 mappings onto
//     Astryx's <Button>: each is a plain synchronous action trigger with no
//     nested interactive children. `label` carries the same visible text the
//     hand-rolled <button> used to render (Button's accessible-name prop is
//     rendered as visible text by default, same as before); `icon` carries
//     the leading emoji that was previously just inline text, so the
//     rendered "⬇ download" / "📌 pin" output is unchanged. `tooltip` takes
//     over from the old `title` attribute for the same native-hover text.
//     `className="chip small artifact-chip"` is kept so Luna's unlayered CSS
//     (see main.tsx: Astryx's own rules live in `@layer astryx-base`) keeps
//     winning the cascade over Astryx's default button chrome - no visual
//     regression, and workflows-panel.jsx / connectors-panel.jsx already
//     lean on the exact same shim.
//   - The artifact list rows stay hand-rolled div[role=button] markup for
//     the same reason workflows-panel.jsx's tiles do: Astryx has no
//     equivalent that produces this DOM shape (a div-not-button row hosting
//     a NESTED interactive pin/unpin <button> - a real <button> cannot
//     nest another <button>), and this file is itself the pattern
//     workflows-panel.jsx explicitly mirrors back from. Forcing a
//     ClickableCard-style component here would fork `.artifact-row` styling
//     for the one file it needs to stay byte-compatible with.
//   - The `<pre><code>` code-fallback block (used for kind=code and as the
//     fallback for any unmatched kind) stays plain, unhighlighted markup.
//     Astryx ships a CodeBlock component, but porting to it is explicitly
//     out of scope: the source comment above states Shiki highlighting was
//     deliberately skipped for v1, and CodeBlock's syntax-highlighting
//     surface would be a highlighting side effect this pass must not add.
//   - Stays .jsx for the same reason workflows-panel.jsx does: this module
//     is imported elsewhere by its exact "./artifacts-panel.jsx" specifier
//     (extension included; Vite does not resolve across extensions), and
//     that import site is out of this conversion's single-file scope, so
//     renaming to .tsx would require an out-of-scope edit for zero
//     behavioural benefit. JSDoc types are kept as-is.

/* ── kind inference for EPHEMERAL artifacts (no explicit kind) ──────────────
 * Mirrors @luna/core's deriveArtifactKind (packages/core/src/artifacts/types.ts)
 * byte-for-byte, but kept as a LOCAL copy (same choice the Solid source
 * makes) rather than importing @luna/core — that package is server-oriented
 * and has never been pulled into this browser bundle; duplicating this one
 * pure ~10-line classifier avoids being the first to change that. Never
 * returns "widget"/"mcp-app" — those are explicit-only and only ever arrive
 * on PINNED items. */
function deriveContentKind(lang, path) {
  const l = (lang || "").toLowerCase().trim();
  const p = (path || "").toLowerCase().trim();
  if (l === "html" || l === "htm" || p.endsWith(".html") || p.endsWith(".htm")) {
    return "html";
  }
  if (l === "md" || l === "markdown" || p.endsWith(".md") || p.endsWith(".markdown")) {
    return "markdown";
  }
  return "code";
}

/** Keyboard activation helper for a div[role=button] row. */
function activateOnKey(fn) {
  return (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

/* ── minimal sanitized markdown renderer ─────────────────────────────────
 * Hand-rolled, dependency-free block + inline parser that emits React
 * elements directly — there is no HTML string at any point, so there is
 * nothing to sanitize-by-stripping and no dangerouslySetInnerHTML surface.
 * Not a full CommonMark/GFM implementation (no tables, no nested emphasis) —
 * headings, paragraphs, fenced code, blockquotes, lists, hr, and inline
 * code/bold/italic/links cover the vast majority of assistant prose. */

function isAllowedHref(href) {
  try {
    const proto = new URL(href).protocol;
    return proto === "https:" || proto === "mailto:";
  } catch {
    return false;
  }
}

const INLINE_RE =
  /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]]+)\]\(([^)\s]+)\)/g;

function renderInline(text, keyPrefix) {
  const nodes = [];
  let last = 0;
  let m;
  let i = 0;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const key = keyPrefix + "-" + i++;
    if (m[1] !== undefined) {
      nodes.push(<code key={key}>{m[1]}</code>);
    } else if (m[2] !== undefined || m[3] !== undefined) {
      nodes.push(<strong key={key}>{m[2] ?? m[3]}</strong>);
    } else if (m[4] !== undefined || m[5] !== undefined) {
      nodes.push(<em key={key}>{m[4] ?? m[5]}</em>);
    } else if (m[6] !== undefined) {
      const label = m[6];
      const href = m[7];
      if (isAllowedHref(href)) {
        nodes.push(
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>,
        );
      } else {
        // Blocked scheme (javascript:/data:/file:/relative/garbage) → inert text.
        nodes.push(<span key={key}>{label}</span>);
      }
    }
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const FENCE_RE = /^```/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^>\s?/;
const UL_RE = /^\s*[-*+]\s+/;
const OL_RE = /^\s*\d+[.)]\s+/;
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

function parseMarkdownBlocks(text) {
  const lines = (text || "").split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      i++;
      const body = [];
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence (if any)
      blocks.push({ type: "code", content: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        body.push(lines[i].replace(QUOTE_RE, ""));
        i++;
      }
      blocks.push({ type: "quote", text: body.join("\n") });
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    if (UL_RE.test(line)) {
      const items = [];
      while (i < lines.length && UL_RE.test(lines[i])) {
        items.push(lines[i].replace(UL_RE, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    if (OL_RE.test(line)) {
      const items = [];
      while (i < lines.length && OL_RE.test(lines[i])) {
        items.push(lines[i].replace(OL_RE, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }
    // paragraph: gather contiguous non-blank, non-block-starting lines
    const body = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i])
    ) {
      body.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", text: body.join("\n") });
  }
  return blocks;
}

function MiniMarkdown({ text }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return (
    <div className="markdown">
      {blocks.map((b, bi) => {
        const key = "b" + bi;
        if (b.type === "code") {
          return (
            <pre className="code-fallback" key={key}>
              <code>{b.content}</code>
            </pre>
          );
        }
        if (b.type === "heading") {
          const Tag = "h" + Math.min(6, Math.max(1, b.level));
          return <Tag key={key}>{renderInline(b.text, key)}</Tag>;
        }
        if (b.type === "quote") {
          return <blockquote key={key}>{renderInline(b.text, key)}</blockquote>;
        }
        if (b.type === "ul") {
          return (
            <ul key={key}>
              {b.items.map((it, ii) => (
                <li key={key + "-" + ii}>{renderInline(it, key + "-" + ii)}</li>
              ))}
            </ul>
          );
        }
        if (b.type === "ol") {
          return (
            <ol key={key}>
              {b.items.map((it, ii) => (
                <li key={key + "-" + ii}>{renderInline(it, key + "-" + ii)}</li>
              ))}
            </ol>
          );
        }
        if (b.type === "hr") return <hr key={key} />;
        return <p key={key}>{renderInline(b.text, key)}</p>;
      })}
    </div>
  );
}

/**
 * @param {{
 *   artifacts: ReadonlyArray<{id:string, source:"code-fence"|"tool-write", path:string|null, lang:string|null, title:string, content:string}>,
 *   pinned?: ReadonlyArray<{id:string, kind:string, title:string, lang:string|null, content:string, version:number, bridgeCaps?:string[]|null}>,
 *   artifactsCapable?: boolean,
 *   focusSignal?: {id:string, nonce:number}|null,
 *   mcp?: {readResource: (uri:string)=>Promise<any>, callTool:(appUri:string, tool:string, args:unknown)=>Promise<any>},
 *   onPin?: (a:any) => void,
 *   onUnpin?: (id:string) => void,
 * }} props
 */
export function ArtifactsPanel({ artifacts, pinned, artifactsCapable, focusSignal, mcp, onPin, onUnpin }) {
  const eph = artifacts || [];
  const pins = pinned || [];

  // Seed from the newest ephemeral, else the first pin — so a pins-only
  // panel (a reopened session whose only artifacts are durable) previews
  // something on mount instead of a blank detail area.
  const [selectedId, setSelectedId] = useState(() => eph[0]?.id ?? pins[0]?.id ?? null);

  // Auto-select newest when artifacts grow or the newest artifact's identity
  // changes. Only assigns when there's no current selection so a manual
  // click sticks. Falls back to the first pin when there is no ephemeral
  // artifact (the pins-only case).
  useEffect(() => {
    const last = eph[eph.length - 1]?.id ?? pins[0]?.id ?? null;
    if (last) setSelectedId((cur) => cur ?? last);
    // eph/pins are the exact reactive inputs (Solid's createEffect deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eph, pins]);

  // Agent-driven focus (an `open-artifact-widget` frame): select the named
  // artifact, overriding the user's current pick. The nonce forces this to
  // re-run even when the same id is focused twice in a row.
  useEffect(() => {
    if (focusSignal && focusSignal.id) setSelectedId(focusSignal.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal && focusSignal.id, focusSignal && focusSignal.nonce]);

  const pinnedIds = useMemo(() => new Set(pins.map((p) => p.id)), [pins]);
  const hasPins = artifactsCapable === true && pins.length > 0;

  // Resolve the selected display item. Search EPHEMERAL first so an
  // in-session artifact that is also pinned (same id in both lists) keeps
  // its richer `path`/provenance. Falls back to newest ephemeral, then first
  // pin, matching `artifactForDownload` below.
  const selected = useMemo(() => {
    const id = selectedId;
    const inEphemeral = eph.find((a) => a.id === id);
    if (inEphemeral) {
      return {
        id: inEphemeral.id,
        title: inEphemeral.title,
        lang: inEphemeral.lang,
        content: inEphemeral.content,
        path: inEphemeral.path,
        kind: deriveContentKind(inEphemeral.lang, inEphemeral.path),
      };
    }
    const inPinned = pins.find((p) => p.id === id);
    if (inPinned) {
      return {
        id: inPinned.id,
        title: inPinned.title,
        lang: inPinned.lang,
        content: inPinned.content,
        path: null,
        kind: inPinned.kind,
      };
    }
    const last = eph[eph.length - 1];
    if (last) {
      return {
        id: last.id,
        title: last.title,
        lang: last.lang,
        content: last.content,
        path: last.path,
        kind: deriveContentKind(last.lang, last.path),
      };
    }
    const firstPin = pins[0];
    if (firstPin) {
      return {
        id: firstPin.id,
        title: firstPin.title,
        lang: firstPin.lang,
        content: firstPin.content,
        path: null,
        kind: firstPin.kind,
      };
    }
    return null;
  }, [selectedId, eph, pins]);

  // For download we need a full Artifact shape — find it in ephemeral, or
  // synthesise one from the pinned list / display item.
  const artifactForDownload = useMemo(() => {
    if (!selected) return null;
    const found = eph.find((a) => a.id === selected.id);
    if (found) return found;
    const pin = pins.find((p) => p.id === selected.id);
    if (pin) {
      return { id: pin.id, source: "code-fence", path: null, lang: pin.lang, title: pin.title, content: pin.content };
    }
    return {
      id: selected.id,
      source: "code-fence",
      path: selected.path,
      lang: selected.lang,
      title: selected.title,
      content: selected.content,
    };
  }, [selected, eph, pins]);

  // Distinct ids — an in-session artifact that is also pinned shares its id
  // across both lists and must not be counted twice.
  const distinctCount = useMemo(() => {
    const ids = new Set();
    for (const p of pins) ids.add(p.id);
    for (const a of eph) ids.add(a.id);
    return ids.size;
  }, [pins, eph]);

  const isRich =
    selected &&
    (selected.kind === "markdown" ||
      selected.kind === "html" ||
      selected.kind === "widget" ||
      selected.kind === "mcp-app");

  return (
    <aside className="artifact-panel">
      <div className="artifact-head">
        <span>Artifacts</span>
        <span className="muted small">{distinctCount}</span>
      </div>

      {/* ── Pinned section ── */}
      {hasPins && (
        <>
          <div className="artifact-head artifact-subhead">
            <span>📌 Pinned</span>
            <span className="muted small">{pins.length}</span>
          </div>
          <div className="artifact-list">
            {pins.map((p) => (
              <div
                key={p.id}
                className={"artifact-row" + (selected && p.id === selected.id ? " selected" : "")}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(p.id)}
                onKeyDown={activateOnKey(() => setSelectedId(p.id))}
              >
                <div className="artifact-title">📌 {p.title}</div>
                <div className="artifact-meta muted small">
                  {p.kind} · v{p.version} · {formatBytes(p.content.length)}
                </div>
                {artifactsCapable === true && (
                  <Button
                    label="unpin"
                    className="chip small artifact-chip"
                    tooltip="Unpin artifact"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUnpin && onUnpin(p.id);
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Ephemeral (this session) section ── */}
      {eph.length > 0 && (
        <>
          {hasPins && (
            <div className="artifact-head artifact-subhead">
              <span>This session</span>
              <span className="muted small">{eph.length}</span>
            </div>
          )}
          <div className="artifact-list">
            {eph.map((a) => {
              const lines = countLines(a.content);
              const alreadyPinned = pinnedIds.has(a.id);
              return (
                <div
                  key={a.id}
                  className={"artifact-row" + (selected && a.id === selected.id ? " selected" : "")}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(a.id)}
                  onKeyDown={activateOnKey(() => setSelectedId(a.id))}
                >
                  <div className="artifact-title">
                    {a.source === "tool-write" ? "📄" : "📝"} {a.title}
                  </div>
                  <div className="artifact-meta muted small">
                    {a.source === "tool-write" ? a.path : a.lang || "code"} · {lines}{" "}
                    {lines === 1 ? "line" : "lines"} · {formatBytes(a.content.length)}
                  </div>
                  {artifactsCapable === true &&
                    (alreadyPinned ? (
                      <span className="chip small artifact-chip artifact-chip-static">📌 pinned</span>
                    ) : (
                      <Button
                        label="pin"
                        icon={<span aria-hidden="true">📌</span>}
                        className="chip small artifact-chip"
                        tooltip="Pin artifact"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPin && onPin(a);
                        }}
                      />
                    ))}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Detail view ── */}
      {selected && (
        <div className="artifact-view">
          <div className="artifact-view-head">
            <span className="small" title={selected.path || undefined}>
              {selected.path || selected.title}
            </span>
            <span className="artifact-view-spacer" />
            <Button
              label="download"
              icon={<span aria-hidden="true">⬇</span>}
              className="chip"
              tooltip="Download as file"
              onClick={() => artifactForDownload && downloadArtifact(artifactForDownload)}
            />
            <Button
              label="copy"
              icon={<span aria-hidden="true">⧉</span>}
              className="chip"
              tooltip="Copy to clipboard"
              onClick={() => {
                navigator.clipboard?.writeText(selected.content).catch(() => {
                  // ignore — clipboard unavailable or denied
                });
              }}
            />
          </div>
          <div className={"artifact-content" + (isRich ? " is-rich" : "")}>
            {selected.kind === "markdown" && <MiniMarkdown text={selected.content} />}
            {selected.kind === "html" && (
              <iframe
                className="artifact-iframe"
                title={selected.title + " (HTML preview)"}
                sandbox={SANDBOX_ATTR}
                referrerPolicy="no-referrer"
                srcDoc={buildMcpSrcdoc(selected.content)}
              />
            )}
            {(selected.kind === "widget" || selected.kind === "mcp-app") && (
              <WidgetFrame
                artifact={{ id: selected.id, kind: selected.kind, title: selected.title, content: selected.content }}
                mcp={mcp}
              />
            )}
            {selected.kind !== "markdown" &&
              selected.kind !== "html" &&
              selected.kind !== "widget" &&
              selected.kind !== "mcp-app" && (
                <pre className="code-fallback">
                  <code>{selected.content}</code>
                </pre>
              )}
          </div>
        </div>
      )}
    </aside>
  );
}
