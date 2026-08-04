/**
 * Discord adapter tests.
 *
 * The point of this suite is the ALLOWLIST. The bot fronts an agent with an
 * unrestricted local shell, so "a stranger's message never reaches the
 * handler" is a security property, not a nicety. The `DiscordTransport` seam
 * exists precisely so that property can be asserted without a live gateway.
 *
 * Also covered: fail-closed construction, the stream-edit message-id
 * lifecycle, 429 retry-after handling, and the cross-transport guard.
 */
import { describe, expect, it } from "vitest"
import { Duration, Effect, Fiber, Redacted } from "effect"
import {
  makeDiscordAdapter,
  parseDiscord429RetryMs,
  stripExpandableQuoteMarker,
} from "../src/adapters/discord.js"
import type { DiscordTransport, InboundDiscordMessage } from "../src/adapters/discord.js"
import type { ChannelMessage, DeliveryTarget } from "../src/types.js"

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

interface SendRecord {
  readonly channelId: string
  readonly content: string
}
interface EditRecord {
  readonly channelId: string
  readonly messageId: string
  readonly content: string
}

/** A fake DiscordTransport that records outbound calls and can fire inbound. */
const makeFakeTransport = (opts?: {
  readonly sendImpl?: (channelId: string, content: string, attempt: number) => Promise<{ id: string }>
  readonly editImpl?: (channelId: string, messageId: string, content: string, attempt: number) => Promise<void>
}) => {
  let msgCb: ((m: InboundDiscordMessage) => void) | null = null
  const sent: SendRecord[] = []
  const edits: EditRecord[] = []
  let idCounter = 0
  let sendAttempts = 0
  let editAttempts = 0

  const transport: DiscordTransport = {
    onMessage: (cb) => {
      msgCb = cb
    },
    onReady: () => {},
    onError: () => {},
    login: async () => {},
    destroy: async () => {},
    send: async (channelId, content) => {
      sendAttempts++
      if (opts?.sendImpl !== undefined) {
        const r = await opts.sendImpl(channelId, content, sendAttempts)
        sent.push({ channelId, content })
        return r
      }
      sent.push({ channelId, content })
      idCounter++
      return { id: `msg-${idCounter}` }
    },
    edit: async (channelId, messageId, content) => {
      editAttempts++
      if (opts?.editImpl !== undefined) {
        await opts.editImpl(channelId, messageId, content, editAttempts)
      }
      edits.push({ channelId, messageId, content })
    },
  }

  return {
    transport,
    fire: (m: InboundDiscordMessage) => msgCb?.(m),
    isWired: () => msgCb !== null,
    sent,
    edits,
    attempts: () => ({ send: sendAttempts, edit: editAttempts }),
  }
}

const inbound = (o: Partial<InboundDiscordMessage> = {}): InboundDiscordMessage => ({
  id: "100",
  channelId: "chan-1",
  authorId: "user-allowed",
  authorBot: false,
  system: false,
  content: "hello",
  guildId: "guild-1",
  isThread: false,
  isDM: false,
  createdAt: "2026-08-04T00:00:00.000Z",
  ...o,
})

const channelMessage = (o: Partial<ChannelMessage> = {}): ChannelMessage => ({
  transport: "discord",
  channelId: "chan-1",
  senderId: "user-allowed",
  text: "hi",
  platformMessageId: "100",
  ts: "2026-08-04T00:00:00.000Z",
  ...o,
})

const target = (o: Partial<ChannelMessage> = {}): DeliveryTarget => {
  const msg = channelMessage(o)
  return {
    inReplyTo: msg,
    address: { channelId: msg.channelId, senderId: msg.senderId, transport: msg.transport },
  }
}

const PARTIAL = { isPartial: true, isFinal: false, chunkIndex: 0, totalChunks: 1 }
const FINAL = { isPartial: false, isFinal: true, chunkIndex: 0, totalChunks: 1 }

/**
 * Run `body` with the adapter started (inbound handlers wired), then interrupt.
 * start() parks on Effect.never, so it must be forked and torn down.
 */
