/**
 * Attachment helpers — framework-agnostic.
 *
 * Hoisted out of apps/ui-web/src/App.tsx so the Solid app
 * (apps/ui-web-solid) can reuse the same File → base64 conversion,
 * media-type allowlist, and size limits without re-implementing them.
 *
 * Stays a leaf module: no React, no Solid, no DOM event types — just
 * `File`, `FileReader`, `URL.createObjectURL` (all standard browser
 * APIs available wherever this package is used).
 */
import type { ChatAttachment } from "./wire.js"

/**
 * In-progress attachment held by the composer. `previewUrl` is an
 * object URL for the <img> thumbnail; the owning component is
 * responsible for revoking it when the attachment is removed or the
 * composer unmounts.
 */
export interface PendingAttachment {
  readonly id: string
  readonly name: string
  readonly mediaType: ChatAttachment["mediaType"]
  /** Raw base64 (no `data:` prefix). */
  readonly data: string
  /** Object URL for thumbnail; caller must revoke. */
  readonly previewUrl: string
}

/** Media types accepted by the server-side validateAttachments check. */
export const ALLOWED_ATTACH_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

/** Per-file raw byte cap. Mirrors server-side MAX_ATTACH_RAW_BYTES. */
export const MAX_ATTACH_BYTES = 4 * 1024 * 1024 // 4 MB

const newAttachmentId = (): string =>
  `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`

/**
 * Read a `File` into a `PendingAttachment`. Rejects with a user-facing
 * error message if the type is disallowed or the file exceeds the size
 * cap.
 */
export const fileToAttachment = (file: File): Promise<PendingAttachment> =>
  new Promise((resolve, reject) => {
    if (!ALLOWED_ATTACH_TYPES.has(file.type)) {
      reject(
        new Error(
          `Unsupported type: ${file.type}. Use JPEG, PNG, GIF, or WebP.`,
        ),
      )
      return
    }
    if (file.size > MAX_ATTACH_BYTES) {
      reject(new Error(`Image too large (max 4 MB): ${file.name}`))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const data = dataUrl.split(",")[1] ?? ""
      resolve({
        id: newAttachmentId(),
        name: file.name,
        mediaType: file.type as ChatAttachment["mediaType"],
        data,
        previewUrl: URL.createObjectURL(file),
      })
    }
    reader.onerror = () =>
      reject(new Error(`Failed to read file: ${file.name}`))
    reader.readAsDataURL(file)
  })
