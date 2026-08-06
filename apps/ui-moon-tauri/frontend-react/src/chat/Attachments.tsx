/**
 * Attachments.tsx - the composer's staged-attachment tray, a React
 * replacement for chat.html's former inline `Attachments` object (stack23
 * S16a). Owns the decode/classify/downscale pipeline (unchanged) and paints
 * `#attachments-strip` (the chip tray) and `#attach-error` (the validation
 * message) via React, instead of the vanilla `render()`'s manual per-chip
 * `document.createElement` + `appendChild` DOM building.
 *
 * WIRED INTO chat.html via main-chat.tsx's `type="module"` script, which
 * calls `mountAttachments` and patches chat.html's `Attachments` bare
 * identifier the same way it already does for `ChatState`/`ChatLoop` (see
 * MessageList.tsx's module doc). React must be mounted from inside that one
 * bundled module graph only - do not add a second, independent inline
 * `type="module"` script to chat.html; under the dev server it loads a
 * second copy of react/react-dom and throws "Invalid hook call", leaving the
 * mounted tree non-interactive (all behavior below is covered by
 * Attachments.test.tsx, including a real DOM click driving `remove()`).
 * main-chat.tsx's single bundled module graph is the only mount path.
 *
 * `mountAttachments` returns a legacy-shaped `{ Attachments }` bridge with
 * the EXACT external method surface chat.html's inline script and the
 * existing test suite (chat-window.test.ts, slash-menu.test.ts) already call
 * against the vanilla object (`addFiles`/`remove`/`clear`/`hasAny`/
 * `wireAttachments`/`textBlock`/`previews`/`setError`/`classify`/
 * `IMAGE_TYPES`), plus a plain `items` get/set property - some call sites and
 * tests assign `Attachments.items = [...]` directly, bypassing every method.
 * The setter alone does NOT repaint (matches the vanilla behavior of writing
 * a bare field) - but only in isolation: the strip and error views share one
 * store, so ANY later call that does notify (`setError`/`clear`/`addFiles`/
 * `remove`/`render`) flushes a deferred `items` write too and paints both
 * trays together, where the vanilla `setError` touched only `DOM.attachError`.
 * `render()` forces a synchronous repaint from whatever `items`/error state
 * currently holds via `flushSync`, matching MessageList.tsx's `ChatLoop.flush()`.
 *
 * Two DOM roots: `#attachments-strip` (chip tray) and `#attach-error`
 * (message), both mounted from the SAME store so a `setError` call re-paints
 * both trees consistently - see mountAttachments below. Each container
 * element's own `hidden` attribute is toggled imperatively (a `useLayoutEffect`
 * on the container itself, not something the mounted children can reach),
 * mirroring the former `render()`'s own `strip.hidden = ...` / the vanilla
 * `setError`'s `DOM.attachError.hidden = ...`.
 */
import { useLayoutEffect, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"

// ============================================================================
// Types
// ============================================================================

export type AttachmentKind = "image" | "text" | "pdf" | "binary"

export interface AttachmentItem {
  readonly id: string
  readonly kind: AttachmentKind
  readonly name: string
  readonly mediaType?: string
  /** base64 payload - image and pdf kinds. */
  readonly data?: string
  /** decoded contents - text kind. */
  readonly text?: string
}

export interface WireAttachment {
  readonly mediaType: string
  readonly data: string
}

export interface AttachmentPreview {
  readonly kind: string
  readonly name: string
  readonly src: string | null
}

interface AttachmentsState {
  readonly items: readonly AttachmentItem[]
  readonly error: string | null
}

// ============================================================================
// Constants - ported 1:1 from the vanilla Attachments object.
// ============================================================================

// Mirror server-side validateAttachments (packages/ui-ws/src/server.ts).
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const MAX_IMAGE_BYTES = 4 * 1024 * 1024 // 4 MB - matches server MAX_ATTACH_RAW_BYTES
const MAX_TEXT_BYTES = 256 * 1024 // fold-as-text guard (keeps prompts sane)
const MAX_PER_TURN = 8 // matches MAX_ATTACHMENTS_PER_TURN
// Downscale every non-GIF image so its long edge <= this before sending.
// 1568px is the universal model-native resolution (Luna pools models, so we
// take the safe lower bound, not Opus's 2576) - larger is wasted bytes +
// tokens. Downscaling keeps images under MAX_IMAGE_BYTES, so the server
// contract (4 MB cap, 8 MB WS frame) needs NO change for the image path.
const MAX_EDGE = 1568
// Reject absurd originals before trying to decode them into a canvas.
const HARD_INPUT_BYTES = 40 * 1024 * 1024
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm",
  "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "swift", "sh", "bash", "zsh", "sql", "toml",
  "ini", "cfg", "conf", "env", "log", "tex", "r", "lua", "pl", "dart", "vue", "svelte",
])
// Server accepts application/pdf document blocks as of the PDF slice
// (protocol.ts + server.ts + buildUserMessage; SDK passthrough spiked).
const PDF_ENABLED = true
const MAX_PDF_BYTES = 20 * 1024 * 1024 // matches server MAX_PDF_RAW_BYTES
// Decoded-bytes budget for one turn. Mirrors server MAX_TURN_RAW_BYTES. MUST
// be enforced client-side: a turn whose base64 exceeds the 32MB WS maxPayload
// is dropped with code 1009 BEFORE validateAttachments runs, so the server
// can't return a friendly error - only this guard can.
const MAX_TURN_BYTES = 20 * 1024 * 1024