const withStarted = async (
  adapter: ReturnType<typeof makeDiscordAdapter>,
  body: () => void | Promise<void>,
): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(Effect.scoped(adapter.start()))
      // Let start() wire the transport callbacks before firing anything.
      yield* Effect.sleep(Duration.millis(20))
      yield* Effect.promise(async () => {
        await body()
      })
      // Inbound dispatch is Effect.runFork; give it a tick to land.
      yield* Effect.sleep(Duration.millis(20))
      yield* Fiber.interrupt(fiber)
    }),
  )
}

/* -------------------------------------------------------------------------- */
/* Fail-closed construction                                                    */
/* -------------------------------------------------------------------------- */

describe("fail-closed construction", () => {
  it("THROWS when allowedUsers is empty (no fail-open default)", () => {
    const fake = makeFakeTransport()
    expect(() =>
      makeDiscordAdapter({ id: "d", transport: fake.transport, allowedUsers: [] }),
    ).toThrow(/allowedUsers is empty/)
  })

  it("throws on an empty iterable from a mis-parsed env var (the realistic typo)", () => {
    const fake = makeFakeTransport()
    // "".split(",").filter(s => s.length > 0) === []
    const parsed = "".split(",").filter((s) => s.trim().length > 0)
    expect(() =>
      makeDiscordAdapter({ id: "d", transport: fake.transport, allowedUsers: parsed }),
    ).toThrow(/allowedUsers is empty/)
  })

  it("constructs with at least one allowed user", () => {
    const fake = makeFakeTransport()
    const a = makeDiscordAdapter({ id: "d", transport: fake.transport, allowedUsers: ["u1"] })
    expect(a.id).toBe("d")
    expect(a.transport).toBe("discord")
    expect(a.capability).toBe("stream-edit")
    expect(a.maxMessageLength).toBe(2000)
  })
})

/* -------------------------------------------------------------------------- */
/* The allowlist                                                               */
/* -------------------------------------------------------------------------- */

