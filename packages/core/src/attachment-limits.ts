/**
 * Attachment ingestion limits — the SINGLE source of truth for which media
 * types Luna accepts as user-message attachments and how large they may be.
 *
 * Consumed by every inbound surface that turns user files into Anthropic
 * content blocks (ui-ws WebSocket uploads, Telegram channel downloads, …).
 * Keeping one copy prevents the silent-divergence failure where a file
 * accepted on one surface is rejected downstream on another.
 *
 * Limits follow the Anthropic content-block limits:
 *   - mediaType ∈ { image/jpeg, image/png, image/gif, image/webp, application/pdf }
 *   - decoded size ≤ 10 MB per image, ≤ 20 MB per PDF
 *   - turn total decoded ≤ 20 MB (base64 ≈ 27 MB, under the 32 MB API request ceiling)
 *   - ≤ 8 attachments per turn
 */

export const ALLOWED_ATTACHMENT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
])

/** Anthropic per-image base64 limit (decoded bytes). */
export const MAX_IMAGE_RAW_BYTES = 10 * 1024 * 1024

/** PDFs are large and can't be downscaled (decoded bytes). */
export const MAX_PDF_RAW_BYTES = 20 * 1024 * 1024

/** Sum of decoded bytes per turn; base64 ≈ 27 MB < 32 MB request ceiling. */
export const MAX_TURN_RAW_BYTES = 20 * 1024 * 1024

/** Defence-in-depth on top of transport-level payload caps. */
export const MAX_ATTACHMENTS_PER_TURN = 8

/** Per-type decoded-size cap for a single attachment. */
export const attachmentByteCap = (mediaType: string): number =>
  mediaType === "application/pdf" ? MAX_PDF_RAW_BYTES : MAX_IMAGE_RAW_BYTES