/**
 * Render an attached text/code file into the outgoing message text.
 *
 * ---- DESIGN DECISION ----------------------------------------------------
 * When a user attaches `report.csv` or `main.py`, its contents get folded
 * into the prompt text we send to Claude. HOW we wrap it materially changes
 * how reliably the model treats it as a discrete file vs. blurs it into your
 * instructions. Options worth weighing:
 *   - XML-style tags  <file name="x">...</file>  - Claude is trained to
 *     respect these as hard delimiters; robust against prompt-bleed.
 *   - Fenced code block  ```name ... ```          - familiar, but breaks if
 *     the file itself contains a ``` fence.
 *   - Plain header + body                         - simplest, weakest
 *     boundary.
 * Default below uses XML-style tags. This is the lever on how Claude
 * perceives attached files - tune to taste.
 * ---------------------------------------------------------------------------
 */
function formatTextAttachment(name: string, content: string): string {
  return `<attached-file name="${name}">\n${content}\n</attached-file>`
}

function newId(): string {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function classify(file: { readonly type: string; readonly name: string }): AttachmentKind {
  if (IMAGE_TYPES.has(file.type)) return "image"
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf"
  const ext = (file.name.split(".").pop() || "").toLowerCase()
  if ((file.type && file.type.startsWith("text/")) || TEXT_EXTS.has(ext)) return "text"
  return "binary"
}

function b64Bytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4)
}

// Reject before a turn's total base64 would exceed the WS frame ceiling
// (which drops the socket with 1009 before the server can respond).
function guardTurnTotal(items: readonly AttachmentItem[], b64: string): void {
  const used = items.reduce((n, a) => n + (a.data ? b64Bytes(a.data) : 0), 0)
  if (used + b64Bytes(b64) > MAX_TURN_BYTES) {
    throw new Error("Attachments too large for one message (max ~20 MB total).")
  }
}

// ============================================================================
// File I/O helpers - pure Promise wrappers, unchanged from vanilla.
// ============================================================================

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(",")[1] || "")
    r.onerror = () => reject(new Error(`Failed to read ${file.name}`))
    r.readAsDataURL(file)
  })
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error(`Failed to read ${file.name}`))
    r.readAsText(file)
  })
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error(`Failed to read ${file.name}`))
    r.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("Could not decode image"))
    img.src = src
  })
}

/**
 * Downscale an image to MAX_EDGE on its long side and return base64,
 * preserving png/jpeg/webp type. GUARANTEES the result is <= MAX_IMAGE_BYTES
 * (falls back to JPEG / steps quality down if a re-encoded PNG is still
 * heavy), so the image path never needs a server-side cap change. Canvas
 * isn't tainted here because the source is a same-origin data: URL.
 */
async function processImage(file: File): Promise<{ mediaType: string; data: string }> {
  const dataUrl = await readDataUrl(file)
  const img = await loadImage(dataUrl)
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight)
  const original = dataUrl.split(",")[1] || ""

  // Already within budget - send the bytes untouched.
  if (longEdge <= MAX_EDGE && b64Bytes(original) <= MAX_IMAGE_BYTES) {
    return { mediaType: file.type, data: original }
  }

  const scale = Math.min(1, MAX_EDGE / longEdge)
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx2d = canvas.getContext("2d")
  if (!ctx2d) throw new Error(`Could not decode image: ${file.name}`)
  ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height)

  // Re-encode, preserving type where the canvas supports it.
  let outType = file.type === "image/png" || file.type === "image/webp" ? file.type : "image/jpeg"
  let quality = 0.92
  let data = canvas.toDataURL(outType, quality).split(",")[1] || ""

  // PNG ignores quality; if still heavy, fall back to JPEG.
  if (outType === "image/png" && b64Bytes(data) > MAX_IMAGE_BYTES) {
    outType = "image/jpeg"
    data = canvas.toDataURL(outType, quality).split(",")[1] || ""
  }
  // JPEG/WebP honour quality - step down until under the cap.
  while (b64Bytes(data) > MAX_IMAGE_BYTES && quality > 0.4) {
    quality -= 0.15
    data = canvas.toDataURL(outType, quality).split(",")[1] || ""
  }
  return { mediaType: outType, data }
}

