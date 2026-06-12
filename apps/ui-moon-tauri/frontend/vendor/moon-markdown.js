/**
 * moon-markdown.js — the markdown render pipeline shared by Moon host pages
 * (index.html hub + chat.html). Extracted VERBATIM from index.html (Phase 4,
 * design/widget-system.md "Monolith Decomposition"): renderMarkdown,
 * closeOpenFences, renderMarkdownStreaming, enhanceCodeBlocks, StreamRender.
 * The pipeline is pure (DOM-in/DOM-out, no app State), which is what makes
 * this a vendor module rather than an engine.
 *
 * Plain-script IIFE (no build step) — attaches `LunaMarkdown` to globalThis,
 * same convention as moon-protocol.js / moon-ws.js / moon-dock.js.
 */
(function (g) {
  'use strict';

    /**
     * Minimal, security-first Markdown -> HTML for assistant messages.
     *
     * Strategy: pull code spans/blocks out FIRST, then HTML-escape EVERYTHING
     * (incl. `"` for attribute safety), then apply a fixed set of transforms that
     * only ever emit tags/attributes we control. Because the source is escaped
     * before any transform runs, model output cannot inject raw HTML or
     * event-handler attributes. The two attribute surfaces are locked down:
     *   - link href: scheme allowlist (http/https/mailto) + plain-text fallback
     *   - code-fence language: allowlisted to [A-Za-z0-9] before -> class="language-X"
     * Covers fenced+inline code, bold, italic, links, h1-h3, blockquote,
     * unordered/ordered lists, paragraphs, GFM tables (left/right/center alignment).
     * (No nested blocks / reference links.)
     */
    function renderMarkdown(src) {
      const FENCE = '\uE000', CODE = '\uE001'; // sentinels survive escaping & match no inline regex
      const fences = [], spans = [];
      let text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');

      // 1) Extract fenced code blocks (raw contents stashed, re-escaped on re-insert)
      text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
        const safeLang = /^[A-Za-z0-9]+$/.test(lang.trim()) ? lang.trim() : '';
        fences.push({ lang: safeLang, code: code.replace(/\n+$/, '') });
        return `\n${FENCE}${fences.length - 1}${FENCE}\n`;
      });
      // 2) Extract inline code
      text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
        spans.push(code);
        return `${CODE}${spans.length - 1}${CODE}`;
      });

      // 3) Escape ALL HTML (incl. quotes -> closes the attribute-breakout surface)
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      text = esc(text);

      // 4) Inline transforms — run on already-escaped text, emit only safe tags
      const inline = (s) => {
        // links [label](url): validate scheme; on failure render as plain text
        s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) =>
          /^(https?:|mailto:)/i.test(url) ? `<a href="${url}">${label}</a>` : `${label} (${url})`);
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
        s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
        return s;
      };

      // 5) Block assembly, line by line
      const lines = text.split('\n');
      let html = '', para = [], i = 0;
      const flush = () => { if (para.length) { html += `<p>${inline(para.join('\n'))}</p>`; para = []; } };
      while (i < lines.length) {
        const line = lines[i];
        const fm = line.match(new RegExp(`^${FENCE}(\\d+)${FENCE}$`));
        if (fm) {
          flush();
          const f = fences[+fm[1]];
          const cls = f.lang ? ` class="language-${f.lang}"` : '';
          // Wrap in .code-block container so the editor chrome (lang chip +
          // copy button) has a place to live. enhanceCodeBlocks() runs after
          // innerHTML swap and decorates each new wrapper with highlight.js
          // tokens + a wired copy button. The inner <pre><code> shape is
          // preserved so existing tests that grep for it keep passing.
          const langAttr = f.lang ? ` data-lang="${f.lang}"` : '';
          const langChip = f.lang ? f.lang : '';
          html += `<div class="code-block"${langAttr}>`
               + `<div class="code-block-header">`
               + `<span class="code-block-lang">${langChip}</span>`
               + `<button class="code-block-copy" type="button" aria-label="Copy code">Copy</button>`
               + `</div>`
               + `<pre><code${cls}>${esc(f.code)}</code></pre>`
               + `</div>`;
          i++; continue;
        }
        if (/^\s*$/.test(line)) { flush(); i++; continue; }
        // Horizontal rule: a line that is ONLY ---, ***, or ___ (3+ of the
        // same char, optional surrounding whitespace). Skipped if the next
        // line looks like a table separator continuation (the table branch
        // below catches that case before we reach this guard via the sep
        // probe, so this is just bare HR).
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); html += '<hr>'; i++; continue; }
        const hm = line.match(/^(#{1,3})\s+(.*)$/);
        if (hm) { flush(); html += `<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`; i++; continue; }
        if (/^&gt;\s?/.test(line)) {
          flush();
          const q = [];
          while (i < lines.length && /^&gt;\s?/.test(lines[i])) { q.push(lines[i].replace(/^&gt;\s?/, '')); i++; }
          html += `<blockquote>${inline(q.join('\n'))}</blockquote>`;
          continue;
        }
        if (/^\s*[-*+]\s+/.test(line)) {
          flush();
          const items = [];
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
          html += `<ul>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>`;
          continue;
        }
        if (/^\s*\d+\.\s+/.test(line)) {
          flush();
          const items = [];
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
          html += `<ol>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ol>`;
          continue;
        }
        // GFM-style table: a header row of `| col | col |` followed by a
        // separator row of `|---|---|` (cells may be `:---`, `---:`, `:---:`
        // for left/right/center alignment). The header row may be empty
        // cells (`| | |`) — we honour that and emit no <thead> in that case.
        const sep = lines[i + 1] || '';
        if (line.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(sep)) {
          flush();
          const splitRow = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
          const aligns = splitRow(sep).map((c) => {
            const L = c.startsWith(':'), R = c.endsWith(':');
            if (L && R) return 'center';
            if (R) return 'right';
            if (L) return 'left';
            return null;
          });
          const headers = splitRow(line);
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i]) && !lines[i].match(new RegExp(`^${FENCE}\\d+${FENCE}$`))) {
            rows.push(splitRow(lines[i]));
            i++;
          }
          const cellStyle = (j) => aligns[j] ? ` style="text-align:${aligns[j]}"` : '';
          const headerHasContent = headers.some((c) => c.length > 0);
          let table = '<table>';
          if (headerHasContent) {
            table += '<thead><tr>';
            for (let j = 0; j < headers.length; j++) {
              table += `<th${cellStyle(j)}>${inline(headers[j])}</th>`;
            }
            table += '</tr></thead>';
          }
          table += '<tbody>';
          for (const row of rows) {
            table += '<tr>';
            for (let j = 0; j < headers.length; j++) {
              table += `<td${cellStyle(j)}>${inline(row[j] ?? '')}</td>`;
            }
            table += '</tr>';
          }
          table += '</tbody></table>';
          html += table;
          continue;
        }
        para.push(line); i++;
      }
      flush();

      // 6) Re-insert inline code with escaped contents
      return html.replace(new RegExp(`${CODE}(\\d+)${CODE}`, 'g'), (_m, n) => `<code>${esc(spans[+n])}</code>`);
    }

    /**
     * Streaming-safe wrapper around renderMarkdown(). An in-progress stream
     * routinely contains an unbalanced ``` opener; without intervention the
     * fence regex inside renderMarkdown() fails to match, so everything
     * after the opener renders as raw paragraphs/lists and then suddenly
     * snaps into a <pre><code> block once the closer arrives. We pre-close
     * the dangling fence so the parser always sees a balanced document.
     * Mirrors closeOpenFences() in packages/ui-shared/src/streaming.ts.
     */
    function closeOpenFences(src) {
      if (!src) return src;
      const m = src.match(/```/g);
      if (!m || m.length % 2 === 0) return src;
      return src.endsWith('\n') ? `${src}\`\`\`` : `${src}\n\`\`\``;
    }
    function renderMarkdownStreaming(src) {
      return renderMarkdown(closeOpenFences(src));
    }

    /**
     * Decorate freshly-rendered code blocks with editor chrome:
     *   - Syntax-highlight the <code> body via highlight.js (when available).
     *   - Wire the .code-block-copy button to copy the raw code to clipboard.
     * Idempotent per element via a data-enhanced flag, BUT each renderMarkdown
     * pass re-creates the DOM (innerHTML swap), so in practice every render
     * gets a fresh decorate. We accept that cost — highlight.js on small
     * snippets is <2ms and the streaming path coalesces re-renders via rAF.
     *
     * Degrades gracefully when window.hljs is undefined (e.g. mid-app-launch
     * before the vendor script has parsed, or in tests that don't load it):
     * the copy button still works, the code just stays monochrome.
     */
    function enhanceCodeBlocks(root) {
      if (!root || !root.querySelectorAll) return;
      const hljs = (typeof window !== 'undefined') ? window.hljs : null;
      const blocks = root.querySelectorAll('.code-block');
      for (const block of blocks) {
        const code = block.querySelector('pre > code');
        if (!code) continue;

        // Run highlight.js once per code element. Re-renders replace the
        // DOM wholesale, so we don't need to worry about double-highlighting.
        if (hljs && !code.dataset.hljsApplied) {
          try {
            const langClass = Array.from(code.classList).find((c) => c.startsWith('language-'));
            const lang = langClass ? langClass.slice('language-'.length) : null;
            const raw = code.textContent != null ? code.textContent : '';
            if (lang && hljs.getLanguage && hljs.getLanguage(lang)) {
              const out = hljs.highlight(raw, { language: lang, ignoreIllegals: true });
              code.innerHTML = out.value;
            } else if (!lang && hljs.highlightAuto) {
              const out = hljs.highlightAuto(raw);
              code.innerHTML = out.value;
              if (out.language) {
                code.classList.add('language-' + out.language);
                block.dataset.lang = out.language;
                const chip = block.querySelector('.code-block-lang');
                if (chip && !chip.textContent) chip.textContent = out.language;
              }
            }
            code.classList.add('hljs');
            code.dataset.hljsApplied = '1';
          } catch (_e) { /* never break rendering on a highlighter throw */ }
        }

        // Wire the copy button (idempotent — checked via dataset flag).
        const btn = block.querySelector('.code-block-copy');
        if (btn && !btn.dataset.copyWired) {
          btn.dataset.copyWired = '1';
          btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            // Read from the live <code> textContent (post-highlight, the
            // visible text is still the original source thanks to <span>s).
            const text = code.textContent != null ? code.textContent : '';
            const flashDone = () => {
              btn.textContent = 'Copied';
              btn.dataset.copyState = 'done';
              setTimeout(() => {
                btn.textContent = 'Copy';
                btn.dataset.copyState = 'idle';
              }, 1200);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(flashDone, flashDone);
            } else {
              // execCommand fallback for older WKWebView contexts.
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.select();
              try { document.execCommand('copy'); } catch (_) {}
              document.body.removeChild(ta);
              flashDone();
            }
          });
        }
      }
    }

    /**
     * Coalesces rapid assistant-delta updates into one re-render per
     * animation frame, keyed per-bubble. Without this, a fast token
     * stream re-parses the message ~50× per second and the cumulative
     * cost of HTML-escape + fence/inline regex passes shows up as
     * scroll-jank on long messages. With rAF, multiple deltas in the
     * same 16ms slice collapse to a single innerHTML swap.
     *
     * Each bubble carries `data-stream-raw` (the cumulative raw text) and
     * `data-stream-frame` (the pending rAF id, if any). `schedule()` is
     * idempotent within a frame; `flush()` forces an immediate render
     * (used by assistant-done so the final canonical text wins the race
     * against a still-pending frame).
     */
    // StandaloneBubbleStream — markdown streaming for a single arbitrary
    // DOM element. After the thread-state refactor, production rendering
    // goes through ChatState + ChatRenderer; this helper exists only so the
    // pure-render test suite (and any future ad-hoc UI) can stream markdown
    // into a free-standing <div>. Each call coalesces via rAF; finalize()
    // cancels any pending frame and writes canonical text.
    const StreamRender = {
      schedule(bubble) {
        if (!bubble) return;
        if (bubble.dataset.streamFrame) return;
        bubble.dataset.streamFrame = 'pending';
        const id = requestAnimationFrame(() => {
          delete bubble.dataset.streamFrame;
          const raw = bubble.dataset.streamRaw != null ? bubble.dataset.streamRaw : '';
          bubble.innerHTML = renderMarkdownStreaming(raw);
          enhanceCodeBlocks(bubble);
        });
        if (bubble.dataset.streamFrame === 'pending') {
          bubble.dataset.streamFrame = String(id);
        }
      },
      cancel(bubble) {
        if (!bubble || !bubble.dataset.streamFrame) return;
        cancelAnimationFrame(Number(bubble.dataset.streamFrame));
        delete bubble.dataset.streamFrame;
      },
      append(bubble, delta) {
        if (!bubble) return;
        bubble.dataset.streamRaw = (bubble.dataset.streamRaw != null ? bubble.dataset.streamRaw : '') + String(delta || '');
        this.schedule(bubble);
      },
      reset(bubble, text) {
        if (!bubble) return;
        bubble.dataset.streamRaw = text != null ? text : '';
        this.schedule(bubble);
      },
      finalize(bubble, finalText) {
        if (!bubble) return;
        this.cancel(bubble);
        delete bubble.dataset.streamRaw;
        bubble.innerHTML = renderMarkdown(finalText != null ? finalText : '');
        enhanceCodeBlocks(bubble);
      },
    };

  g.LunaMarkdown = {
    renderMarkdown: renderMarkdown,
    closeOpenFences: closeOpenFences,
    renderMarkdownStreaming: renderMarkdownStreaming,
    enhanceCodeBlocks: enhanceCodeBlocks,
    StreamRender: StreamRender,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
