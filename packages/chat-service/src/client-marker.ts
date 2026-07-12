/**
 * client-marker.ts — small formatter that prepends a one-line client-identity
 * hint to a user message so Luna can see which surface the operator is
 * typing through, plus the inverse (`stripClientMarker`) for consumers of
 * stored payloads that need the raw user text back.
 *
 * The marker is intentionally compact and inline so it costs almost no
 * prompt budget and reads naturally to Luna:
 *
 *   [client: luna-moon 0.0.1 on darwin]
 *   hey luna, can you …
 *
 * If `client.version` and `client.platform` are both missing, the marker
 * degrades cleanly to `[client: luna-moon]`. If `client` itself is null /
 * undefined, the text passes through unmodified — older clients keep
 * working untouched.
 */

export interface ClientMarkerInput {
  readonly name: string
  readonly version?: string
  readonly platform?: string
}

/**
 * Keep a marker field on ONE clean line: drop the bracket characters that
 * delimit the marker and collapse any newline/whitespace run to a single
 * space. Without this an adversarial or malformed `ClientInfo` (a name with a
 * newline or `]`) could inject a second line or a premature `]`, which
 * `stripClientMarker` could then only partially remove.
 */
const sanitizeField = (s: string): string =>
  s.replace(/[[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim()

const formatClientMarker = (c: ClientMarkerInput): string => {
  const name = sanitizeField(c.name)
  const tail: string[] = []
  if (c.version !== undefined) {
    const v = sanitizeField(c.version)
    if (v.length > 0) tail.push(v)
  }
  if (c.platform !== undefined) {
    const p = sanitizeField(c.platform)
    if (p.length > 0) tail.push(`on ${p}`)
  }
  return tail.length === 0
    ? `[client: ${name}]`
    : `[client: ${name} ${tail.join(" ")}]`
}

/**
 * Prepend the marker to `text` if `client` is provided; otherwise return
 * `text` unchanged. Pure, no IO.
 */
export const applyClientMarker = (
  text: string,
  client: ClientMarkerInput | undefined,
): string => {
  if (client === undefined) return text
  // Defensive: an empty (or bracket/whitespace-only) name would produce
  // `[client: ]` which is just noise. Treat it as "no client info".
  if (sanitizeField(client.name).length === 0) return text
  return `${formatClientMarker(client)}\n${text}`
}

/**
 * Inverse of `applyClientMarker`: drop a leading `[client: ...]` line (plus
 * its newline) so consumers of STORED payloads recover the raw user text.
 * Text without a marker passes through unchanged. Pure, no IO.
 */
export const stripClientMarker = (text: string): string => {
  if (!text.startsWith("[client: ")) return text
  const newline = text.indexOf("\n")
  const firstLine = newline === -1 ? text : text.slice(0, newline)
  if (!firstLine.endsWith("]")) return text
  return newline === -1 ? "" : text.slice(newline + 1)
}