// ============================================================================
// Plain (React-free) external store - mirrors chatModel.ts's shape.
// ============================================================================

interface AttachmentsStore {
  getState: () => AttachmentsState
  setItems: (items: readonly AttachmentItem[]) => void
  setError: (error: string | null) => void
  subscribe: (listener: () => void) => () => void
  notify: () => void
}

function createAttachmentsStore(): AttachmentsStore {
  let state: AttachmentsState = { items: [], error: null }
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setItems: (items) => {
      state = { ...state, items }
    },
    setError: (error) => {
      state = { ...state, error }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    notify: () => {
      for (const listener of listeners) listener()
    },
  }
}

// ============================================================================
// React views
// ============================================================================

function useAttachmentsState(store: AttachmentsStore): AttachmentsState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

function AttachmentsStripView({
  store,
  container,
  onRemove,
}: {
  store: AttachmentsStore
  container: HTMLElement
  onRemove: (id: string) => void
}) {
  const state = useAttachmentsState(store)
  useLayoutEffect(() => {
    container.hidden = state.items.length === 0
  }, [state.items.length, container])
  return (
    <>
      {state.items.map((a) => (
        <div className="attachment-chip" key={a.id}>
          {a.kind === "image" ? (
            <img className="att-thumb" src={`data:${a.mediaType};base64,${a.data}`} alt={a.name} />
          ) : (
            <span className="att-icon">{(a.name.split(".").pop() || "file").slice(0, 4)}</span>
          )}
          <span className="att-name">{a.name}</span>
          <button
            type="button"
            className="att-remove"
            aria-label={`Remove ${a.name}`}
            onClick={() => onRemove(a.id)}
          >
            ×
          </button>
        </div>
      ))}
    </>
  )
}

function AttachmentsErrorView({ store, container }: { store: AttachmentsStore; container: HTMLElement }) {
  const state = useAttachmentsState(store)
  useLayoutEffect(() => {
    container.hidden = !state.error
  }, [state.error, container])
  return <>{state.error || ""}</>
}

// ============================================================================
// Legacy bridge - the exact external method surface chat.html's inline
// script and the test suite already call.
// ============================================================================

export interface AttachmentsBridge {
  get items(): readonly AttachmentItem[]
  set items(items: readonly AttachmentItem[])
  readonly IMAGE_TYPES: ReadonlySet<string>
  classify: (file: { readonly type: string; readonly name: string }) => AttachmentKind
  addFiles: (fileList: FileList | readonly File[] | null | undefined) => Promise<void>
  remove: (id: string) => void
  clear: () => void
  hasAny: () => boolean
  wireAttachments: () => WireAttachment[] | undefined
  textBlock: () => string
  previews: () => AttachmentPreview[]
  setError: (msg: string | null) => void
  /** Forces a synchronous repaint of both `#attachments-strip` and
   * `#attach-error` from current store state - see this module's doc. */
  render: () => void
}