describe("inbound allowlist", () => {
  const setup = (cfg: { allowedUsers: string[]; allowedChannels?: string[] }) => {
    const fake = makeFakeTransport()
    const received: ChannelMessage[] = []
    const adapter = makeDiscordAdapter({
      id: "d",
      transport: fake.transport,
      logLogin: false,
      allowedUsers: cfg.allowedUsers,
      ...(cfg.allowedChannels !== undefined ? { allowedChannels: cfg.allowedChannels } : {}),
    })
    adapter.setMessageHandler((m) =>
      Effect.sync(() => {
        received.push(m)
      }),
    )
    return { fake, adapter, received }
  }

  it("accepts a message from an allowed user", async () => {
    const { fake, adapter, received } = setup({ allowedUsers: ["user-allowed"] })
    await withStarted(adapter, () => {
      fake.fire(inbound({ authorId: "user-allowed", content: "ping" }))
    })
    expect(received).toHaveLength(1)
    expect(received[0]?.text).toBe("ping")
    expect(received[0]?.transport).toBe("discord")
    expect(received[0]?.platformMessageId).toBe("100")
  })

  it("DROPS a message from a non-allowlisted user — never reaches the handler", async () => {
    const { fake, adapter, received } = setup({ allowedUsers: ["user-allowed"] })
    await withStarted(adapter, () => {
      fake.fire(inbound({ authorId: "attacker", content: "rm -rf /" }))
    })
    expect(received).toHaveLength(0)
  })

  it("uses AND semantics: an allowed user in a NON-allowed channel is dropped", async () => {
    // This is the deliberate divergence from telegram.ts's sender-OR-chat
    // union. Under OR this message would be accepted.
    const { fake, adapter, received } = setup({
      allowedUsers: ["user-allowed"],
      allowedChannels: ["chan-ok"],
    })
    await withStarted(adapter, () => {
      fake.fire(inbound({ authorId: "user-allowed", channelId: "chan-elsewhere" }))
    })
    expect(received).toHaveLength(0)
  })

  it("uses AND semantics: a NON-allowed user in an allowed channel is dropped", async () => {
    // The security-critical direction: listing a channel must NOT authorize
    // every member of that channel.
    const { fake, adapter, received } = setup({
      allowedUsers: ["user-allowed"],
      allowedChannels: ["chan-ok"],
    })
    await withStarted(adapter, () => {
      fake.fire(inbound({ authorId: "attacker", channelId: "chan-ok" }))
    })
    expect(received).toHaveLength(0)
  })

  it("accepts only when BOTH user and channel are allowed", async () => {
    const { fake, adapter, received } = setup({
      allowedUsers: ["user-allowed"],
      allowedChannels: ["chan-ok"],
    })
    await withStarted(adapter, () => {
      fake.fire(inbound({ authorId: "user-allowed", channelId: "chan-ok" }))
    })
    expect(received).toHaveLength(1)
  })

  it("lets a thread inherit its parent channel's grant", async () => {
    const { fake, adapter, received } = setup({
      allowedUsers: ["user-allowed"],
      allowedChannels: ["chan-ok"],
    })
    await withStarted(adapter, () => {
      fake.fire(
        inbound({
          authorId: "user-allowed",
          channelId: "thread-99",
          isThread: true,
          parentId: "chan-ok",
        }),
      )
    })
    expect(received).toHaveLength(1)
    // The thread's own id is the threading key, so two threads under one
    // parent map to two Luna threads.
    expect(received[0]?.threadingKey).toBe("thread-99")
  })

  it("does NOT let a thread under a non-allowed parent through", async () => {
    const { fake, adapter, received } = setup({
      allowedUsers: ["user-allowed"],
      allowedChannels: ["chan-ok"],
    })
    await withStarted(adapter, () => {
      fake.fire(
        inbound({ authorId: "user-allowed", channelId: "thread-99", isThread: true, parentId: "chan-bad" }),
      )
    })
    expect(received).toHaveLength(0)
  })

  it("ignores bot authors even when the id is allowlisted (no self-loop)", async () => {
    const { fake, adapter, received } = setup({ allowedUsers: ["user-allowed"] })
    await withStarted(adapter, () => {
      fake.fire(inbound({ authorId: "user-allowed", authorBot: true }))
    })
    expect(received).toHaveLength(0)
  })

  it("ignores system messages (joins, pins, boosts)", async () => {
    const { fake, adapter, received } = setup({ allowedUsers: ["user-allowed"] })
    await withStarted(adapter, () => {
      fake.fire(inbound({ authorId: "user-allowed", system: true }))
    })
    expect(received).toHaveLength(0)
  })

  it("empty allowedChannels means any channel, still gated by user", async () => {
    const { fake, adapter, received } = setup({ allowedUsers: ["user-allowed"] })
    await withStarted(adapter, () => {
      fake.fire(inbound({ authorId: "user-allowed", channelId: "anywhere" }))
      fake.fire(inbound({ authorId: "attacker", channelId: "anywhere", id: "101" }))
    })
    expect(received).toHaveLength(1)
    expect(received[0]?.senderId).toBe("user-allowed")
  })
})

/* -------------------------------------------------------------------------- */
/* deliver(): stream-edit lifecycle                                            */
/* -------------------------------------------------------------------------- */

