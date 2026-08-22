/**
 * TelegramAdapter unit tests.
 *
 * All tests use an injected fake HTTP transport — no network is required.
 * The fake transport records every call and returns scripted responses,
 * allowing assertions on:
 *   - Correct API method names and parameters.
 *   - Message construction from Telegram update objects.
 *   - stream-edit state machine (sendMessage → editMessageText).
 *   - Poll-loop resilience (transient errors are retried, not fatal).
 *   - Dedup key correctness (platformMessageId = update_id).
 */
import { Buffer } from "node:buffer"
import { describe, expect, it, vi } from "vitest"
import {
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Redacted,
  Ref,
  Result,
  Stream,
} from "effect"
import { Clock } from "@luna/core"
import { ChatService } from "@luna/chat-service"
import {
  makeTelegramAdapter,
  makeRealTransport,
  makeRealFileTransport,
  normalizeCommandMention,
  type TelegramHttpTransport,
  type TelegramFileTransport,
  type TelegramAdapterConfig,
} from "../src/adapters/telegram.js"
import { channelCommands } from "../src/commands.js"
import {
  ChannelService,
  ChannelServiceLayer,
  ChannelSessionStore,
  InboundDedupStore,
} from "../src/index.js"
import type {
  ChannelMessage,
  DeliverOptions,
  DeliveryTarget,
} from "../src/types.js"
import type { ChatFrame, CreateThreadOptions } from "@luna/chat-service"
import type { ChatMessage, SessionSummary } from "@luna/core"

/* -------------------------------------------------------------------------- */
/* Fake HTTP transport helpers                                                 */
/* -------------------------------------------------------------------------- */

interface FakeCall {
  readonly method: string
  readonly params: Record<string, unknown>
}

/**
 * Make a fake TelegramHttpTransport.
 *
 * `responses` is a queue of scripted replies consumed in order WITHIN each
 * method's own queue. Provide `perMethod` to script per-method queues; those
 * responses are consumed before the fallback `responses` queue.
 *
 * Once all scripted responses for a method are exhausted:
 *   - getUpdates: returns `{ ok: true, result: [] }` (empty poll)
 *   - sendMessage / editMessageText: returns a generic success message
 *   - getMe: returns a stable bot identity (username "LunaTestBot")
 *   - anything else: returns `{ ok: true, result: null }`
 *
 * Startup lifecycle calls (getMe, setMyCommands) never consume the global
 * `responses` queue — they are incidental to every start(), and stealing
 * entries scripted for getUpdates would silently skew inbound tests. Script
 * them via `perMethod` when a test needs specific behavior.
 */
type FakeResponse = { ok: boolean; result?: unknown; description?: string; error_code?: number }

const makeFakeTransport = (
  responses: Array<FakeResponse> = [],
  perMethod: Partial<Record<string, Array<FakeResponse>>> = {},
) => {
  const calls: FakeCall[] = []
  const globalQueue = [...responses]
  const methodQueues: Map<string, Array<FakeResponse>> = new Map()
  for (const [method, queue] of Object.entries(perMethod)) {
    if (queue !== undefined) {
      methodQueues.set(method, [...queue])
    }
  }

  const defaultFor = (method: string): FakeResponse => {
    if (method === "getUpdates") return { ok: true, result: [] }
    if (method === "sendMessage" || method === "editMessageText") {
      return { ok: true, result: { message_id: 1, chat: { id: 1, type: "private" }, date: 0, from: { id: 1 } } }
    }
    if (method === "getMe") {
      return { ok: true, result: { id: 424242, username: "LunaTestBot", first_name: "Luna" } }
    }
    return { ok: true, result: null }
  }

  /** Lifecycle calls that must not steal globally-scripted responses. */
  const lifecycleMethods = new Set(["getMe", "setMyCommands"])

  const transport: TelegramHttpTransport = (method, params) =>
    Effect.gen(function* () {
      if (method === "getUpdates") {
        yield* Effect.sleep("1 millis")
      }
      calls.push({ method, params })
      // Check per-method queue first
      const methodQueue = methodQueues.get(method)
      if (methodQueue !== undefined && methodQueue.length > 0) {
        const r = methodQueue.shift()
        if (r !== undefined) return r
      }
      // Then global queue (startup lifecycle calls skip it — see doc above)
      if (!lifecycleMethods.has(method)) {
        const scripted = globalQueue.shift()
        if (scripted !== undefined) return scripted
      }
      // Default fallback
      return defaultFor(method)
    })

  return { transport, calls }
}

/* -------------------------------------------------------------------------- */
/* Telegram update / message builders                                         */
/* -------------------------------------------------------------------------- */

let updateIdCounter = 1000

const makeTextUpdate = (overrides: {
  chatId?: number
  chatType?: "private" | "group" | "supergroup" | "channel"
  fromId?: number
  text?: string
  updateId?: number
  messageId?: number
  date?: number
  isForum?: boolean
  isTopicMessage?: boolean
  messageThreadId?: number
}) => {
  const updateId = overrides.updateId ?? updateIdCounter++
  return {
    update_id: updateId,
    message: {
      message_id: overrides.messageId ?? 42,
      chat: {
        id: overrides.chatId ?? 111,
        type: overrides.chatType ?? "private",
        ...(overrides.isForum !== undefined ? { is_forum: overrides.isForum } : {}),
      },
      from: {
        id: overrides.fromId ?? 999,
        first_name: "Test",
      },
      text: overrides.text ?? "hello luna",
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      ...(overrides.isTopicMessage !== undefined ? { is_topic_message: overrides.isTopicMessage } : {}),
      ...(overrides.messageThreadId !== undefined ? { message_thread_id: overrides.messageThreadId } : {}),
    },
  }
}

/** A photo update (compressed image — several size variants, smallest first). */
const makePhotoUpdate = (overrides: {
  chatId?: number
  chatType?: "private" | "group" | "supergroup" | "channel"
  fromId?: number
  updateId?: number
  caption?: string
  photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>
} = {}) => ({
  update_id: overrides.updateId ?? updateIdCounter++,
  message: {
    message_id: 43,
    chat: { id: overrides.chatId ?? 111, type: overrides.chatType ?? ("private" as const) },
    from: { id: overrides.fromId ?? 999, first_name: "Test" },
    // Deliberately NOT smallest-first: the Bot API does not guarantee
    // ordering, so the fixture proves max-by-area selection, not array position.
    photo: overrides.photo ?? [
      { file_id: "photo-large", width: 800, height: 800, file_size: 64_000 },
      { file_id: "photo-small", width: 90, height: 90, file_size: 800 },
    ],
    ...(overrides.caption !== undefined ? { caption: overrides.caption } : {}),
    date: Math.floor(Date.now() / 1000),
  },
})

/** A document update (file sent uncompressed — PDFs arrive this way). */
const makeDocumentUpdate = (overrides: {
  chatId?: number
  fromId?: number
  updateId?: number
  caption?: string
  fileId?: string
  fileName?: string
  mimeType?: string
  fileSize?: number
} = {}) => ({
  update_id: overrides.updateId ?? updateIdCounter++,
  message: {
    message_id: 44,
    chat: { id: overrides.chatId ?? 111, type: "private" as const },
    from: { id: overrides.fromId ?? 999, first_name: "Test" },
    document: {
      file_id: overrides.fileId ?? "doc-1",
      ...(overrides.fileName !== undefined ? { file_name: overrides.fileName } : {}),
      ...(overrides.mimeType !== undefined ? { mime_type: overrides.mimeType } : {}),
      ...(overrides.fileSize !== undefined ? { file_size: overrides.fileSize } : {}),
    },
    ...(overrides.caption !== undefined ? { caption: overrides.caption } : {}),
    date: Math.floor(Date.now() / 1000),
  },
})

/** A sticker update. Remains silently ignored (reactions, not attachments). */
const makeStickerUpdate = (chatId = 111, updateId = updateIdCounter++) => ({
  update_id: updateId,
  message: {
    message_id: 45,
    chat: { id: chatId, type: "private" as const },
    from: { id: 999, first_name: "Test" },
    sticker: { file_id: "stk", width: 512, height: 512 },
    date: Math.floor(Date.now() / 1000),
  },
})

/** Realistic file bodies — the adapter sniffs magic bytes before ingesting. */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0x04])
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
const PDF_BYTES = new Uint8Array(Buffer.from("%PDF-1.4 fake pdf body"))

/**
 * Fake file-download transport: records requested file_paths and returns the
 * scripted bytes (or fails with the scripted error). Defaults to a JPEG body
 * since photos are the most common case.
 */
const makeFakeFileTransport = (bytes: Uint8Array | Error = JPEG_BYTES) => {
  const paths: string[] = []
  const transport: TelegramFileTransport = (filePath) =>
    Effect.suspend(() => {
      paths.push(filePath)
      return bytes instanceof Error
        ? Effect.fail(bytes)
        : Effect.succeed(bytes)
    })
  return { transport, paths }
}

/** A non-message update (e.g. callback_query). */
const makeCallbackUpdate = (updateId = updateIdCounter++) => ({
  update_id: updateId,
  callback_query: { id: "cq-1", data: "some_data" },
})

/** A "⏹ Stop" inline-button tap. */
const makeStopCallback = (overrides: {
  updateId?: number
  callbackId?: string
  fromId?: number
  username?: string
  chatId?: number
  chatType?: "private" | "group" | "supergroup" | "channel"
  isForum?: boolean
  messageId?: number
  messageThreadId?: number
  data?: string
} = {}) => ({
  update_id: overrides.updateId ?? updateIdCounter++,
  callback_query: {
    id: overrides.callbackId ?? "cq-stop-1",
    from: {
      id: overrides.fromId ?? 999,
      first_name: "Test",
      ...(overrides.username !== undefined ? { username: overrides.username } : {}),
    },
    data: overrides.data ?? "stop",
    message: {
      chat: {
        id: overrides.chatId ?? 111,
        type: overrides.chatType ?? "private",
        ...(overrides.isForum !== undefined ? { is_forum: overrides.isForum } : {}),
      },
      message_id: overrides.messageId ?? 42,
      ...(overrides.messageThreadId !== undefined
        ? { message_thread_id: overrides.messageThreadId }
        : {}),
    },
  },
})

/* -------------------------------------------------------------------------- */
/* Delivery target builder                                                    */
/* -------------------------------------------------------------------------- */

const makeDeliveryTarget = (
  chatId: string,
  platformMessageId: string,
): DeliveryTarget => ({
  inReplyTo: {
    transport: "telegram",
    channelId: chatId,
    senderId: "999",
    threadingKey: chatId,
    text: "hello",
    platformMessageId,
    ts: new Date().toISOString(),
  },
  address: {
    transport: "telegram",
    channelId: chatId,
    senderId: "999",
    threadingKey: chatId,
  },
})

const makeDeliverOpts = (overrides: Partial<DeliverOptions> = {}): DeliverOptions => ({
  isPartial: false,
  isFinal: true,
  chunkIndex: 0,
  totalChunks: 1,
  ...overrides,
})

/* -------------------------------------------------------------------------- */
/* 1. getUpdates → correct ChannelMessage + offset advances                   */
/* -------------------------------------------------------------------------- */

