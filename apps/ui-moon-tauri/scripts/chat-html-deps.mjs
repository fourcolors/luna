#!/usr/bin/env node
/**
 * chat-html-deps.mjs - which top-level names does a chat.html span reference?
 *
 * WHY THIS EXISTS. The stack23 conversion moves engines out of chat.html one
 * at a time, and a move is only legal when every name the engine reaches is
 * ALREADY reachable from a module (the OUTBOUND-EDGE RULE in
 * docs/next/stack23-slices.md). Twice - S19c and S19d - I wrote that list by
 * reading the code and got it wrong, which costs a red suite and a retry.
 *
 * Its first real run paid for itself: VoiceEngine looked like the obvious next
 * slice and turned out to reference seven top-level names including ChatEngine
 * and LocalShell, so it was blocked. LocalShell reached four, all available.
 * The tool picked the slice.
 *
 * IT IS A LEXICAL APPROXIMATION, NOT A PARSER, and that is the right trade
 * here: it errs toward reporting MORE dependencies than exist (a name inside a
 * comment or string counts), so it can produce a false "blocked" but never a
 * false "safe". Verify a surprising hit by reading it; never skip one.
 *
 *   node apps/ui-moon-tauri/scripts/chat-html-deps.mjs <startLine> <endLine>
 *   node apps/ui-moon-tauri/scripts/chat-html-deps.mjs --find VoiceEngine
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const CHAT_HTML = join(here, "..", "frontend-react", "chat.html")
const lines = readFileSync(CHAT_HTML, "utf8").split("\n")

/** Locate `const <name> = {` ... `};` at chat.html's top level (indent 4). */
function findSpan(name) {
  const i = lines.findIndex((l) => l.trim() === `const ${name} = {`)
  if (i < 0) return null
  let j = i
  while (j < lines.length && lines[j] !== "    };") j++
  return [i + 1, j + 1]
}

function report(start, end) {
  const span = lines.slice(start - 1, end).join("\n")
  const outsideDecl = new Set()
  for (const l of lines) {
    const m = /^ {4}(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(l)
    if (m) outsideDecl.add(m[1])
  }
  const declaredInside = new Set()
  for (const l of lines.slice(start - 1, end)) {
    for (const m of l.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
      declaredInside.add(m[1])
    }
  }
  const used = new Set(span.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [])
  const deps = [...outsideDecl].filter((n) => used.has(n) && !declaredInside.has(n)).sort()
  const dom = [...new Set([...span.matchAll(/\bDOM\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))].sort()

  console.log(`lines ${start}-${end}  (${end - start + 1} lines)`)
  console.log("  top-level deps:", deps.length ? deps.join(", ") : "(none - a pure leaf)")
  console.log("  DOM members   :", dom.length ? dom.join(", ") : "(none)")
}

const [a, b] = process.argv.slice(2)
if (a === "--find") {
  const span = findSpan(b)
  if (!span) {
    console.error(`no top-level \`const ${b} = {\` in chat.html`)
    process.exit(1)
  }
  console.log(`${b}:`)
  report(span[0], span[1])
} else if (a && b) {
  report(Number(a), Number(b))
} else {
  console.error("usage: chat-html-deps.mjs <start> <end> | --find <Name>")
  process.exit(1)
}
