/**
 * Browser download helper for artifact content. Framework-agnostic so
 * both the React app and the Solid port can call it.
 *
 * Hoisted from apps/ui-web/src/App.tsx. Same filename derivation
 * fallback chain: explicit path basename → sanitized title → id-based
 * default. Revokes the object URL on next tick so the download has
 * time to start.
 *
 * Pure DOM API (Blob + URL.createObjectURL + anchor click) — no
 * framework imports.
 */
import type { Artifact } from "./wire.js"

export const downloadArtifact = (a: Artifact): void => {
  const filename =
    (a.path && a.path.split("/").pop()) ||
    (a.title && a.title.replace(/[^\w.\-]+/g, "_")) ||
    `artifact-${a.id}.txt`
  const blob = new Blob([a.content], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  // Revoke on next tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