describe("inbound: getUpdates → ChannelMessage", () => {
  it("builds a correct ChannelMessage from a text update", async () => {
    const receivedMessages: ChannelMessage[] = []

    const update = makeTextUpdate({ chatId: 12345, fromId: 67890, text: "hello luna", updateId: 5001 })
    const { transport } = makeFakeTransport([
      { ok: true, result: [update] },
      // Subsequent polls return empty so the loop suspends
    ])

    const adapter = makeTelegramAdapter({ id: "tg-test", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => {
        receivedMessages.push(msg)
      }),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Run start() with a scope; let it spin briefly then interrupt.
          const fiber = yield* Effect.forkChild(
            Effect.scoped(adapter.start()),
          )
          // Give the poll loop time to run one iteration
          yield* Effect.sleep("50 millis")
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )

    expect(receivedMessages).toHaveLength(1)
    const msg = receivedMessages[0]
    expect(msg).toBeDefined()
    expect(msg!.transport).toBe("telegram")
    expect(msg!.channelId).toBe("12345")
    expect(msg!.senderId).toBe("67890")
    expect(msg!.threadingKey).toBe("12345")  // chat.id
    expect(msg!.text).toBe("hello luna")
    expect(msg!.platformMessageId).toBe("5001")  // update_id
    expect(msg!.metadata).toMatchObject({ chatType: "private", messageId: 42, userId: 67890, username: undefined, firstName: "Test" })
  })

  it("advances the offset past consumed updates", async () => {
    const update1 = makeTextUpdate({ updateId: 200, chatId: 1 })
    const update2 = makeTextUpdate({ updateId: 201, chatId: 1 })
    const { transport, calls } = makeFakeTransport([
      { ok: true, result: [update1, update2] },
      // Second poll: empty
      { ok: true, result: [] },
      // Third poll: empty
    ])

    const adapter = makeTelegramAdapter({ id: "tg-offset", httpTransport: transport })
    adapter.setMessageHandler(() => Effect.void)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.scoped(adapter.start()),
        )
        yield* Effect.sleep("80 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    // start() issues lifecycle calls (getMe, setMyCommands) before polling;
    // assert on the getUpdates sequence only.
    const polls = calls.filter((c) => c.method === "getUpdates")

    // First poll: offset 0 (no prior updates)
    expect(polls[0]?.params["offset"]).toBe(0)

    // Second poll: offset should be 202 (last update_id + 1)
    expect(polls[1]?.params["offset"]).toBe(202)
  })
})

/* -------------------------------------------------------------------------- */
/* 2. Non-text / non-message updates are ignored                              */
/* -------------------------------------------------------------------------- */

describe("inbound: non-ingestible / non-message updates ignored", () => {
  it("ignores a sticker update silently (no handler call, no reply)", async () => {
    const receivedMessages: ChannelMessage[] = []
    const stickerUpdate = makeStickerUpdate(111, 300)
    const textUpdate = makeTextUpdate({ updateId: 301, text: "actual text" })

    const { transport, calls } = makeFakeTransport([
      { ok: true, result: [stickerUpdate, textUpdate] },
    ])

    const adapter = makeTelegramAdapter({ id: "tg-sticker", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => { receivedMessages.push(msg) }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    // Only the text update should produce a ChannelMessage
    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0]?.text).toBe("actual text")
    expect(receivedMessages[0]?.platformMessageId).toBe("301")
    // No explanatory reply for stickers, and no download attempt.
    expect(calls.some((c) => c.method === "getFile")).toBe(false)
  })

  it("answers a non-stop callback_query but never turns it into a ChannelMessage", async () => {
    // callback_query is no longer silently ignored (see the tap-to-stop
    // describe block below) — but a callback whose data isn't the stop
    // button must still never reach the handler as an inbound message, and
    // it must still be answered (Telegram expires unanswered callbacks).
    const receivedMessages: ChannelMessage[] = []
    const cbUpdate = makeCallbackUpdate(400)
    const textUpdate = makeTextUpdate({ updateId: 401 })

    const { transport, calls } = makeFakeTransport([
      { ok: true, result: [cbUpdate, textUpdate] },
    ])

    const adapter = makeTelegramAdapter({ id: "tg-cb", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => { receivedMessages.push(msg) }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    // Only the text update produced a ChannelMessage.
    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0]?.platformMessageId).toBe("401")
    // The callback was still answered (data !== "stop", but every callback
    // is acknowledged so the tapper's client doesn't spin for ~10s).
    const answered = calls.find((c) => c.method === "answerCallbackQuery")
    expect(answered?.params["callback_query_id"]).toBe("cq-1")
  })
})

/* -------------------------------------------------------------------------- */
/* 2b. Inbound attachments: photo + document download                          */
/* -------------------------------------------------------------------------- */

