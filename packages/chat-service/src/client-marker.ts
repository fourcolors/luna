/**
 * client-marker.ts — small formatter that prepends a one-line client-identity
 * hint to a user message so Luna can see which surface the operator is
 * typing through.
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

const formatClientMarker = (c: ClientMarkerInput): string => {
  const tail: string[] = []
  if (c.version !== undefined && c.version.length > 0) tail.push(c.version)
  if (c.platform !== undefined && c.platform.length > 0) tail.push(`on ${c.platform}`)
  return tail.length === 0
    ? `[client: ${c.name}]`
    : `[client: ${c.name} ${tail.join(" ")}]`
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
  // Defensive: an empty name field would produce `[client: ]` which is just
  // noise. Treat empty-name as "no client info" — same as undefined.
  if (client.name.trim().length === 0) return text
  return `${formatClientMarker(client)}\n${text}`
}