function createAttachmentsBridge(store: AttachmentsStore): AttachmentsBridge {
  const renderSync = () => flushSync(() => store.notify())

  async function addOne(file: File): Promise<void> {
    const kind = classify(file)
    if (kind === "image") {
      if (file.size > HARD_INPUT_BYTES) {
        throw new Error(`Image too large to process: ${file.name}`)
      }
      if (file.type === "image/gif") {
        // Animated GIFs can't be canvas-downscaled (frames flatten) - size-
        // check against the cap instead.
        if (file.size > MAX_IMAGE_BYTES) {
          throw new Error(`GIF too large (max 4 MB): ${file.name}`)
        }
        const data = await readBase64(file)
        guardTurnTotal(store.getState().items, data)
        store.setItems([
          ...store.getState().items,
          { id: newId(), kind, name: file.name, mediaType: file.type, data },
        ])
      } else {
        // Downscale to model-native resolution; guaranteed <= MAX_IMAGE_BYTES.
        const out = await processImage(file)
        guardTurnTotal(store.getState().items, out.data)
        store.setItems([
          ...store.getState().items,
          { id: newId(), kind, name: file.name, mediaType: out.mediaType, data: out.data },
        ])
      }
    } else if (kind === "text") {
      if (file.size > MAX_TEXT_BYTES) {
        throw new Error(`Text file too large (max 256 KB): ${file.name}`)
      }
      const text = await readText(file)
      store.setItems([...store.getState().items, { id: newId(), kind, name: file.name, text }])
    } else if (kind === "pdf") {
      // Phase-1b: flip PDF_ENABLED once the server accepts document blocks
      // (protocol.ts + validateAttachments + buildUserMessage). Until then,
      // decline politely rather than send a frame the server will reject.
      if (!PDF_ENABLED) {
        throw new Error(`PDF support is coming in the next update: ${file.name}`)
      }
      if (file.size > MAX_PDF_BYTES) {
        throw new Error(`PDF too large (max 20 MB): ${file.name}`)
      }
      const data = await readBase64(file)
      guardTurnTotal(store.getState().items, data)
      store.setItems([
        ...store.getState().items,
        { id: newId(), kind, name: file.name, mediaType: "application/pdf", data },
      ])
    } else {
      // Phase 2: needs a blob store before Luna can hold a binary (see docs/moon-uploads-design.md).
      throw new Error(`Luna can't read ${file.name} yet - file storage is coming.`)
    }
  }

  return {
    get items() {
      return store.getState().items
    },
    set items(items: readonly AttachmentItem[]) {
      store.setItems(items)
    },
    IMAGE_TYPES,
    classify,

    async addFiles(fileList) {
      const files = Array.from(fileList || [])
      if (files.length === 0) return
      const errors: string[] = []
      for (const file of files) {
        if (store.getState().items.length >= MAX_PER_TURN) {
          errors.push(`Max ${MAX_PER_TURN} attachments per message.`)
          break
        }
        try {
          await addOne(file)
        } catch (e) {
          errors.push(e && (e as Error).message ? (e as Error).message : String(e))
        }
      }
      store.setError(errors.length ? errors.join(" · ") : null)
      renderSync()
    },

    remove(id) {
      store.setItems(store.getState().items.filter((a) => a.id !== id))
      store.setError(null)
      renderSync()
    },

    clear() {
      store.setItems([])
      store.setError(null)
      renderSync()
    },

    hasAny() {
      return store.getState().items.length > 0
    },

    wireAttachments() {
      const atts = store
        .getState()
        .items.filter((a) => a.kind === "image" || a.kind === "pdf")
        .map((a) => ({ mediaType: a.mediaType as string, data: a.data as string }))
      return atts.length ? atts : undefined
    },

    textBlock() {
      const texts = store.getState().items.filter((a) => a.kind === "text")
      if (texts.length === 0) return ""
      return texts.map((a) => formatTextAttachment(a.name, a.text || "")).join("\n\n")
    },

    previews() {
      return store.getState().items.map((a) => ({
        kind: a.kind,
        name: a.name,
        src: a.kind === "image" ? `data:${a.mediaType};base64,${a.data}` : null,
      }))
    },

    setError(msg) {
      store.setError(msg || null)
      renderSync()
    },

    render() {
      renderSync()
    },
  }
}

// ============================================================================
// Mount
// ============================================================================

export interface AttachmentsContainers {
  strip: HTMLElement | null
  error: HTMLElement | null
}

export interface AttachmentsMount {
  Attachments: AttachmentsBridge
}

/** Mounts the React-owned strip + error views into `containers.strip` /
 * `containers.error` (chat.html's `#attachments-strip` / `#attach-error`)
 * and returns the legacy `{ Attachments }` bridge - matches every other
 * mount*'s `if (host) ... else null` degrade-to-no-op guard (see
 * MessageList.tsx's mountMessageList). Both containers are required: the
 * two views share one store, so a half-mounted pair would silently drop
 * error or chip rendering. */
export function mountAttachments(containers: AttachmentsContainers): AttachmentsMount | null {
  const { strip, error } = containers
  if (!strip || !error) return null
  const store = createAttachmentsStore()
  const bridge = createAttachmentsBridge(store)
  // Unlike mountMessageList's plain createRoot().render() (chat.html ships
  // both containers pre-hidden, so there is nothing to flush before paint
  // there), this pair's initial `hidden` state is asserted synchronously
  // right after mount by callers - see Attachments.test.tsx - so the first
  // render is forced through flushSync rather than left to React's async
  // commit.
  flushSync(() => {
    createRoot(strip).render(
      <AttachmentsStripView store={store} container={strip} onRemove={(id) => bridge.remove(id)} />,
    )
    createRoot(error).render(<AttachmentsErrorView store={store} container={error} />)
  })
  return { Attachments: bridge }
}