describe("inbound: attachments (photo / document)", () => {
  /**
   * Drive one poll of `updates` through an adapter wired with a fake file
   * transport. Returns received messages, all API calls, and file paths
   * requested from the file transport.
   */
  const runInbound = async (opts: {
    updates: unknown[]
    fileBytes?: Uint8Array | Error
    fileTransportOverride?: TelegramFileTransport
    omitFileTransport?: boolean
    perMethod?: Partial<Record<string, Array<FakeResponse>>>
    allowedIds?: Iterable<string>
    runMillis?: number
  }) => {
    const received: ChannelMessage[] = []
    const { transport, calls } = makeFakeTransport(
      [{ ok: true, result: opts.updates }],
      opts.perMethod ?? {
        getFile: [
          { ok: true, result: { file_id: "any", file_path: "files/file_1.bin", file_size: 4 } },
        ],
      },
    )
    const fake = makeFakeFileTransport(opts.fileBytes)
    const fileTransport = opts.fileTransportOverride ?? fake.transport
    const adapter = makeTelegramAdapter({
      id: "tg-attach",
      httpTransport: transport,
      ...(opts.omitFileTransport === true ? {} : { fileTransport }),
      ...(opts.allowedIds !== undefined ? { allowedIds: opts.allowedIds } : {}),
    })
    adapter.setMessageHandler((msg) => Effect.sync(() => { received.push(msg) }))
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep(`${opts.runMillis ?? 60} millis`)
        yield* Fiber.interrupt(fiber)
        yield* adapter.stop()
      }),
    )
    return { received, calls, filePaths: fake.paths }
  }

  it("downloads a photo (largest variant) and attaches it as image/jpeg with the caption as text", async () => {
    const { received, calls, filePaths } = await runInbound({
      updates: [makePhotoUpdate({ updateId: 8100, caption: "here is the receipt" })],
    })

    // getFile was called with the LARGEST photo variant's file_id.
    const getFile = calls.find((c) => c.method === "getFile")
    expect(getFile?.params["file_id"]).toBe("photo-large")
    // The raw bytes were fetched from the path getFile returned.
    expect(filePaths).toEqual(["files/file_1.bin"])

    expect(received).toHaveLength(1)
    const msg = received[0]!
    expect(msg.text).toBe("here is the receipt")
    expect(msg.attachments).toHaveLength(1)
    expect(msg.attachments![0]!.mediaType).toBe("image/jpeg")
    expect(msg.attachments![0]!.data).toBe(Buffer.from(JPEG_BYTES).toString("base64"))
  })

  it("downloads a PDF document and attaches it as application/pdf (the bug-report case)", async () => {
    const { received, calls } = await runInbound({
      updates: [
        makeDocumentUpdate({
          updateId: 8200,
          fileId: "pdf-99",
          fileName: "report.pdf",
          mimeType: "application/pdf",
          fileSize: 4,
          caption: "please summarize",
        }),
      ],
      fileBytes: PDF_BYTES,
    })

    expect(calls.find((c) => c.method === "getFile")?.params["file_id"]).toBe("pdf-99")
    expect(received).toHaveLength(1)
    const msg = received[0]!
    expect(msg.text).toBe("please summarize")
    expect(msg.attachments![0]!.mediaType).toBe("application/pdf")
    expect(msg.metadata).toMatchObject({
      attachmentMediaType: "application/pdf",
      attachmentFileName: "report.pdf",
    })
  })

  it("infers application/pdf from the .pdf extension when Telegram omits mime_type", async () => {
    const { received } = await runInbound({
      updates: [makeDocumentUpdate({ updateId: 8250, fileName: "scan.PDF" })],
      fileBytes: PDF_BYTES,
    })
    expect(received).toHaveLength(1)
    expect(received[0]!.attachments![0]!.mediaType).toBe("application/pdf")
  })

  it("accepts an image sent as an uncompressed document (image/png)", async () => {
    const { received } = await runInbound({
      updates: [
        makeDocumentUpdate({ updateId: 8300, fileName: "shot.png", mimeType: "image/png" }),
      ],
      fileBytes: PNG_BYTES,
    })
    expect(received).toHaveLength(1)
    expect(received[0]!.attachments![0]!.mediaType).toBe("image/png")
  })

  it("corrects a misnamed file to its sniffed type (PDF-labelled JPEG becomes image/jpeg)", async () => {
    const { received } = await runInbound({
      updates: [
        makeDocumentUpdate({ updateId: 8310, fileName: "photo.pdf", mimeType: "application/pdf" }),
      ],
      fileBytes: JPEG_BYTES,
    })
    expect(received).toHaveLength(1)
    expect(received[0]!.attachments![0]!.mediaType).toBe("image/jpeg")
  })

  it("rejects a file whose bytes match no ingestible signature", async () => {
    const { received, calls } = await runInbound({
      updates: [
        makeDocumentUpdate({ updateId: 8320, fileName: "real.pdf", mimeType: "application/pdf" }),
      ],
      fileBytes: new Uint8Array([1, 2, 3, 4]),
    })
    expect(received).toHaveLength(0)
    expect(String(calls.find((c) => c.method === "sendMessage")?.params["text"])).toContain(
      "doesn't match a type I can read",
    )
  })

  it("rejects an unsupported document type with an explanatory reply (no getFile, no handler)", async () => {
    const { received, calls } = await runInbound({
      updates: [
        makeDocumentUpdate({ updateId: 8400, fileName: "code.zip", mimeType: "application/zip" }),
      ],
    })

    expect(received).toHaveLength(0)
    expect(calls.some((c) => c.method === "getFile")).toBe(false)
    const reply = calls.find((c) => c.method === "sendMessage")
    expect(reply).toBeDefined()
    expect(String(reply?.params["text"])).toContain("application/zip")
  })

  it("rejects a declared-oversize file BEFORE any getFile call", async () => {
    const { received, calls } = await runInbound({
      updates: [
        makeDocumentUpdate({
          updateId: 8500,
          fileName: "huge.pdf",
          mimeType: "application/pdf",
          fileSize: 25 * 1024 * 1024, // over the 20 MB PDF cap
        }),
      ],
    })

    expect(received).toHaveLength(0)
    expect(calls.some((c) => c.method === "getFile")).toBe(false)
    const reply = calls.find((c) => c.method === "sendMessage")
    expect(String(reply?.params["text"])).toContain("too large")
  })

  it("enforces the smaller 10 MB cap for images (a 12 MB png is rejected)", async () => {
    const { received, calls } = await runInbound({
      updates: [
        makeDocumentUpdate({
          updateId: 8550,
          fileName: "big.png",
          mimeType: "image/png",
          fileSize: 12 * 1024 * 1024, // over the 10 MB image cap, under the PDF cap
        }),
      ],
    })
    expect(received).toHaveLength(0)
    expect(calls.some((c) => c.method === "getFile")).toBe(false)
    expect(String(calls.find((c) => c.method === "sendMessage")?.params["text"])).toContain(
      "too large",
    )
  })

  it("replies with an explanation when getFile fails (Telegram 20 MB bot ceiling)", async () => {
    const { received, calls } = await runInbound({
      updates: [makePhotoUpdate({ updateId: 8600 })],
      perMethod: {
        getFile: [{ ok: false, error_code: 400, description: "Bad Request: file is too big" }],
      },
    })

    expect(received).toHaveLength(0)
    const reply = calls.find((c) => c.method === "sendMessage")
    expect(String(reply?.params["text"])).toContain("file is too big")
  })

  it("replies with an explanation when the byte download fails", async () => {
    const { received, calls } = await runInbound({
      updates: [makePhotoUpdate({ updateId: 8700 })],
      fileBytes: new Error("connection reset"),
    })

    expect(received).toHaveLength(0)
    const reply = calls.find((c) => c.method === "sendMessage")
    expect(String(reply?.params["text"])).toContain("connection reset")
  })

  it("fails gracefully when no file transport is configured (no crash, user is told)", async () => {
    const { received, calls } = await runInbound({
      updates: [makePhotoUpdate({ updateId: 8800 })],
      omitFileTransport: true,
    })

    expect(received).toHaveLength(0)
    const reply = calls.find((c) => c.method === "sendMessage")
    expect(String(reply?.params["text"])).toContain("downloads aren't configured")
  })

  it("never calls getFile for a non-allowlisted sender (no bandwidth for strangers)", async () => {
    const { received, calls, filePaths } = await runInbound({
      updates: [makePhotoUpdate({ updateId: 8900, fromId: 666, chatId: 666 })],
      allowedIds: ["111"],
    })

    expect(received).toHaveLength(0)
    expect(calls.some((c) => c.method === "getFile")).toBe(false)
    expect(calls.some((c) => c.method === "sendMessage")).toBe(false) // silent drop, no bot-existence leak
    expect(filePaths).toHaveLength(0)
  })

  it("replies to a voice note in a private chat but stays silent in groups", async () => {
    const voiceUpdate = (chatId: number, chatType: "private" | "group", updateId: number) => ({
      update_id: updateId,
      message: {
        message_id: 46,
        chat: { id: chatId, type: chatType },
        from: { id: 999, first_name: "Test" },
        voice: { file_id: "v1", duration: 3 },
        date: Math.floor(Date.now() / 1000),
      },
    })

    const dm = await runInbound({ updates: [voiceUpdate(111, "private", 9000)] })
    expect(dm.received).toHaveLength(0)
    expect(String(dm.calls.find((c) => c.method === "sendMessage")?.params["text"])).toContain(
      "audio",
    )

    const group = await runInbound({ updates: [voiceUpdate(-700, "group", 9001)] })
    expect(group.received).toHaveLength(0)
    expect(group.calls.some((c) => c.method === "sendMessage")).toBe(false)
  })

  it("a photo with no caption produces an empty-text message with the attachment", async () => {
    const { received } = await runInbound({
      updates: [makePhotoUpdate({ updateId: 9100 })],
    })
    expect(received).toHaveLength(1)
    expect(received[0]!.text).toBe("")
    expect(received[0]!.attachments).toHaveLength(1)
  })

  it("rejects when getFile REPORTS an oversize file — no byte fetch happens", async () => {
    const { received, calls, filePaths } = await runInbound({
      updates: [
        makeDocumentUpdate({ updateId: 9200, fileName: "big.pdf", mimeType: "application/pdf" }),
      ],
      perMethod: {
        getFile: [
          {
            ok: true,
            result: { file_id: "x", file_path: "documents/big.pdf", file_size: 25 * 1024 * 1024 },
          },
        ],
      },
    })
    expect(received).toHaveLength(0)
    expect(filePaths).toHaveLength(0) // the lying-metadata defence fired BEFORE the download
    expect(String(calls.find((c) => c.method === "sendMessage")?.params["text"])).toContain(
      "too large",
    )
  })

  it("rejects when the ACTUAL bytes exceed the image cap despite small declared sizes", async () => {
    const oversized = new Uint8Array(10 * 1024 * 1024 + 16)
    oversized.set(JPEG_BYTES, 0)
    const { received, calls } = await runInbound({
      updates: [makePhotoUpdate({ updateId: 9300 })], // declared size small (64 KB)
      fileBytes: oversized,
    })
    expect(received).toHaveLength(0)
    expect(String(calls.find((c) => c.method === "sendMessage")?.params["text"])).toContain(
      "too large",
    )
  })

  it("replies when the file comes back empty", async () => {
    const { received, calls } = await runInbound({
      updates: [makePhotoUpdate({ updateId: 9400 })],
      fileBytes: new Uint8Array(0),
    })
    expect(received).toHaveLength(0)
    expect(String(calls.find((c) => c.method === "sendMessage")?.params["text"])).toContain(
      "came back empty",
    )
  })

  it("a DYING file transport (defect) doesn't kill the loop — the text update in the same batch still lands", async () => {
    const dyingTransport: TelegramFileTransport = () =>
      Effect.suspend(() => {
        throw new Error("boom")
      })
    const { received, calls } = await runInbound({
      updates: [
        makePhotoUpdate({ updateId: 9500 }),
        makeTextUpdate({ updateId: 9501, text: "still alive" }),
      ],
      fileTransportOverride: dyingTransport,
    })
    // The defect folded into a generic user reply…
    expect(String(calls.find((c) => c.method === "sendMessage")?.params["text"])).toContain(
      "Something went wrong",
    )
    // …and the rest of the batch was processed normally.
    expect(received.map((m) => m.text)).toEqual(["still alive"])
    // The poll loop survived: at least a second getUpdates happened.
    expect(calls.filter((c) => c.method === "getUpdates").length).toBeGreaterThanOrEqual(2)
  })

  it("replies to an unsupported document even in a GROUP chat (deliberate file share)", async () => {
    const groupZip = {
      update_id: 9600,
      message: {
        message_id: 47,
        chat: { id: -800, type: "group" as const },
        from: { id: 999, first_name: "Test" },
        document: { file_id: "zip-1", file_name: "code.zip", mime_type: "application/zip" },
        date: Math.floor(Date.now() / 1000),
      },
    }
    const { received, calls } = await runInbound({ updates: [groupZip] })
    expect(received).toHaveLength(0)
    expect(String(calls.find((c) => c.method === "sendMessage")?.params["text"])).toContain(
      "application/zip",
    )
  })

  it("sanitizes a markdown-link-shaped mime_type — the bot must not post attacker-authored links", async () => {
    const evil = {
      update_id: 9700,
      message: {
        message_id: 48,
        chat: { id: 111, type: "private" as const },
        from: { id: 999, first_name: "Test" },
        document: {
          file_id: "evil-1",
          file_name: "x.bin",
          mime_type: "x/y). [Re-verify your account](https://evil.example/phish) (",
        },
        date: Math.floor(Date.now() / 1000),
      },
    }
    const { received, calls } = await runInbound({ updates: [evil] })
    expect(received).toHaveLength(0)
    const reply = String(calls.find((c) => c.method === "sendMessage")?.params["text"])
    expect(reply).toContain("unknown")
    expect(reply).not.toContain("<a href")
    expect(reply).not.toContain("evil.example")
  })

  it("replies to a video in a DM with the videos hint", async () => {
    const video = {
      update_id: 9800,
      message: {
        message_id: 49,
        chat: { id: 111, type: "private" as const },
        from: { id: 999, first_name: "Test" },
        video: { file_id: "v-1", duration: 10 },
        date: Math.floor(Date.now() / 1000),
      },
    }
    const { received, calls } = await runInbound({ updates: [video] })
    expect(received).toHaveLength(0)
    expect(String(calls.find((c) => c.method === "sendMessage")?.params["text"])).toContain(
      "videos",
    )
  })

  it("treats an animation (GIF) like video, NOT like its backward-compat document field", async () => {
    // Bot API: animation messages set BOTH animation and document.
    const makeGif = (chatId: number, chatType: "private" | "group", updateId: number) => ({
      update_id: updateId,
      message: {
        message_id: 50,
        chat: { id: chatId, type: chatType },
        from: { id: 999, first_name: "Test" },
        animation: { file_id: "gif-1", width: 300, height: 200 },
        document: { file_id: "gif-1", file_name: "funny.mp4", mime_type: "video/mp4" },
        date: Math.floor(Date.now() / 1000),
      },
    })

    // In a DM: an explanatory reply mentioning GIFs, and NO getFile call.
    const dm = await runInbound({ updates: [makeGif(111, "private", 9900)] })
    expect(dm.received).toHaveLength(0)
    expect(dm.calls.some((c) => c.method === "getFile")).toBe(false)
    expect(String(dm.calls.find((c) => c.method === "sendMessage")?.params["text"])).toContain(
      "GIFs",
    )

    // In a group: complete silence — ambient GIFs must not trigger bot noise.
    const group = await runInbound({ updates: [makeGif(-900, "group", 9901)] })
    expect(group.received).toHaveLength(0)
    expect(group.calls.some((c) => c.method === "sendMessage")).toBe(false)
  })

  it("replies with the no-download-path hint when getFile succeeds without a file_path", async () => {
    const { received, calls } = await runInbound({
      updates: [makePhotoUpdate({ updateId: 10_000 })],
      perMethod: { getFile: [{ ok: true, result: { file_id: "x" } }] },
    })
    expect(received).toHaveLength(0)
    expect(String(calls.find((c) => c.method === "sendMessage")?.params["text"])).toContain(
      "wouldn't hand over",
    )
  })

  it("rejects an unsafe file_path from getFile before it reaches the download URL", async () => {
    const { received, calls, filePaths } = await runInbound({
      updates: [makePhotoUpdate({ updateId: 10_100 })],
      perMethod: {
        getFile: [
          { ok: true, result: { file_id: "x", file_path: "../../botEVIL/files/a.jpg" } },
        ],
      },
    })
    expect(received).toHaveLength(0)
    expect(filePaths).toHaveLength(0) // never forwarded to the transport
    expect(String(calls.find((c) => c.method === "sendMessage")?.params["text"])).toContain(
      "unusable download path",
    )
  })

  it("keeps a media caption out of command interpretation (photo captioned /status@OtherBot is NOT dropped)", async () => {
    const { received } = await runInbound({
      updates: [makePhotoUpdate({ updateId: 10_200, caption: "/status@SomeOtherBot check this" })],
    })
    // A TEXT message with this content would be dropped (addressed to another
    // bot). A caption is user text riding on media — it must survive verbatim.
    expect(received).toHaveLength(1)
    expect(received[0]!.text).toBe("/status@SomeOtherBot check this")
    expect(received[0]!.attachments).toHaveLength(1)
  })

  it("accepts an uppercase declared mime (Application/PDF)", async () => {
    const { received } = await runInbound({
      updates: [
        makeDocumentUpdate({ updateId: 10_400, fileName: "report.pdf", mimeType: "Application/PDF" }),
      ],
      fileBytes: PDF_BYTES,
    })
    expect(received).toHaveLength(1)
    expect(received[0]!.attachments![0]!.mediaType).toBe("application/pdf")
  })

  it("rescues a generic application/octet-stream via the filename extension", async () => {
    const { received } = await runInbound({
      updates: [
        makeDocumentUpdate({
          updateId: 10_500,
          fileName: "report.pdf",
          mimeType: "application/octet-stream",
        }),
      ],
      fileBytes: PDF_BYTES,
    })
    expect(received).toHaveLength(1)
    expect(received[0]!.attachments![0]!.mediaType).toBe("application/pdf")
  })

  it("still rejects octet-stream with an unhelpful filename", async () => {
    const { received, calls } = await runInbound({
      updates: [
        makeDocumentUpdate({
          updateId: 10_600,
          fileName: "blob.bin",
          mimeType: "application/octet-stream",
        }),
      ],
    })
    expect(received).toHaveLength(0)
    expect(calls.some((c) => c.method === "getFile")).toBe(false)
    expect(String(calls.find((c) => c.method === "sendMessage")?.params["text"])).toContain(
      "application/octet-stream",
    )
  })

  it("delivers same-chat messages in arrival order: a text sent after a photo waits for the download", async () => {
    // Slow download: the text update in the same batch/chat must still arrive
    // at the handler AFTER the photo message, not race past it.
    const slowTransport: TelegramFileTransport = () =>
      Effect.sleep("150 millis").pipe(Effect.andThen(Effect.succeed(JPEG_BYTES)))
    const { received } = await runInbound({
      updates: [
        makePhotoUpdate({ updateId: 10_700, chatId: 111, caption: "here is the PDF... err photo" }),
        makeTextUpdate({ updateId: 10_701, chatId: 111, text: "please summarize it" }),
      ],
      fileTransportOverride: slowTransport,
      runMillis: 500,
    })
    expect(received.map((m) => m.text)).toEqual([
      "here is the PDF... err photo",
      "please summarize it",
    ])
    expect(received[0]!.attachments).toHaveLength(1)
  })

  it("a slow download in one chat does NOT delay another chat's text", async () => {
    const slowTransport: TelegramFileTransport = () =>
      Effect.sleep("300 millis").pipe(Effect.andThen(Effect.succeed(JPEG_BYTES)))
    const { received } = await runInbound({
      updates: [
        makePhotoUpdate({ updateId: 10_800, chatId: 111 }),
        makeTextUpdate({ updateId: 10_801, chatId: 222, fromId: 222, text: "other chat" }),
      ],
      fileTransportOverride: slowTransport,
      runMillis: 600,
    })
    // The other chat's text arrived FIRST (its chain was empty), proving
    // cross-chat concurrency survived the per-chat ordering fix.
    expect(received[0]?.text).toBe("other chat")
    expect(received).toHaveLength(2)
    expect(received[1]?.attachments).toHaveLength(1)
  })

  it("stops the typing indicator it started when the download fails (no refresh after the reply)", async () => {
    const { calls } = await runInbound({
      updates: [makePhotoUpdate({ updateId: 10_300 })],
      fileBytes: new Error("connection reset"),
      // Past one 4s refresh interval: a leaked typing fiber would re-send
      // sendChatAction at ~4s; a stopped one leaves exactly the initial call.
      runMillis: 4500,
    })
    expect(calls.filter((c) => c.method === "sendChatAction")).toHaveLength(1)
  }, 10_000)
})

