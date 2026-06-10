/**
 * Persisted-artifact domain types (PRD Part C, W1 — §19).
 *
 * The ephemeral `Artifact` (packages/chat-service/src/artifacts.ts, mirrored
 * in ui-shared/wire.ts) is recomputed per session and evaporates. A *pinned*
 * artifact is the durable form: an `artifacts` row in luna.db plus an
 * append-only `artifact_versions` ledger that gives Space-Agent time-travel
 * (every edit is a row; revert copies an old version forward).
 *
 * `widget` is the kind set by describe-to-spawn (W4) — a self-contained
 * HTML/JS bundle rendered in a sandboxed iframe. For W1 it is only ever set
 * explicitly; {@link deriveArtifactKind} never produces it.
 */

export type ArtifactKind = "code" | "markdown" | "html" | "widget"

/** Who authored a version — drives the time-travel ledger's `edited_by`. */
export type ArtifactEditor = "user" | "agent"

export interface PinnedArtifact {
  readonly id: string
  readonly kind: ArtifactKind
  readonly title: string
  readonly lang: string | null
  /** Current (head) content — denormalized copy of the latest version row. */
  readonly content: string
  /** Provenance: the `threadId:messageSeq` it was pinned from, when known. */
  readonly origin: string | null
  /** Widget-only luna.* bridge allowlist (§16); null for non-widget kinds. */
  readonly bridgeCaps: ReadonlyArray<string> | null
  /** Head version number (= MAX(version) in artifact_versions). Starts at 1. */
  readonly version: number
  readonly pinnedAt: number
  readonly updatedAt: number
}

export interface ArtifactVersion {
  readonly artifactId: string
  readonly version: number
  readonly content: string
  readonly editedBy: ArtifactEditor
  readonly createdAt: number
}

/** Input to {@link ArtifactStoreApi.pin}. `id` is supplied by the caller —
 *  the ephemeral artifact's stable `${messageId}:${index}` when pinning from
 *  chat, or a freshly minted id for an agent-authored widget (W4). */
export interface PinInput {
  readonly id: string
  readonly kind?: ArtifactKind
  readonly title: string
  readonly lang?: string | null
  readonly content: string
  readonly origin?: string | null
  readonly bridgeCaps?: ReadonlyArray<string> | null
  /** Who pinned it; the first version's `edited_by`. Defaults to "user". */
  readonly editedBy?: ArtifactEditor
}

/**
 * Classify an artifact from its language hint and/or file path. Pure and
 * deterministic so both the store and the UI can agree on a kind without a
 * round-trip. Never returns "widget" — that kind is only ever set explicitly
 * by the describe-to-spawn flow.
 */
export const deriveArtifactKind = (
  lang: string | null | undefined,
  path: string | null | undefined,
): ArtifactKind => {
  const l = (lang ?? "").toLowerCase().trim()
  const p = (path ?? "").toLowerCase().trim()
  if (l === "html" || l === "htm" || p.endsWith(".html") || p.endsWith(".htm")) {
    return "html"
  }
  if (
    l === "md" ||
    l === "markdown" ||
    p.endsWith(".md") ||
    p.endsWith(".markdown")
  ) {
    return "markdown"
  }
  return "code"
}
