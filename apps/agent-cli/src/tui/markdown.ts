export type Span =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "bold"; readonly text: string }
  | { readonly type: "italic"; readonly text: string }
  | { readonly type: "code"; readonly text: string }

export type MdNode =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "paragraph"; readonly spans: ReadonlyArray<Span> }
  | { readonly kind: "code"; readonly lang: string | null; readonly lines: ReadonlyArray<string> }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: ReadonlyArray<string> }

const parseInline = (s: string): ReadonlyArray<Span> => {
  const spans: Span[] = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*/g
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) spans.push({ type: "text", text: s.slice(last, m.index) })
    if (m[1] !== undefined) spans.push({ type: "bold", text: m[1] })
    else if (m[2] !== undefined) spans.push({ type: "code", text: m[2] })
    else if (m[3] !== undefined) spans.push({ type: "italic", text: m[3] })
    last = re.lastIndex
  }
  if (last < s.length) spans.push({ type: "text", text: s.slice(last) })
  return spans
}

export const parseMarkdown = (src: string): ReadonlyArray<MdNode> => {
  const lines = src.split("\n")
  const nodes: MdNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || null
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith("```")) { body.push(lines[i]!); i++ }
      i++ // closing fence
      nodes.push({ kind: "code", lang, lines: body })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { nodes.push({ kind: "heading", level: h[1]!.length, text: h[2]! }); i++; continue }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) { items.push(lines[i]!.replace(/^[-*]\s+/, "")); i++ }
      nodes.push({ kind: "list", ordered: false, items })
      continue
    }
    if (line.trim() === "") { i++; continue }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("```") && !/^(#{1,6})\s/.test(lines[i]!) && !/^[-*]\s+/.test(lines[i]!)) {
      para.push(lines[i]!); i++
    }
    nodes.push({ kind: "paragraph", spans: parseInline(para.join(" ")) })
  }
  return nodes
}
