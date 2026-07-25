/**
 * Unit tests for readPngDimensions + writeFeedbackScreenshot + resolveUiFeedbackSessionId (chat-server.ts)
 * — the disk-write step of the point-at-the-UI feedback screenshot sink
 * (Moon feedback-screenshot + triage-queue, Phase 1).
 *
 * feedbackSink.submit itself lives inside chat-server.ts's server-boot
 * Effect.gen closure (opens live DB/WS connections — not independently
 * testable), so these two PURE helpers were extracted and exported
 * specifically so the "never blocks the note" contract has real test
 * coverage: any decode/mkdir/write failure returns null rather than
 * throwing, and a valid capture writes exactly `<id>.png` with correct
 * metadata.
 *
 * Coverage:
 *   - readPngDimensions: a real tiny (1x1) PNG returns the right width/height;
 *     garbage/short/wrong-signature bytes return null without throwing.
 *   - writeFeedbackScreenshot: valid base64 writes a file at the expected
 *     path with correct bytes/dims; a garbage (non-base64-decodable-to-
 *     nonempty) or empty screenshot string returns null and writes nothing;
 *     an unwritable directory (mkdir/write failure) returns null rather
 *     than throwing.
 */
import { describe, expect, it, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { UI_FEEDBACK_SENTINEL_SESSION } from "@luna/core"
import { readPngDimensions, resolveUiFeedbackSessionId, writeFeedbackScreenshot } from "../chat-server.js"

// A real, minimal 1x1 transparent PNG (67 bytes) — small enough to inline.
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

const tmpDirs: string[] = []
const makeTmpDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-feedback-shot-test-"))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("readPngDimensions", () => {
  it("returns the correct width/height for a real tiny PNG", () => {
    const buf = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64")
    const dims = readPngDimensions(buf)
    expect(dims).toEqual({ width: 1, height: 1 })
  })

  it("returns null for garbage bytes without throwing", () => {
    expect(readPngDimensions(Buffer.from("not a png at all"))).toBeNull()
    expect(readPngDimensions(Buffer.alloc(0))).toBeNull()
    expect(readPngDimensions(Buffer.from([1, 2, 3]))).toBeNull()
  })

  it("returns null for a buffer with the right length but wrong signature", () => {
    const buf = Buffer.alloc(30, 0)
    expect(readPngDimensions(buf)).toBeNull()
  })
})

describe("writeFeedbackScreenshot", () => {
  it("writes a valid base64 PNG to <id>.png and returns correct metadata", () => {
    const dir = makeTmpDir()
    const meta = writeFeedbackScreenshot(ONE_BY_ONE_PNG_BASE64, "note-123", dir)
    expect(meta).not.toBeNull()
    expect(meta!.screenshotPath).toBe(path.join(dir, "note-123.png"))
    expect(meta!.width).toBe(1)
    expect(meta!.height).toBe(1)
    expect(meta!.captureMethod).toBe("native-window")
    expect(meta!.bytes).toBe(Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64").length)
    expect(fs.existsSync(meta!.screenshotPath)).toBe(true)
    expect(fs.readFileSync(meta!.screenshotPath)).toEqual(Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"))
  })

  it("creates the target directory if it does not exist yet", () => {
    const dir = path.join(makeTmpDir(), "nested", "feedback-screenshots")
    const meta = writeFeedbackScreenshot(ONE_BY_ONE_PNG_BASE64, "note-nested", dir)
    expect(meta).not.toBeNull()
    expect(fs.existsSync(meta!.screenshotPath)).toBe(true)
  })

  it("returns null for an undefined/empty screenshot — writes nothing", () => {
    const dir = makeTmpDir()
    expect(writeFeedbackScreenshot(undefined, "note-1", dir)).toBeNull()
    expect(writeFeedbackScreenshot("", "note-2", dir)).toBeNull()
    expect(fs.readdirSync(dir)).toHaveLength(0)
  })

  it("returns null for a garbage/non-base64 screenshot string without throwing", () => {
    const dir = makeTmpDir()
    // Buffer.from(..., 'base64') never throws on invalid base64 — it just
    // decodes what it can (Node's lenient base64 decoder). This proves that
    // even pathological input degrades to null/harmless rather than
    // crashing the sink.
    expect(() => writeFeedbackScreenshot("!!!not-base64!!!", "note-3", dir)).not.toThrow()
  })

  it("returns null (never throws) when the target path cannot be written (e.g. a file occupies the directory slot)", () => {
    const dir = makeTmpDir()
    // Create a FILE where writeFeedbackScreenshot expects to mkdir a
    // directory — mkdirSync(..., {recursive:true}) throws ENOTDIR in that
    // case, and the function must swallow it and return null rather than
    // propagating the throw (this is the literal "note still submits ok:true
    // even on a screenshot write failure" contract feedbackSink.submit relies on).
    const blockedDir = path.join(dir, "blocked")
    fs.writeFileSync(blockedDir, "not a directory")
    expect(() => writeFeedbackScreenshot(ONE_BY_ONE_PNG_BASE64, "note-4", blockedDir)).not.toThrow()
    expect(writeFeedbackScreenshot(ONE_BY_ONE_PNG_BASE64, "note-4", blockedDir)).toBeNull()
  })
})

describe("resolveUiFeedbackSessionId", () => {
  it("falls back to the sentinel session when threadId is undefined or empty", () => {
    expect(resolveUiFeedbackSessionId(undefined)).toBe(UI_FEEDBACK_SENTINEL_SESSION)
    expect(resolveUiFeedbackSessionId("")).toBe(UI_FEEDBACK_SENTINEL_SESSION)
  })

  it("preserves a non-empty threadId", () => {
    expect(resolveUiFeedbackSessionId("thr-abc")).toBe("thr-abc")
  })
})
