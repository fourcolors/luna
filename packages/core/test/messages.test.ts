/**
 * Envelope shape test — core only knows the versioned envelope. The SDK
 * message union is owned by the adapter package; see DESIGN.md §12.2 #6.
 */
import { describe, expect, it } from "vitest"
import {
  MESSAGE_ENVELOPE_VERSION,
  type StoredMessage,
  type MessageKind,
} from "../src/messages.js"

describe("StoredMessage envelope", () => {
  it("carries schemaVersion and opaque payload", () => {
    const stored: StoredMessage = {
      id: "m1",
      sessionId: "s1",
      seq: 0,
      ts: 1,
      parentId: null,
      kind: "user",
      schemaVersion: MESSAGE_ENVELOPE_VERSION,
      payload: { anything: "the adapter wants" },
    }
    expect(stored.schemaVersion).toBe(1)
    expect(stored.seq).toBe(0)
    expect(stored.kind).toBe("user")
    expect(stored.payload).toEqual({ anything: "the adapter wants" })
  })

  it("envelope version is currently 1", () => {
    expect(MESSAGE_ENVELOPE_VERSION).toBe(1)
  })

  it("MessageKind enumerates expected coarse tags", () => {
    const kinds: MessageKind[] = [
      "user",
      "assistant",
      "system",
      "result",
      "stream_event",
      "hook",
      "status",
      "other",
    ]
    expect(kinds).toHaveLength(8)
  })
})