describe("makeRealFileTransport (stubbed fetch — no network)", () => {
  const TOKEN = "fake_token_12345"

  const runWithFetch = async (
    fetchImpl: (url: string) => Promise<unknown>,
    filePath = "photos/file_1.jpg",
  ): Promise<{ error: Error | null; urls: string[] }> => {
    const urls: string[] = []
    const stub = (async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      return fetchImpl(url)
    }) as unknown as typeof fetch
    vi.stubGlobal("fetch", stub)
    try {
      const ft = makeRealFileTransport(Redacted.make(TOKEN))
      const result = await Effect.runPromise(Effect.result(ft(filePath)))
      return { error: Result.isFailure(result) ? result.failure : null, urls }
    } finally {
      vi.unstubAllGlobals()
    }
  }

  it("maps an HTTP failure to a message with NO token and NO URL in it", async () => {
    const { error } = await runWithFetch(async () => ({ ok: false, status: 404 }))
    expect(error?.message).toBe("download failed: HTTP 404")
    expect(error?.message).not.toContain(TOKEN)
    expect(error?.message).not.toContain("api.telegram.org")
  })

  it("wraps a rejecting fetch without adding the URL or token", async () => {
    const { error } = await runWithFetch(async () => {
      throw new Error("boom")
    })
    expect(error?.message).toBe("download failed: boom")
    expect(error?.message).not.toContain(TOKEN)
  })

  it("percent-encodes file_path segments in the download URL", async () => {
    const { urls } = await runWithFetch(
      async () => ({ ok: false, status: 404 }), // fail fast; we only care about the URL
      "documents/weird name+.pdf",
    )
    expect(urls[0]).toBe(
      `https://api.telegram.org/file/bot${TOKEN}/documents/weird%20name%2B.pdf`,
    )
  })

  it("aborts on an oversize Content-Length before reading the body", async () => {
    const { error } = await runWithFetch(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(25 * 1024 * 1024) },
      body: null,
    }))
    expect(error?.message).toBe("download failed: file exceeds the size limit")
  })

  it("enforces a hard streaming ceiling when Content-Length lies or is absent", async () => {
    let cancelled = false
    const chunk = new Uint8Array(5 * 1024 * 1024)
    const { error } = await runWithFetch(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          // Endless 5 MB chunks — the reader must be cancelled at the ceiling.
          read: async () => ({ done: false, value: chunk }),
          cancel: async () => {
            cancelled = true
          },
        }),
      },
    }))
    expect(error?.message).toBe("download failed: file exceeds the size limit")
    expect(cancelled).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* 3. deliver: stream-edit state machine                                      */
/* -------------------------------------------------------------------------- */

describe("deliver: stream-edit (sendMessage → editMessageText)", () => {
  it("first partial calls sendMessage; subsequent partials call editMessageText", async () => {
    const { transport, calls } = makeFakeTransport([
      // sendMessage response
      { ok: true, result: { message_id: 999, chat: { id: 111, type: "private" }, date: 0, from: { id: 1 } } },
      // editMessageText responses
      { ok: true, result: { message_id: 999, chat: { id: 111, type: "private" }, date: 0, from: { id: 1 } } },
      { ok: true, result: { message_id: 999, chat: { id: 111, type: "private" }, date: 0, from: { id: 1 } } },
    ])

    const adapter = makeTelegramAdapter({ id: "tg-se", httpTransport: transport })

    const target = makeDeliveryTarget("111", "update-1")

    // First partial (placeholder — chunkIndex 0, isPartial, not isFinal)
    await Effect.runPromise(
      adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false, chunkIndex: 0, totalChunks: 1 })),
    )

    // Second partial
    await Effect.runPromise(
      adapter.deliver(target, "Hello", makeDeliverOpts({ isPartial: true, isFinal: false, chunkIndex: 0, totalChunks: 1 })),
    )

    // Final
    await Effect.runPromise(
      adapter.deliver(target, "Hello world", makeDeliverOpts({ isPartial: false, isFinal: true, chunkIndex: 0, totalChunks: 1 })),
    )

    // First call must be sendMessage
    expect(calls[0]?.method).toBe("sendMessage")
    expect(calls[0]?.params["chat_id"]).toBe("111")
    expect(calls[0]?.params["text"]).toBe("…")

    // Subsequent calls must be editMessageText with the captured message_id
    expect(calls[1]?.method).toBe("editMessageText")
    expect(calls[1]?.params["chat_id"]).toBe("111")
    expect(calls[1]?.params["message_id"]).toBe(999)
    expect(calls[1]?.params["text"]).toBe("Hello")

    expect(calls[2]?.method).toBe("editMessageText")
    expect(calls[2]?.params["text"]).toBe("Hello world")
  })

  it("cleans up the turn-key after isFinal so a new turn starts fresh", async () => {
    const { transport, calls } = makeFakeTransport([
      // First turn: sendMessage
      { ok: true, result: { message_id: 100, chat: { id: 1, type: "private" }, date: 0, from: { id: 1 } } },
      // Second turn: sendMessage (should be new, not editMessageText)
      { ok: true, result: { message_id: 200, chat: { id: 1, type: "private" }, date: 0, from: { id: 1 } } },
    ])

    const adapter = makeTelegramAdapter({ id: "tg-cleanup", httpTransport: transport })

    const target1 = makeDeliveryTarget("1", "turn-A")
    const target2 = makeDeliveryTarget("1", "turn-B")

    // Complete the first turn
    await Effect.runPromise(adapter.deliver(target1, "…", makeDeliverOpts({ isPartial: true, isFinal: false, chunkIndex: 0, totalChunks: 1 })))
    await Effect.runPromise(adapter.deliver(target1, "Done", makeDeliverOpts({ isPartial: false, isFinal: true, chunkIndex: 0, totalChunks: 1 })))

    // Start a new turn (different platformMessageId)
    await Effect.runPromise(adapter.deliver(target2, "…", makeDeliverOpts({ isPartial: true, isFinal: false, chunkIndex: 0, totalChunks: 1 })))

    // First call: sendMessage for turn-A
    expect(calls[0]?.method).toBe("sendMessage")
    // Second call: editMessageText for turn-A final
    expect(calls[1]?.method).toBe("editMessageText")
    expect(calls[1]?.params["message_id"]).toBe(100)
    // Third call: sendMessage for turn-B (fresh turn — NOT editMessageText)
    expect(calls[2]?.method).toBe("sendMessage")
  })

  it("recovery send on isFinal does NOT leave a residual turn-key entry (no map leak)", async () => {
    // Scenario: the first-partial sendMessage succeeded (so sentMessageIds has
    // the turnKey), but then we simulate the case where existingMsgId is absent
    // (recovery path) on the isFinal call. After isFinal, the turn-key must be
    // gone so that a subsequent fresh turn starts with sendMessage, not editMessageText.
    //
    // We force the recovery path by: (1) NOT calling the first partial (so
    // sentMessageIds has no entry) and (2) calling deliver with isFinal=true.
    // After that call, a new first-partial for the same turnKey must again call
    // sendMessage (not editMessageText), proving the map is clean.

    // Script: recovery sendMessage, then a fresh sendMessage for the new turn.
    const { transport, calls } = makeFakeTransport([
      // Recovery sendMessage (isFinal call with no prior entry)
      { ok: true, result: { message_id: 300, chat: { id: 1, type: "private" }, date: 0, from: { id: 1 } } },
      // Fresh sendMessage for the next turn's first partial
      { ok: true, result: { message_id: 301, chat: { id: 1, type: "private" }, date: 0, from: { id: 1 } } },
    ])

    const adapter = makeTelegramAdapter({ id: "tg-leak", httpTransport: transport })
    const target = makeDeliveryTarget("1", "turn-leak")

    // Directly call with isFinal=true, no prior setup → recovery branch.
    await Effect.runPromise(
      adapter.deliver(target, "final content", makeDeliverOpts({ isPartial: false, isFinal: true, chunkIndex: 0, totalChunks: 1 })),
    )

    // Recovery branch should call sendMessage.
    expect(calls[0]?.method).toBe("sendMessage")

    // Now start a fresh turn with the SAME turnKey.
    // If the map were leaked, this would try editMessageText (wrong).
    // If the map is clean, this is treated as a first partial → sendMessage.
    await Effect.runPromise(
      adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false, chunkIndex: 0, totalChunks: 1 })),
    )

    // The second call must also be sendMessage (fresh turn, clean map).
    expect(calls[1]?.method).toBe("sendMessage")
    // No editMessageText calls at all — the map was not leaked.
    expect(calls.every((c) => c.method !== "editMessageText")).toBe(true)
  })

  it("ignores 'message is not modified' errors (400) silently", async () => {
    const { transport, calls } = makeFakeTransport([
      // sendMessage
      { ok: true, result: { message_id: 77, chat: { id: 5, type: "private" }, date: 0, from: { id: 1 } } },
      // editMessageText returns a "not modified" error — adapter should not throw
      { ok: false, error_code: 400, description: "Bad Request: message is not modified" },
    ])

    const adapter = makeTelegramAdapter({ id: "tg-notmod", httpTransport: transport })
    const target = makeDeliveryTarget("5", "turn-notmod")

    await Effect.runPromise(adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false, chunkIndex: 0, totalChunks: 1 })))

    // This should NOT throw even though the response is ok: false
    await expect(
      Effect.runPromise(adapter.deliver(target, "same content", makeDeliverOpts({ isPartial: false, isFinal: true, chunkIndex: 0, totalChunks: 1 }))),
    ).resolves.toBeUndefined()

    expect(calls).toHaveLength(2)
    expect(calls[1]?.method).toBe("editMessageText")
  })
})

/* -------------------------------------------------------------------------- */
/* 4. Reconnection: transient errors are retried, not fatal                   */
/* -------------------------------------------------------------------------- */