describe("deliver — stream-edit lifecycle", () => {
  const mk = () => {
    const fake = makeFakeTransport()
    const adapter = makeDiscordAdapter({
      id: "d",
      transport: fake.transport,
      logLogin: false,
      allowedUsers: ["user-allowed"],
    })
    return { fake, adapter }
  }

  it("first partial sends a new message; the next partial EDITS it", async () => {
    const { fake, adapter } = mk()
    await Effect.runPromise(adapter.deliver(target(), "thinking…", PARTIAL))
    await Effect.runPromise(adapter.deliver(target(), "thinking… more", PARTIAL))

    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0]?.content).toBe("thinking…")
    expect(fake.edits).toHaveLength(1)
    expect(fake.edits[0]?.messageId).toBe("msg-1")
    expect(fake.edits[0]?.content).toBe("thinking… more")
  })

  it("clears the edit map on final, so the next turn sends fresh", async () => {
    const { fake, adapter } = mk()
    await Effect.runPromise(adapter.deliver(target(), "partial", PARTIAL))
    await Effect.runPromise(adapter.deliver(target(), "done", FINAL))
    // Same turn key again — must NOT edit the old message.
    await Effect.runPromise(adapter.deliver(target(), "next turn", PARTIAL))

    expect(fake.sent.map((s) => s.content)).toEqual(["partial", "next turn"])
    expect(fake.edits.map((e) => e.content)).toEqual(["done"])
  })

  it("keys edit routing per turn, so two concurrent turns don't cross", async () => {
    const { fake, adapter } = mk()
    await Effect.runPromise(adapter.deliver(target({ platformMessageId: "A" }), "a1", PARTIAL))
    await Effect.runPromise(adapter.deliver(target({ platformMessageId: "B" }), "b1", PARTIAL))
    await Effect.runPromise(adapter.deliver(target({ platformMessageId: "A" }), "a2", PARTIAL))

    expect(fake.sent).toHaveLength(2)
    expect(fake.edits).toHaveLength(1)
    // Turn A must edit A's message (msg-1), not B's (msg-2).
    expect(fake.edits[0]?.messageId).toBe("msg-1")
  })

  it("sends continuation chunks as fresh messages, never as edits", async () => {
    const { fake, adapter } = mk()
    await Effect.runPromise(adapter.deliver(target(), "part 1", PARTIAL))
    await Effect.runPromise(
      adapter.deliver(target(), "part 2", { ...FINAL, chunkIndex: 1, totalChunks: 2 }),
    )
    expect(fake.sent.map((s) => s.content)).toEqual(["part 1", "part 2"])
    expect(fake.edits).toHaveLength(0)
  })

  it("standalone deliveries never disturb a live turn's edit map", async () => {
    const { fake, adapter } = mk()
    await Effect.runPromise(adapter.deliver(target(), "live partial", PARTIAL))
    await Effect.runPromise(
      adapter.deliver(target(), "job output", { ...FINAL, standalone: true }),
    )
    // The live turn must still edit its own placeholder.
    await Effect.runPromise(adapter.deliver(target(), "live final", FINAL))

    expect(fake.sent.map((s) => s.content)).toEqual(["live partial", "job output"])
    expect(fake.edits).toHaveLength(1)
    expect(fake.edits[0]?.messageId).toBe("msg-1")
    expect(fake.edits[0]?.content).toBe("live final")
  })

  it("is a no-op for a foreign transport (cross-transport guard)", async () => {
    const { fake, adapter } = mk()
    await Effect.runPromise(
      adapter.deliver(target({ transport: "telegram" }), "wrong platform", FINAL),
    )
    expect(fake.sent).toHaveLength(0)
    expect(fake.edits).toHaveLength(0)
  })

  it("is a no-op when the address carries no channelId", async () => {
    const { fake, adapter } = mk()
    const t: DeliveryTarget = { inReplyTo: channelMessage(), address: {} }
    await Effect.runPromise(adapter.deliver(t, "nowhere to send", FINAL))
    expect(fake.sent).toHaveLength(0)
  })

  it("skips empty content rather than posting a blank message", async () => {
    const { fake, adapter } = mk()
    await Effect.runPromise(adapter.deliver(target(), "", FINAL))
    expect(fake.sent).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* 429 handling                                                                */
/* -------------------------------------------------------------------------- */

describe("rate limiting (429)", () => {
  it("parses retry_after seconds into ms", () => {
    expect(parseDiscord429RetryMs({ code: 429, retry_after: 1.5 })).toBe(1500)
    expect(parseDiscord429RetryMs({ status: 429, retry_after: "2" })).toBe(2000)
    expect(parseDiscord429RetryMs({ httpStatus: 429, retryAfter: 0.25 })).toBe(250)
  })

  it("returns null for non-rate-limit errors", () => {
    expect(parseDiscord429RetryMs({ code: 500 })).toBeNull()
    expect(parseDiscord429RetryMs(new Error("boom"))).toBeNull()
    expect(parseDiscord429RetryMs(null)).toBeNull()
    expect(parseDiscord429RetryMs("nope")).toBeNull()
  })

  it("caps a hostile retry_after so a fiber cannot be parked indefinitely", () => {
    expect(parseDiscord429RetryMs({ code: 429, retry_after: 999_999 })).toBe(60_000)
  })

  it("retries a send after a 429 and succeeds", async () => {
    const fake = makeFakeTransport({
      sendImpl: async (_c, _content, attempt) => {
        if (attempt === 1) {
          throw { code: 429, retry_after: 0.01 }
        }
        return { id: "msg-after-retry" }
      },
    })
    const adapter = makeDiscordAdapter({
      id: "d",
      transport: fake.transport,
      logLogin: false,
      allowedUsers: ["user-allowed"],
    })
    await Effect.runPromise(adapter.deliver(target(), "rate limited", PARTIAL))
    expect(fake.attempts().send).toBe(2)
    expect(fake.sent).toHaveLength(1)
  })

  it("gives up after the attempt ceiling instead of retrying forever", async () => {
    const fake = makeFakeTransport({
      sendImpl: async () => {
        throw { code: 429, retry_after: 0.01 }
      },
    })
    const adapter = makeDiscordAdapter({
      id: "d",
      transport: fake.transport,
      logLogin: false,
      allowedUsers: ["user-allowed"],
    })
    await Effect.runPromise(adapter.deliver(target(), "always limited", PARTIAL))
    expect(fake.attempts().send).toBe(3)
    expect(fake.sent).toHaveLength(0)
  })

  it("does not retry a non-429 failure", async () => {
    const fake = makeFakeTransport({
      sendImpl: async () => {
        throw new Error("Missing Permissions")
      },
    })
    const adapter = makeDiscordAdapter({
      id: "d",
      transport: fake.transport,
      logLogin: false,
      allowedUsers: ["user-allowed"],
    })
    await Effect.runPromise(adapter.deliver(target(), "no perms", PARTIAL))
    expect(fake.attempts().send).toBe(1)
  })

  it("swallows a benign edit failure without leaving the turn broken", async () => {
    const fake = makeFakeTransport({
      editImpl: async () => {
        throw new Error("Unknown Message")
      },
    })
    const adapter = makeDiscordAdapter({
      id: "d",
      transport: fake.transport,
      logLogin: false,
      allowedUsers: ["user-allowed"],
    })
    await Effect.runPromise(adapter.deliver(target(), "first", PARTIAL))
    // The user deleted the placeholder; the edit must not throw.
    await expect(
      Effect.runPromise(adapter.deliver(target(), "second", FINAL)),
    ).resolves.toBeUndefined()
    expect(fake.attempts().edit).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

describe("expandable-quote marker", () => {
  it("degrades the internal '>! ' convention to a plain Discord blockquote", () => {
    expect(stripExpandableQuoteMarker(">! step one\n>! step two")).toBe("> step one\n> step two")
  })

  it("leaves normal blockquotes and body text alone", () => {
    expect(stripExpandableQuoteMarker("> quoted\nplain")).toBe("> quoted\nplain")
  })

  it("is applied on the delivery path so '>!' never reaches Discord literally", async () => {
    const fake = makeFakeTransport()
    const adapter = makeDiscordAdapter({
      id: "d",
      transport: fake.transport,
      logLogin: false,
      allowedUsers: ["user-allowed"],
    })
    await Effect.runPromise(adapter.deliver(target(), ">! Worked for 3 steps", FINAL))
    expect(fake.sent[0]?.content).toBe("> Worked for 3 steps")
  })
})

/* -------------------------------------------------------------------------- */
/* Token handling                                                              */
/* -------------------------------------------------------------------------- */

describe("token handling", () => {
  it("accepts a Redacted token without exposing it in the adapter surface", () => {
    const adapter = makeDiscordAdapter({
      id: "d",
      token: Redacted.make("super-secret-token"),
      allowedUsers: ["u1"],
    })
    // A Redacted stringifies to a mask, so an accidental log/serialization of
    // the config cannot leak the value.
    expect(JSON.stringify(adapter)).not.toContain("super-secret-token")
    expect(String(Redacted.make("super-secret-token"))).not.toContain("super-secret-token")
  })
})