describe("reconnection: transient poll errors are retried", () => {
  it("a transport error on getUpdates is retried with the SAME offset, and at least 2 polls occur before success", async () => {
    const receivedMessages: ChannelMessage[] = []
    const textUpdate = makeTextUpdate({ updateId: 500, text: "after error" })

    // Record the offset parameter from every getUpdates call so we can assert
    // that the retry re-ran pollOnce with the SAME offset (not advanced).
    const getUpdatesOffsets: number[] = []

    // Script: first getUpdates fails, second succeeds with the update.
    // All other methods (sendMessage etc.) use the default fallback.
    const perMethodQueues: Partial<Record<string, Array<{ ok: boolean; result?: unknown; description?: string }>>> = {
      getUpdates: [
        { ok: false, description: "503: Service Unavailable" },
        { ok: true, result: [textUpdate] },
      ],
    }

    // Wrap the fake transport so we can intercept getUpdates offset values.
    const { transport: baseTransport } = makeFakeTransport([], perMethodQueues)
    const recordingTransport: TelegramHttpTransport = (method, params) =>
      Effect.sync(() => {
        if (method === "getUpdates") {
          getUpdatesOffsets.push(params["offset"] as number)
        }
      }).pipe(
        Effect.flatMap(() => baseTransport(method, params)),
      )

    const adapter = makeTelegramAdapter({ id: "tg-retry", httpTransport: recordingTransport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => { receivedMessages.push(msg) }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        // Need enough time for: first poll failure + 1 second backoff + second poll success
        yield* Effect.sleep("2500 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    // (a) The loop survived the error and delivered the message after retry.
    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0]?.text).toBe("after error")

    // (b) At least 2 getUpdates calls occurred (failing poll + at least one retry).
    // A single lucky poll cannot satisfy this.
    expect(getUpdatesOffsets.length).toBeGreaterThanOrEqual(2)

    // (c) The RETRY call used the SAME offset as the failing call (offset was NOT
    // advanced after the error — the adapter correctly preserves the offset via
    // the catchCause fallback in the loop).
    // First call: offset 0 (no prior successful polls).
    expect(getUpdatesOffsets[0]).toBe(0)
    // Second call (the retry): same offset 0 — not advanced past the failed poll.
    expect(getUpdatesOffsets[1]).toBe(0)
  }, 10_000)
})

/* -------------------------------------------------------------------------- */
/* 5. Dedup key correctness                                                   */
/* -------------------------------------------------------------------------- */

describe("dedup key: platformMessageId === update_id", () => {
  it("sets platformMessageId to update_id (string)", async () => {
    const receivedMessages: ChannelMessage[] = []
    const update = makeTextUpdate({ updateId: 9999 })

    const { transport } = makeFakeTransport([{ ok: true, result: [update] }])

    const adapter = makeTelegramAdapter({ id: "tg-dedup", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => { receivedMessages.push(msg) }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(receivedMessages[0]?.platformMessageId).toBe("9999")
  })

  it("same update_id produces same platformMessageId (dedup identity)", async () => {
    // Two updates with the same update_id (simulates a retry scenario).
    // Our adapter will emit two ChannelMessages with the same platformMessageId —
    // it is the ChannelService's InboundDedupStore that suppresses the second.
    // This test verifies the mapping is correct so dedup CAN work.
    const update = makeTextUpdate({ updateId: 8888, text: "test" })
    const { transport } = makeFakeTransport([
      { ok: true, result: [update] },        // first poll: delivers update 8888
      { ok: true, result: [update] },        // second poll: same update re-delivered
    ])

    const receivedMessages: ChannelMessage[] = []
    const adapter = makeTelegramAdapter({ id: "tg-dedup2", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => { receivedMessages.push(msg) }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("80 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    // Both messages have the same platformMessageId — dedup would catch the second
    const ids = receivedMessages.map((m) => m.platformMessageId)
    expect(ids.every((id) => id === "8888")).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* 6. End-to-end: TelegramAdapter wired into ChannelService                  */
/* -------------------------------------------------------------------------- */

/**
 * Stub ChatService for e2e test: thin clone of the one in channels.test.ts.
 */
const makeStubChatService = () => {
  const threads = new Map<string, PubSub.PubSub<ChatFrame>>()
  let createCount = 0
  let sendCount = 0

  const makeId = () => `thr_tg_${(++createCount).toString(16)}`

  const makeSummary = (id: string): SessionSummary => ({
    id,
    parentId: null,
    title: `tg-thread-${id}`,
    tags: [],
    createdAt: Date.now(),
    endedAt: null,
    model: "test",
    status: "active" as const,
    lastMessageAt: null,
    lastMessagePreview: null,
  })

  const service = {
    createThread: (opts: CreateThreadOptions) =>
      Effect.gen(function* () {
        const id = opts.threadIdOverride ?? makeId()
        const pub = yield* PubSub.unbounded<ChatFrame>()
        threads.set(id, pub)
        return makeSummary(id)
      }),
    send: (_threadId: string, _text: string) => {
      sendCount++
      return Effect.succeed(Option.none<ChatMessage>())
    },
    interrupt: () => Effect.void,
    subscribe: (threadId: string): Stream.Stream<ChatFrame, never> => {
      const pub = threads.get(threadId)
      if (pub === undefined) return Stream.empty
      return Stream.unwrap(
        Effect.gen(function* () {
          const sub = yield* PubSub.subscribe(pub)
          return Stream.fromSubscription(sub)
        }),
      )
    },
    listThreads: () => Effect.succeed([] as ReadonlyArray<SessionSummary>),
    searchMemory: () => Effect.succeed({ hits: [] as ReadonlyArray<{ id: string; kind: string; content: string; score: number }> }),
    closeThread: () => Effect.void,
    setThreadConfig: (opts: { threadId: string; model?: string }) =>
      Effect.succeed({
        threadId: opts.threadId,
        applied: [] as ReadonlyArray<"model" | "effort">,
        deferred: [] as ReadonlyArray<"model" | "effort">,
      }),
  }

  return { service, threads, getCreateCount: () => createCount, getSendCount: () => sendCount }
}

describe("end-to-end: TelegramAdapter + ChannelService", () => {
  it("inbound update → sendMessage + editMessageText delivery via stream-edit", async () => {
    const { service: chatService, threads } = makeStubChatService()

    const textUpdate = makeTextUpdate({ updateId: 7001, chatId: 2000, fromId: 3000, text: "e2e test" })

    // Use method-aware transport so the getUpdates queue and the
    // sendMessage/editMessageText queues don't cross-pollinate.
    const { transport, calls } = makeFakeTransport(
      [],
      {
        // getUpdates: one real update, then forever empty
        getUpdates: [
          { ok: true, result: [textUpdate] },
        ],
        // sendMessage: returns message_id 55 (the placeholder "…")
        sendMessage: [
          { ok: true, result: { message_id: 55, chat: { id: 2000, type: "private" }, date: 0, from: { id: 1 } } },
        ],
        // editMessageText: success for all subsequent edits
        editMessageText: [
          { ok: true, result: { message_id: 55, chat: { id: 2000, type: "private" }, date: 0, from: { id: 1 } } },
          { ok: true, result: { message_id: 55, chat: { id: 2000, type: "private" }, date: 0, from: { id: 1 } } },
          { ok: true, result: { message_id: 55, chat: { id: 2000, type: "private" }, date: 0, from: { id: 1 } } },
        ],
      },
    )

    const adapter = makeTelegramAdapter({ id: "tg-e2e", httpTransport: transport })

    const serviceLayer = ChannelServiceLayer.pipe(
      Layer.provide(ChannelSessionStore.Memory),
      Layer.provide(InboundDedupStore.Memory),
      Layer.provide(Layer.succeed(ChatService, chatService as unknown as InstanceType<typeof ChatService>)),
      Layer.provide(Clock.Default),
    )

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(adapter)
          yield* svc.startAdapters()

          // Give the poll loop time to run and fire the inbound update
          yield* Effect.sleep("80 millis")

          // Find the created thread and emit assistant frames
          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread created after poll")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          // Emit a streaming response:
          //   delta("…")                 → placeholder sendMessage
          //   delta("Hello from Telegram!") → sets currentDeltaText
          //   assistant-done             → no-op in stream-edit mode
          //   turn-complete              → final editMessageText with currentDeltaText
          yield* PubSub.publish(pub, {
            type: "assistant-delta",
            threadId,
            turnId: "t1",
            text: "…",  // first delta: triggers placeholder sendMessage
          } satisfies ChatFrame)

          // Allow the placeholder send to complete
          yield* Effect.sleep("30 millis")

          // Second delta: update currentDeltaText to the final content
          yield* PubSub.publish(pub, {
            type: "assistant-delta",
            threadId,
            turnId: "t1",
            text: "Hello from Telegram!",  // cumulative delta text
          } satisfies ChatFrame)

          yield* Effect.sleep("10 millis")

          yield* PubSub.publish(pub, {
            type: "assistant-done",
            threadId,
            turnId: "t1",
            seq: 1,
            message: {
              id: "m1", seq: 1, ts: Date.now(), role: "assistant",
              text: "Hello from Telegram!", toolUses: [], attachments: [],
            },
          } satisfies ChatFrame)

          yield* PubSub.publish(pub, {
            type: "turn-complete",
            threadId,
          } satisfies ChatFrame)

          // Wait long enough for the final edit (turn-complete is synchronous,
          // but the fiber needs to process frames and make the API call)
          yield* Effect.sleep("300 millis")
        }),
        serviceLayer,
      ) as Effect.Effect<void, never>,
    )

    // Verify the Telegram API calls
    const sendCalls = calls.filter((c) => c.method === "sendMessage")
    const editCalls = calls.filter((c) => c.method === "editMessageText")

    // At least one sendMessage (placeholder or final)
    expect(sendCalls.length).toBeGreaterThanOrEqual(1)
    expect(sendCalls[0]?.params["chat_id"]).toBe("2000")

    // At least one editMessageText on the captured message_id
    expect(editCalls.length).toBeGreaterThanOrEqual(1)
    expect(editCalls[editCalls.length - 1]?.params["message_id"]).toBe(55)
    // Final edit carries the complete turn text
    expect(editCalls[editCalls.length - 1]?.params["text"]).toBe("Hello from Telegram!")
  }, 15_000)
})

/* -------------------------------------------------------------------------- */
/* 7. Adapter identity and static properties                                  */
/* -------------------------------------------------------------------------- */

describe("adapter identity", () => {
  it("has correct transport, capability, and maxMessageLength", () => {
    const { transport } = makeFakeTransport()
    const adapter = makeTelegramAdapter({ id: "tg-id-test", httpTransport: transport })

    expect(adapter.transport).toBe("telegram")
    expect(adapter.capability).toBe("stream-edit")
    expect(adapter.maxMessageLength).toBe(4096)
    expect(adapter.id).toBe("tg-id-test")
  })

  it("stop() resolves cleanly without error", async () => {
    const adapter = makeTelegramAdapter({ id: "tg-stop", httpTransport: makeFakeTransport().transport })
    await expect(Effect.runPromise(adapter.stop())).resolves.toBeUndefined()
  })

  it("setMessageHandler installs the handler before start()", () => {
    const adapter = makeTelegramAdapter({ id: "tg-handler", httpTransport: makeFakeTransport().transport })
    let handlerInstalled = false
    adapter.setMessageHandler(() => {
      handlerInstalled = true
      return Effect.void
    })
    // Calling the handler should set the flag
    expect(handlerInstalled).toBe(false) // not called yet, just installed
  })
})

/* -------------------------------------------------------------------------- */
/* 8. makeRealTransport export (smoke test — no network)                      */
/* -------------------------------------------------------------------------- */

describe("makeRealTransport", () => {
  it("is exported and returns a function (accepts Redacted token)", () => {
    // makeRealTransport now requires a Redacted<string> so the plain-text token
    // is never stored as a bare string. The transport itself is still a function.
    const transport = makeRealTransport(Redacted.make("fake_token_12345"))
    expect(typeof transport).toBe("function")
  })
})


/* -------------------------------------------------------------------------- */
/* 9. buildChannelMessage: userId / username / firstName in metadata          */
/* -------------------------------------------------------------------------- */

describe("buildChannelMessage: extended metadata", () => {
  it("includes userId, username, firstName from msg.from in metadata", async () => {
    const receivedMessages: ChannelMessage[] = []

    const update = {
      update_id: 6001,
      message: {
        message_id: 99,
        chat: { id: 55555, type: "private" as const },
        from: {
          id: 12345,
          first_name: "Alice",
          username: "alice_tg",
        },
        text: "metadata test",
        date: Math.floor(Date.now() / 1000),
      },
    }

    const { transport } = makeFakeTransport([{ ok: true, result: [update] }])
    const adapter = makeTelegramAdapter({ id: "tg-meta", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => { receivedMessages.push(msg) }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(receivedMessages).toHaveLength(1)
    const msg = receivedMessages[0]
    expect(msg!.metadata).toMatchObject({
      chatType: "private",
      messageId: 99,
      userId: 12345,
      username: "alice_tg",
      firstName: "Alice",
    })
  })

  it("handles missing username gracefully (username is undefined)", async () => {
    const receivedMessages: ChannelMessage[] = []

    const update = {
      update_id: 6002,
      message: {
        message_id: 100,
        chat: { id: 55556, type: "private" as const },
        from: {
          id: 99999,
          first_name: "Bob",
          // no username field
        },
        text: "no username",
        date: Math.floor(Date.now() / 1000),
      },
    }

    const { transport } = makeFakeTransport([{ ok: true, result: [update] }])
    const adapter = makeTelegramAdapter({ id: "tg-meta-nousername", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => { receivedMessages.push(msg) }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0]!.metadata?.username).toBeUndefined()
    expect(receivedMessages[0]!.metadata?.userId).toBe(99999)
    expect(receivedMessages[0]!.metadata?.firstName).toBe("Bob")
  })
})

/* -------------------------------------------------------------------------- */
/* HTML formatting on deliver                                                  */
/* -------------------------------------------------------------------------- */

describe("deliver: markdown → Telegram HTML", () => {
  it("sends converted HTML with parse_mode and link previews disabled", async () => {
    const { transport, calls } = makeFakeTransport()
    const adapter = makeTelegramAdapter({ id: "tg-html", httpTransport: transport })
    const target = makeDeliveryTarget("101", "u-html-1")

    await Effect.runPromise(adapter.deliver(target, "**bold** and `code`", makeDeliverOpts()))

    const send = calls.find((c) => c.method === "sendMessage")
    expect(send?.params["text"]).toBe("<b>bold</b> and <code>code</code>")
    expect(send?.params["parse_mode"]).toBe("HTML")
    expect(send?.params["link_preview_options"]).toEqual({ is_disabled: true })
  })

  it("falls back to plain text when Telegram rejects the HTML", async () => {
    const { transport, calls } = makeFakeTransport([], {
      sendMessage: [
        {
          ok: false,
          error_code: 400,
          description:
            "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 5",
        },
        { ok: true, result: { message_id: 7, chat: { id: 101, type: "private" }, date: 0 } },
      ],
    })
    const adapter = makeTelegramAdapter({ id: "tg-fallback", httpTransport: transport })
    const target = makeDeliveryTarget("101", "u-fallback-1")

    await Effect.runPromise(adapter.deliver(target, ">! step\n**bold**", makeDeliverOpts()))

    const sends = calls.filter((c) => c.method === "sendMessage")
    expect(sends).toHaveLength(2)
    // First attempt: HTML. Second: plain text with the internal marker downgraded.
    expect(sends[0]?.params["parse_mode"]).toBe("HTML")
    expect(sends[1]?.params["parse_mode"]).toBeUndefined()
    expect(sends[1]?.params["text"]).toBe("> step\n**bold**")
    // Preview suppression survives the fallback — only parse_mode is dropped.
    expect(sends[1]?.params["link_preview_options"]).toEqual({ is_disabled: true })
  })

  it("edits with HTML formatting too", async () => {
    const { transport, calls } = makeFakeTransport([], {
      sendMessage: [
        { ok: true, result: { message_id: 55, chat: { id: 101, type: "private" }, date: 0 } },
      ],
    })
    const adapter = makeTelegramAdapter({ id: "tg-html-edit", httpTransport: transport })
    const target = makeDeliveryTarget("101", "u-html-edit")

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false }))
        yield* adapter.deliver(target, "# Done", makeDeliverOpts())
      }),
    )

    const edit = calls.find((c) => c.method === "editMessageText")
    expect(edit?.params["text"]).toBe("<b>Done</b>")
    expect(edit?.params["parse_mode"]).toBe("HTML")
  })
})

/* -------------------------------------------------------------------------- */
/* Continuation chunks (long final answers)                                    */
/* -------------------------------------------------------------------------- */

describe("deliver: continuation chunks", () => {
  it("chunk 0 edits the placeholder; later chunks are fresh messages", async () => {
    const { transport, calls } = makeFakeTransport([], {
      sendMessage: [
        { ok: true, result: { message_id: 91, chat: { id: 202, type: "private" }, date: 0 } },
        { ok: true, result: { message_id: 92, chat: { id: 202, type: "private" }, date: 0 } },
      ],
    })
    const adapter = makeTelegramAdapter({ id: "tg-chunks", httpTransport: transport })
    const target = makeDeliveryTarget("202", "u-chunks-1")

    await Effect.runPromise(
      Effect.gen(function* () {
        // Placeholder (stream-edit turn in flight)
        yield* adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false }))
        // Finalization split across two chunks
        yield* adapter.deliver(
          target,
          "part one",
          makeDeliverOpts({ isFinal: false, chunkIndex: 0, totalChunks: 2 }),
        )
        yield* adapter.deliver(
          target,
          "part two",
          makeDeliverOpts({ isFinal: true, chunkIndex: 1, totalChunks: 2 }),
        )
      }),
    )

    const edits = calls.filter((c) => c.method === "editMessageText")
    const sends = calls.filter((c) => c.method === "sendMessage")
    expect(edits).toHaveLength(1)
    expect(edits[0]?.params["text"]).toBe("part one")
    expect(sends).toHaveLength(2) // placeholder + continuation
    expect(sends[1]?.params["text"]).toBe("part two")

    // Turn state is cleaned up: a new turn starts fresh with sendMessage.
    await Effect.runPromise(
      adapter.deliver(makeDeliveryTarget("202", "u-chunks-2"), "next", makeDeliverOpts()),
    )
    const sendsAfter = calls.filter((c) => c.method === "sendMessage")
    expect(sendsAfter).toHaveLength(3)
  })
})

/* -------------------------------------------------------------------------- */
/* Group reply threading                                                       */
/* -------------------------------------------------------------------------- */

describe("deliver: group reply threading", () => {
  const makeGroupTarget = (platformMessageId: string): DeliveryTarget => ({
    inReplyTo: {
      transport: "telegram",
      channelId: "-500",
      senderId: "999",
      threadingKey: "-500",
      text: "hello",
      platformMessageId,
      ts: new Date().toISOString(),
    },
    address: {
      transport: "telegram",
      channelId: "-500",
      senderId: "999",
      threadingKey: "-500",
      chatType: "group",
      messageId: 42,
    },
  })

  it("threads the first group reply onto the triggering message", async () => {
    const { transport, calls } = makeFakeTransport()
    const adapter = makeTelegramAdapter({ id: "tg-reply", httpTransport: transport })

    await Effect.runPromise(adapter.deliver(makeGroupTarget("u-grp-1"), "hi", makeDeliverOpts()))

    const send = calls.find((c) => c.method === "sendMessage")
    expect(send?.params["reply_parameters"]).toEqual({ message_id: 42 })
  })

  it("does not add reply parameters in private chats", async () => {
    const { transport, calls } = makeFakeTransport()
    const adapter = makeTelegramAdapter({ id: "tg-noreply", httpTransport: transport })
    // makeDeliveryTarget carries no chatType → treated as private/unknown
    await Effect.runPromise(
      adapter.deliver(makeDeliveryTarget("101", "u-dm-1"), "hi", makeDeliverOpts()),
    )

    const send = calls.find((c) => c.method === "sendMessage")
    expect(send?.params["reply_parameters"]).toBeUndefined()
  })

  it("does not add reply parameters on continuation chunks", async () => {
    const { transport, calls } = makeFakeTransport()
    const adapter = makeTelegramAdapter({ id: "tg-reply-chunks", httpTransport: transport })
    const target = makeGroupTarget("u-grp-2")

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* adapter.deliver(target, "a", makeDeliverOpts({ isFinal: false, totalChunks: 2 }))
        yield* adapter.deliver(
          target,
          "b",
          makeDeliverOpts({ isFinal: true, chunkIndex: 1, totalChunks: 2 }),
        )
      }),
    )

    const sends = calls.filter((c) => c.method === "sendMessage")
    expect(sends[0]?.params["reply_parameters"]).toEqual({ message_id: 42 })
    expect(sends[1]?.params["reply_parameters"]).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/* Loading indication: typing chat action                                      */
/* -------------------------------------------------------------------------- */

describe("typing indicator", () => {
  it("sends a typing action when a message arrives and stops after the first deliver", async () => {
    const update = makeTextUpdate({ chatId: 777, updateId: 9100, text: "work on this" })
    const { transport, calls } = makeFakeTransport([{ ok: true, result: [update] }])
    const adapter = makeTelegramAdapter({ id: "tg-typing", httpTransport: transport })
    adapter.setMessageHandler(() => Effect.void)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("80 millis")

        const typingCalls = calls.filter((c) => c.method === "sendChatAction")
        expect(typingCalls.length).toBeGreaterThanOrEqual(1)
        expect(typingCalls[0]?.params).toMatchObject({ chat_id: "777", action: "typing" })

        // First deliver stops the loop; no typing call should follow it.
        yield* adapter.deliver(
          makeDeliveryTarget("777", "9100"),
          "…",
          makeDeliverOpts({ isPartial: true, isFinal: false }),
        )
        const countAtDeliver = calls.filter((c) => c.method === "sendChatAction").length
        yield* Effect.sleep("100 millis")
        const countAfter = calls.filter((c) => c.method === "sendChatAction").length
        expect(countAfter).toBe(countAtDeliver)

        yield* Fiber.interrupt(fiber)
      }),
    )
  })

  it("stop() sweeps any live typing fibers", async () => {
    const update = makeTextUpdate({ chatId: 778, updateId: 9200 })
    const { transport, calls } = makeFakeTransport([{ ok: true, result: [update] }])
    const adapter = makeTelegramAdapter({ id: "tg-typing-stop", httpTransport: transport })
    adapter.setMessageHandler(() => Effect.void)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
        yield* adapter.stop()
        const countAtStop = calls.filter((c) => c.method === "sendChatAction").length
        yield* Effect.sleep("80 millis")
        const countAfter = calls.filter((c) => c.method === "sendChatAction").length
        expect(countAfter).toBe(countAtStop)
      }),
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Command registration + mention normalization                                */
/* -------------------------------------------------------------------------- */

describe("start(): command registration", () => {
  it("registers the built-in commands via setMyCommands", async () => {
    const { transport, calls } = makeFakeTransport()
    const adapter = makeTelegramAdapter({ id: "tg-cmds", httpTransport: transport })
    adapter.setMessageHandler(() => Effect.void)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("30 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    const reg = calls.find((c) => c.method === "setMyCommands")
    expect(reg).toBeDefined()
    expect(reg?.params["commands"]).toEqual(
      channelCommands.map((c) => ({ command: c.id, description: c.description })),
    )
    // Telegram constraints: 1-32 chars, lowercase letters/digits/underscores.
    for (const c of channelCommands) {
      expect(c.id).toMatch(/^[a-z0-9_]{1,32}$/)
      expect(c.description.length).toBeGreaterThanOrEqual(1)
      expect(c.description.length).toBeLessThanOrEqual(256)
    }
  })

  it("drops group commands addressed to another bot and strips our own mention", async () => {
    const received: ChannelMessage[] = []
    const forOther = makeTextUpdate({
      chatId: -600,
      chatType: "group",
      updateId: 9300,
      text: "/new@OtherBot",
    })
    const forUs = makeTextUpdate({
      chatId: -600,
      chatType: "group",
      updateId: 9301,
      text: "/new@LunaTestBot with args",
    })
    // getMe default resolves username LunaTestBot (see makeFakeTransport).
    const { transport } = makeFakeTransport([{ ok: true, result: [forOther, forUs] }])
    const adapter = makeTelegramAdapter({ id: "tg-mentions", httpTransport: transport })
    adapter.setMessageHandler((msg) => Effect.sync(() => { received.push(msg) }))

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("60 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(received).toHaveLength(1)
    expect(received[0]?.text).toBe("/new with args")
  })
})

describe("normalizeCommandMention", () => {
  it("passes non-command text through unchanged", () => {
    expect(normalizeCommandMention("hello @LunaTestBot", "LunaTestBot")).toBe(
      "hello @LunaTestBot",
    )
  })

  it("strips our mention case-insensitively", () => {
    expect(normalizeCommandMention("/stop@lunatestbot", "LunaTestBot")).toBe("/stop")
  })

  it("drops commands for other bots", () => {
    expect(normalizeCommandMention("/stop@OtherBot", "LunaTestBot")).toBeNull()
  })

  it("leaves bare commands and unknown-username cases unchanged", () => {
    expect(normalizeCommandMention("/stop now", "LunaTestBot")).toBe("/stop now")
    expect(normalizeCommandMention("/stop@AnyBot", null)).toBe("/stop@AnyBot")
  })
})

/* -------------------------------------------------------------------------- */
/* Lifecycle-call resilience + final-send cleanup                              */
/* -------------------------------------------------------------------------- */

describe("start(): lifecycle-call resilience", () => {
  it("polling starts even when getMe and setMyCommands die", async () => {
    const { transport: base, calls } = makeFakeTransport()
    const dyingTransport: TelegramHttpTransport = (method, params) =>
      method === "getMe" || method === "setMyCommands"
        ? Effect.die(new Error(`${method} exploded`))
        : base(method, params)

    const adapter = makeTelegramAdapter({ id: "tg-lifecycle-die", httpTransport: dyingTransport })
    adapter.setMessageHandler(() => Effect.void)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    // The poll loop reached getUpdates despite both lifecycle calls dying.
    expect(calls.some((c) => c.method === "getUpdates")).toBe(true)
  })
})

describe("deliver: final cleanup is failure-proof", () => {
  it("drops the turn key even when the final send dies", async () => {
    const { transport: base, calls } = makeFakeTransport()
    let dieOnSend = false
    const flakyTransport: TelegramHttpTransport = (method, params) =>
      method === "editMessageText" && dieOnSend
        ? Effect.die(new Error("network exploded"))
        : base(method, params)

    const adapter = makeTelegramAdapter({ id: "tg-final-die", httpTransport: flakyTransport })
    const target = makeDeliveryTarget("303", "u-die-1")

    // Placeholder creates the edit-routing entry.
    await Effect.runPromise(
      adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false })),
    )
    // Final edit dies mid-flight (delivery.ts would swallow this).
    dieOnSend = true
    await Effect.runPromise(Effect.exit(adapter.deliver(target, "final", makeDeliverOpts())))
    dieOnSend = false

    // The entry must be gone: a retry on the SAME turn key sends a fresh
    // message instead of editing a stale one. (The dying edit bypasses the
    // recording fake entirely, so no editMessageText call is visible.)
    await Effect.runPromise(adapter.deliver(target, "retry", makeDeliverOpts()))
    const methods = calls.map((c) => c.method)
    expect(methods.filter((m) => m === "sendMessage")).toHaveLength(2) // placeholder + retry
    expect(methods.filter((m) => m === "editMessageText")).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Inbound allowlist (union gate: sender id OR chat id)                        */
/* -------------------------------------------------------------------------- */

describe("inbound allowlist", () => {
  /** Drive one poll of `updates` through an adapter with the given allowlist. */
  const runInbound = async (
    updates: ReturnType<typeof makeTextUpdate>[],
    allowedIds: TelegramAdapterConfig["allowedIds"],
  ): Promise<ChannelMessage[]> => {
    const received: ChannelMessage[] = []
    const { transport } = makeFakeTransport([{ ok: true, result: updates }])
    const adapter = makeTelegramAdapter({
      id: "tg-allow",
      httpTransport: transport,
      ...(allowedIds !== undefined ? { allowedIds } : {}),
    })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => {
        received.push(msg)
      }),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )
    return received
  }

  it("accepts a DM whose sender id is allowlisted, drops other senders in the same batch", async () => {
    const allowed = makeTextUpdate({ fromId: 111, chatId: 111, updateId: 7001, text: "hi" })
    const blocked = makeTextUpdate({ fromId: 222, chatId: 222, updateId: 7002, text: "nope" })
    const received = await runInbound([allowed, blocked], ["111"])
    expect(received.map((m) => m.senderId)).toEqual(["111"])
  })

  it("serves EVERY sender in an allowlisted group (chat id), even senders not in the list", async () => {
    // Group chat -100500 is allowlisted; neither member's user id is listed.
    const memberA = makeTextUpdate({ fromId: 333, chatId: -100500, chatType: "supergroup", updateId: 7101, text: "a" })
    const memberB = makeTextUpdate({ fromId: 444, chatId: -100500, chatType: "supergroup", updateId: 7102, text: "b" })
    const outsider = makeTextUpdate({ fromId: 555, chatId: 555, updateId: 7103, text: "dm" })
    const received = await runInbound([memberA, memberB, outsider], ["-100500"])
    // Both group members served (chat-id match); the unrelated DM is dropped.
    expect(received.map((m) => m.senderId).sort()).toEqual(["333", "444"])
    expect(received.every((m) => m.channelId === "-100500")).toBe(true)
  })

  it("is open (accepts any sender) when allowedIds is omitted", async () => {
    const a = makeTextUpdate({ fromId: 1, chatId: 1, updateId: 7201 })
    const b = makeTextUpdate({ fromId: 2, chatId: 2, updateId: 7202 })
    const received = await runInbound([a, b], undefined)
    expect(received).toHaveLength(2)
  })

  it("is open when allowedIds is empty (fail-open, not fail-closed)", async () => {
    const a = makeTextUpdate({ fromId: 1, chatId: 1, updateId: 7301 })
    const received = await runInbound([a], [])
    expect(received).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Poll-loop error logging (surfaces previously-silent getUpdates failures)   */
/* -------------------------------------------------------------------------- */

describe("poll-loop error logging", () => {
  /**
   * Script one getUpdates failure (then recovery), run the loop briefly with a
   * console.warn spy, and return every warning string emitted. The failure is
   * retried per the reconnection contract; we only assert on the LOG side-effect
   * so retry/offset behavior is untouched.
   */
  const captureWarnings = async (failDescription: string): Promise<string[]> => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "))
    })
    try {
      const { transport } = makeFakeTransport([], {
        getUpdates: [{ ok: false, description: failDescription }],
      })
      const adapter = makeTelegramAdapter({ id: "tg-log", httpTransport: transport })
      adapter.setMessageHandler(() => Effect.void)
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
          yield* Effect.sleep("120 millis") // enough for the failing poll to log once
          yield* Fiber.interrupt(fiber)
        }),
      )
    } finally {
      warnSpy.mockRestore()
    }
    return warnings
  }

  it("emits a DISTINCT 409 Conflict warning when another poller holds the token", async () => {
    const warnings = await captureWarnings("409: Conflict: terminated by other getUpdates request")
    const conflict = warnings.filter((w) => w.includes("409 Conflict") && w.includes("another poller"))
    expect(conflict.length).toBeGreaterThanOrEqual(1)
    // It must NOT be logged as the generic failure line.
    expect(warnings.some((w) => w.includes("getUpdates failed, retrying"))).toBe(false)
  })

  it("logs a generic retry warning for a non-409 transient failure", async () => {
    const warnings = await captureWarnings("503: Service Unavailable")
    expect(warnings.some((w) => w.includes("getUpdates failed, retrying with backoff"))).toBe(true)
    // A 503 must NOT trip the 409 branch.
    expect(warnings.some((w) => w.includes("409 Conflict"))).toBe(false)
  })
})


/* -------------------------------------------------------------------------- */
/* Tap-to-stop inline button (callback_query)                                 */
/* -------------------------------------------------------------------------- */

describe("tap-to-stop inline button (callback_query)", () => {
  it("dispatches a synthetic /stop through the existing handleMessage pipeline for an allowed tapper", async () => {
    const stopCb = makeStopCallback({ updateId: 11000, fromId: 999, chatId: 111, messageId: 42 })
    const { transport, calls } = makeFakeTransport([{ ok: true, result: [stopCb] }])
    const adapter = makeTelegramAdapter({ id: "tg-stop-tap", httpTransport: transport })
    const received: ChannelMessage[] = []
    adapter.setMessageHandler((msg) => Effect.sync(() => { received.push(msg) }))

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(received).toHaveLength(1)
    const msg = received[0]!
    expect(msg.text).toBe("/stop")
    expect(msg.channelId).toBe("111")
    expect(msg.senderId).toBe("999")
    expect(msg.platformMessageId).toBe("11000")

    const answered = calls.find((c) => c.method === "answerCallbackQuery")
    expect(answered?.params["callback_query_id"]).toBe("cq-stop-1")
  })

  it("gates the tap through the SAME allowlist as messages — a non-allowlisted tapper's button never reaches the handler", async () => {
    const stopCb = makeStopCallback({ updateId: 11100, fromId: 666, chatId: 666 })
    const { transport, calls } = makeFakeTransport([{ ok: true, result: [stopCb] }])
    const received: ChannelMessage[] = []
    const adapter = makeTelegramAdapter({
      id: "tg-stop-tap-blocked",
      httpTransport: transport,
      allowedIds: ["111"],
    })
    adapter.setMessageHandler((msg) => Effect.sync(() => { received.push(msg) }))

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(received).toHaveLength(0)
    // Still answered — never leaves the tapper's client spinning.
    const answered = calls.find((c) => c.method === "answerCallbackQuery")
    expect(answered?.params["callback_query_id"]).toBe("cq-stop-1")
  })

  it("does not treat an unrelated callback_data as a stop tap", async () => {
    const other = makeStopCallback({ updateId: 11200, data: "not-stop" })
    const { transport } = makeFakeTransport([{ ok: true, result: [other] }])
    const received: ChannelMessage[] = []
    const adapter = makeTelegramAdapter({ id: "tg-stop-other-data", httpTransport: transport })
    adapter.setMessageHandler((msg) => Effect.sync(() => { received.push(msg) }))

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(received).toHaveLength(0)
  })

  it("reaches the handler immediately, without waiting behind the per-chat FIFO chain it exists to interrupt", async () => {
    // A slow text message occupies chat 111's FIFO chain; the stop tap for
    // the SAME chat must bypass it entirely, not queue behind it.
    const slowText = makeTextUpdate({ chatId: 111, updateId: 11300, text: "long running work" })
    const stopCb = makeStopCallback({ updateId: 11301, chatId: 111 })
    const { transport } = makeFakeTransport([{ ok: true, result: [slowText, stopCb] }])
    const order: string[] = []
    const adapter = makeTelegramAdapter({ id: "tg-stop-priority", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.gen(function* () {
        if (msg.text === "/stop") {
          order.push("stop")
          return
        }
        // Simulate slow work occupying the FIFO chain for this chat.
        yield* Effect.sleep("200 millis")
        order.push("slow-work-done")
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("60 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    // The stop tap ran (and finished) before the slow chained work — proving
    // it was dispatched OUTSIDE dispatchChained, not queued behind it.
    expect(order[0]).toBe("stop")
  })
})

/* -------------------------------------------------------------------------- */
/* deliver: tap-to-stop inline keyboard                                       */
/* -------------------------------------------------------------------------- */

describe("deliver: tap-to-stop inline keyboard", () => {
  it("attaches the stop keyboard on partial deliveries, omits it once the turn finalizes", async () => {
    const { transport, calls } = makeFakeTransport([], {
      sendMessage: [
        { ok: true, result: { message_id: 61, chat: { id: 111, type: "private" }, date: 0 } },
      ],
    })
    const adapter = makeTelegramAdapter({ id: "tg-stop-kb", httpTransport: transport })
    const target = makeDeliveryTarget("111", "u-stop-kb-1")

    await Effect.runPromise(
      Effect.gen(function* () {
        // Placeholder — partial.
        yield* adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false }))
        // Streamed delta — still partial.
        yield* adapter.deliver(target, "Hello", makeDeliverOpts({ isPartial: true, isFinal: false }))
        // Final — turn done.
        yield* adapter.deliver(target, "Hello world", makeDeliverOpts({ isPartial: false, isFinal: true }))
      }),
    )

    const send = calls.find((c) => c.method === "sendMessage")
    expect(send?.params["reply_markup"]).toEqual({
      inline_keyboard: [[{ text: "⏹ Stop", callback_data: "stop" }]],
    })

    const edits = calls.filter((c) => c.method === "editMessageText")
    expect(edits).toHaveLength(2)
    expect(edits[0]?.params["reply_markup"]).toEqual({
      inline_keyboard: [[{ text: "⏹ Stop", callback_data: "stop" }]],
    })
    // The final edit omits reply_markup entirely — the button disappears.
    expect(edits[1]?.params).not.toHaveProperty("reply_markup")
  })

  it("never attaches the stop keyboard to an interrupt's final edit", async () => {
    const { transport, calls } = makeFakeTransport([], {
      sendMessage: [
        { ok: true, result: { message_id: 62, chat: { id: 111, type: "private" }, date: 0 } },
      ],
    })
    const adapter = makeTelegramAdapter({ id: "tg-stop-kb-interrupt", httpTransport: transport })
    const target = makeDeliveryTarget("111", "u-stop-kb-2")

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false }))
        yield* adapter.deliver(
          target,
          "partial text\n\n⏹ Stopped.",
          makeDeliverOpts({ isPartial: false, isFinal: true }),
        )
      }),
    )

    const edit = calls.find((c) => c.method === "editMessageText")
    expect(edit?.params).not.toHaveProperty("reply_markup")
  })
})

/* -------------------------------------------------------------------------- */
/* "Working" reaction glyph (setMessageReaction)                              */
/* -------------------------------------------------------------------------- */

describe("\"working\" reaction glyph (setMessageReaction)", () => {
  it("reacts to the inbound message with the working emoji when a turn starts", async () => {
    const update = makeTextUpdate({ chatId: 555, updateId: 12000, messageId: 77, text: "do a thing" })
    const { transport, calls } = makeFakeTransport([{ ok: true, result: [update] }])
    const adapter = makeTelegramAdapter({ id: "tg-reaction", httpTransport: transport })
    adapter.setMessageHandler(() => Effect.void)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    const reaction = calls.find((c) => c.method === "setMessageReaction")
    expect(reaction?.params).toMatchObject({
      chat_id: "555",
      message_id: 77,
      reaction: [{ type: "emoji", emoji: "\u{1F440}" }],
    })
  })

  it("a failing setMessageReaction (400) never blocks the message reaching the handler", async () => {
    const update = makeTextUpdate({ chatId: 556, updateId: 12100, text: "still works" })
    const { transport: base } = makeFakeTransport([{ ok: true, result: [update] }])
    const flaky: TelegramHttpTransport = (method, params) =>
      method === "setMessageReaction"
        ? Effect.succeed({ ok: false, error_code: 400, description: "Bad Request: REACTION_INVALID" })
        : base(method, params)
    const received: ChannelMessage[] = []
    const adapter = makeTelegramAdapter({ id: "tg-reaction-fail", httpTransport: flaky })
    adapter.setMessageHandler((msg) => Effect.sync(() => { received.push(msg) }))

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(received).toHaveLength(1)
    expect(received[0]?.text).toBe("still works")
  })

  it("a dying setMessageReaction (defect) never breaks the poll loop", async () => {
    const update = makeTextUpdate({ chatId: 557, updateId: 12200, text: "survives defect" })
    const { transport: base } = makeFakeTransport([{ ok: true, result: [update] }])
    const dying: TelegramHttpTransport = (method, params) =>
      method === "setMessageReaction" ? Effect.die(new Error("boom")) : base(method, params)
    const received: ChannelMessage[] = []
    const adapter = makeTelegramAdapter({ id: "tg-reaction-die", httpTransport: dying })
    adapter.setMessageHandler((msg) => Effect.sync(() => { received.push(msg) }))

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(received).toHaveLength(1)
  })

  /**
   * The read receipt used to fail 100% silently (both a non-ok API result and
   * a transport defect were swallowed with zero trace) — a chat with
   * restricted `available_reactions` would never show a hint that Luna's
   * only user-visible "I read this" signal on Telegram had stopped working.
   * These assert the failure IS now surfaced, exactly once per chat.
   */
  it("logs a warning (once) when setMessageReaction returns a non-ok result", async () => {
    const chatId = 558
    const updates = [
      makeTextUpdate({ chatId, updateId: 12300, messageId: 1, text: "first" }),
      makeTextUpdate({ chatId, updateId: 12301, messageId: 2, text: "second" }),
    ]
    const { transport: base } = makeFakeTransport([{ ok: true, result: updates }])
    const flaky: TelegramHttpTransport = (method, params) =>
      method === "setMessageReaction"
        ? Effect.succeed({ ok: false, error_code: 400, description: "Bad Request: REACTION_INVALID" })
        : base(method, params)
    const adapter = makeTelegramAdapter({ id: "tg-reaction-warn", httpTransport: flaky })
    adapter.setMessageHandler(() => Effect.void)

    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "))
    })
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
          yield* Effect.sleep("50 millis")
          yield* Fiber.interrupt(fiber)
        }),
      )
    } finally {
      warnSpy.mockRestore()
    }

    const hits = warnings.filter(
      (w) => w.includes("read-receipt") && w.includes(`chat=${chatId}`) && w.includes("REACTION_INVALID"),
    )
    // Two messages in the same chat both fail — only the FIRST is logged.
    expect(hits).toHaveLength(1)
  })

  it("logs a warning when setMessageReaction dies (transport defect), not just a non-ok result", async () => {
    const chatId = 559
    const update = makeTextUpdate({ chatId, updateId: 12400, text: "defect path" })
    const { transport: base } = makeFakeTransport([{ ok: true, result: [update] }])
    const dying: TelegramHttpTransport = (method, params) =>
      method === "setMessageReaction" ? Effect.die(new Error("boom")) : base(method, params)
    const adapter = makeTelegramAdapter({ id: "tg-reaction-warn-defect", httpTransport: dying })
    adapter.setMessageHandler(() => Effect.void)

    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "))
    })
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
          yield* Effect.sleep("50 millis")
          yield* Fiber.interrupt(fiber)
        }),
      )
    } finally {
      warnSpy.mockRestore()
    }

    expect(warnings.some((w) => w.includes("read-receipt") && w.includes(`chat=${chatId}`))).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Forum-topic session scoping                                                */
/* -------------------------------------------------------------------------- */

describe("forum-topic session scoping", () => {
  it("keys two different topics in the same forum chat to different threadingKeys", async () => {
    const topicA = makeTextUpdate({
      chatId: 700, updateId: 13000, text: "topic A msg",
      isForum: true, isTopicMessage: true, messageThreadId: 501,
    })
    const topicB = makeTextUpdate({
      chatId: 700, updateId: 13001, text: "topic B msg",
      isForum: true, isTopicMessage: true, messageThreadId: 502,
    })
    const { transport } = makeFakeTransport([{ ok: true, result: [topicA, topicB] }])
    const received: ChannelMessage[] = []
    const adapter = makeTelegramAdapter({ id: "tg-forum", httpTransport: transport })
    adapter.setMessageHandler((msg) => Effect.sync(() => { received.push(msg) }))

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(received).toHaveLength(2)
    expect(received[0]?.channelId).toBe("700")
    expect(received[1]?.channelId).toBe("700")
    expect(received[0]?.threadingKey).not.toBe(received[1]?.threadingKey)
    expect(received[0]?.threadingKey).toBe("700:topic:501")
    expect(received[1]?.threadingKey).toBe("700:topic:502")
    expect(received[0]?.metadata?.["messageThreadId"]).toBe(501)
    expect(received[1]?.metadata?.["messageThreadId"]).toBe(502)
  })

  it("leaves a non-forum group's threadingKey unchanged (plain chat id)", async () => {
    const update = makeTextUpdate({ chatId: -800, chatType: "supergroup", updateId: 13100, text: "hi" })
    const { transport } = makeFakeTransport([{ ok: true, result: [update] }])
    const received: ChannelMessage[] = []
    const adapter = makeTelegramAdapter({ id: "tg-nonforum", httpTransport: transport })
    adapter.setMessageHandler((msg) => Effect.sync(() => { received.push(msg) }))

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(received[0]?.threadingKey).toBe("-800")
    expect(received[0]?.metadata?.["messageThreadId"]).toBeUndefined()
  })

  it("leaves a DM's threadingKey unchanged", async () => {
    const update = makeTextUpdate({ chatId: 111, chatType: "private", updateId: 13200 })
    const { transport } = makeFakeTransport([{ ok: true, result: [update] }])
    const received: ChannelMessage[] = []
    const adapter = makeTelegramAdapter({ id: "tg-dm-unaffected", httpTransport: transport })
    adapter.setMessageHandler((msg) => Effect.sync(() => { received.push(msg) }))

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(received[0]?.threadingKey).toBe("111")
  })

  it("threads message_thread_id through the typing indicator", async () => {
    const update = makeTextUpdate({
      chatId: 900, updateId: 13300, text: "topic work",
      isForum: true, isTopicMessage: true, messageThreadId: 77,
    })
    const { transport, calls } = makeFakeTransport([{ ok: true, result: [update] }])
    const adapter = makeTelegramAdapter({ id: "tg-forum-typing", httpTransport: transport })
    adapter.setMessageHandler(() => Effect.void)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(adapter.start()))
        yield* Effect.sleep("60 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    const typing = calls.find((c) => c.method === "sendChatAction")
    expect(typing?.params).toMatchObject({ chat_id: "900", message_thread_id: 77 })
  })

  it("continuation-chunk sendMessage calls carry message_thread_id from the delivery target", async () => {
    const { transport, calls } = makeFakeTransport([], {
      sendMessage: [
        { ok: true, result: { message_id: 91, chat: { id: 900, type: "supergroup" }, date: 0 } },
        { ok: true, result: { message_id: 92, chat: { id: 900, type: "supergroup" }, date: 0 } },
      ],
    })
    const adapter = makeTelegramAdapter({ id: "tg-forum-chunks", httpTransport: transport })
    const target: DeliveryTarget = {
      inReplyTo: {
        transport: "telegram",
        channelId: "900",
        senderId: "999",
        threadingKey: "900:topic:77",
        text: "hello",
        platformMessageId: "u-forum-1",
        ts: new Date().toISOString(),
      },
      address: {
        transport: "telegram",
        channelId: "900",
        senderId: "999",
        threadingKey: "900:topic:77",
        messageThreadId: 77,
      },
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false }))
        yield* adapter.deliver(
          target,
          "part two",
          makeDeliverOpts({ isFinal: true, chunkIndex: 1, totalChunks: 2 }),
        )
      }),
    )

    const sends = calls.filter((c) => c.method === "sendMessage")
    expect(sends).toHaveLength(2)
    expect(sends[0]?.params["message_thread_id"]).toBe(77)
    expect(sends[1]?.params["message_thread_id"]).toBe(77)
  })

  it("two topics in the same forum chat resolve to two distinct Luna threads end-to-end", async () => {
    const { service: chatService, getCreateCount } = makeStubChatService()
    const topicA = makeTextUpdate({
      chatId: 950, updateId: 13400, text: "topic A",
      isForum: true, isTopicMessage: true, messageThreadId: 10,
    })
    const topicB = makeTextUpdate({
      chatId: 950, updateId: 13401, text: "topic B",
      isForum: true, isTopicMessage: true, messageThreadId: 20,
    })
    const { transport } = makeFakeTransport([], { getUpdates: [{ ok: true, result: [topicA, topicB] }] })
    const adapter = makeTelegramAdapter({ id: "tg-forum-e2e", httpTransport: transport })

    const serviceLayer = ChannelServiceLayer.pipe(
      Layer.provide(ChannelSessionStore.Memory),
      Layer.provide(InboundDedupStore.Memory),
      Layer.provide(Layer.succeed(ChatService, chatService as unknown as InstanceType<typeof ChatService>)),
      Layer.provide(Clock.Default),
    )

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(adapter)
          yield* svc.startAdapters()
          yield* Effect.sleep("80 millis")
        }),
        serviceLayer,
      ) as Effect.Effect<void, never>,
    )

    // Two topics → two distinct threads (not one shared group thread).
    expect(getCreateCount()).toBe(2)
  })
})
