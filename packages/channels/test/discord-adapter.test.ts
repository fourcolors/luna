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
import { describe, expect, it, vi } from "vitest"
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
/** Slice 1: one record per sendTyping ATTEMPT, including rejected ones. */
interface TypingRecord {
  readonly channelId: string
}

/** A fake DiscordTransport that records outbound calls and can fire inbound. */
const makeFakeTransport = (opts?: {
  readonly sendImpl?: (channelId: string, content: string, attempt: number) => Promise<{ id: string }>
  readonly editImpl?: (channelId: string, messageId: string, content: string, attempt: number) => Promise<void>
  /**
   * Slice 1. Invoked for EVERY sendTyping attempt; throw/reject to make the
   * transport fail. `attempt` is the adapter-wide attempt index;
   * `attemptForChannel` is the per-channel one, because the failure breaker is
   * keyed per CHANNEL (Discord 50001/50013 are channel-scoped permissions).
   */
  readonly typingImpl?: (
    channelId: string,
    attempt: number,
    attemptForChannel: number,
  ) => Promise<void>
}) => {
  let msgCb: ((m: InboundDiscordMessage) => void) | null = null
  const sent: SendRecord[] = []
  const edits: EditRecord[] = []
  const typingCalls: TypingRecord[] = []
  let idCounter = 0
  let sendAttempts = 0
  let editAttempts = 0
  let typingAttempts = 0
  const typingAttemptsByChannel = new Map<string, number>()

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
    // SLICE 1 — RED BY DESIGN. `DiscordTransport` does not declare `sendTyping`
    // yet, so `bun run typecheck` reports this as an excess property. That
    // compile error IS part of the spec: it is the proof that the 8th member is
    // missing, and it disappears the moment the member is added. See the
    // "SLICE 1" block at the bottom of this file.
    sendTyping: async (channelId: string) => {
      typingAttempts++
      const n = (typingAttemptsByChannel.get(channelId) ?? 0) + 1
      typingAttemptsByChannel.set(channelId, n)
      // Recorded BEFORE the impl runs, unlike `sent`/`edits`: a REJECTED
      // attempt still counts, both for the breaker arithmetic and for the
      // "zero calls for a stranger" security rail.
      typingCalls.push({ channelId })
      if (opts?.typingImpl !== undefined) {
        await opts.typingImpl(channelId, typingAttempts, n)
      }
    },
  }

  return {
    transport,
    fire: (m: InboundDiscordMessage) => msgCb?.(m),
    isWired: () => msgCb !== null,
    sent,
    edits,
    typingCalls,
    typingFor: (channelId: string) => typingCalls.filter((t) => t.channelId === channelId).length,
    attempts: () => ({ send: sendAttempts, edit: editAttempts, typing: typingAttempts }),
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
    // 1900, not 2000: the budget sits below Discord's platform limit so fence
    // repair overhead can never cross it (Slice 2c, ported from Sol Agent).
    expect(a.maxMessageLength).toBe(1900)
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

/* ========================================================================== */
/* SLICE 1 — typing indicator + per-CHANNEL failure breaker                    */
/* ========================================================================== */

/**
 * EXECUTABLE SPEC (written before the implementation; RED on arrival).
 *
 * WHY TYPING IS A SECURITY-SENSITIVE FEATURE HERE
 * -----------------------------------------------
 * This bot fronts an agent with an unrestricted local shell, and today the
 * adapter has NO pre-gate observable side effect at all — unlike telegram.ts,
 * it posts no read-receipt reaction. A typing indicator would therefore be the
 * FIRST user-visible signal the adapter can emit, and it is visible to the
 * SENDER. Started before `isInboundAllowed`, it becomes an "is the bot
 * listening to me?" oracle for a stranger probing the shell's front door.
 * `starts strictly AFTER the allowlist gate` below is the hardest rail in this
 * block, and it is written so that it FAILS if typing is merely *present* but
 * started in the wrong place — presence alone is not the property under test.
 *
 * OUT OF SCOPE — this scenario must NOT modify any of:
 *   - packages/channels/src/service.ts              (Slice 0 owns it)
 *   - packages/channels/src/delivery.ts             (Slice 2: fence repair)
 *   - packages/channels/src/adapters/telegram.ts    (precedent only, read-only)
 *   - packages/channels/test/channels.test.ts       (esp. the Slice 0 rail)
 *   - packages/channels/test/telegram-adapter.test.ts
 *   - anything for slash commands (Slice 3), attachments (Slice 4) or reply
 *     quotes (Slice 5)
 * The only production file this scenario may touch is
 * packages/channels/src/adapters/discord.ts.
 *
 * TWO NEW SEAMS THIS BLOCK REQUIRES (both minimal, both mirror seams that
 * already exist in this file):
 *   1. `DiscordTransport.sendTyping(channelId: string): Promise<void>` — a
 *      REQUIRED 8th member (an optional one would silently no-op in prod).
 *   2. `DiscordAdapterConfig.typingRefreshMs?: number` — an optional refresh
 *      override that defaults to the production interval. This exists for the
 *      same reason `config.transport` does: without it the refresh cap
 *      (~15 refreshes x ~8s = ~2 min) is not observable in a test, and
 *      "the loop is bounded" is precisely the property that stops a
 *      never-delivered turn from typing forever. Exactly ONE test below runs
 *      on the real default interval, and it pins the property that actually
 *      matters in production: the default cadence beats Discord's ~10s expiry.
 *
 * THE CAP MUST BE A REFRESH COUNT, not a wall-clock duration — mirroring
 * telegram.ts's TYPING_MAX_REFRESHES — otherwise the override above cannot
 * make it observable.
 *
 * Timing style follows the house pattern in telegram-adapter.test.ts (real
 * short sleeps + an extended per-test timeout, e.g. its 4.5s refresh test at
 * `stops the typing indicator it started when the download fails`). Effect's
 * TestClock is deliberately NOT used: the typing loop is a `runFork` ROOT (it
 * must be — a child of the handler fiber is auto-interrupted before the first
 * delivery lands), and a root fiber runs on the default runtime where a
 * TestClock provided to the test effect has no reach.
 *
 * EXACTLY ONE TEST BELOW IS GREEN-ON-ARRIVAL BY DESIGN and is labelled inline:
 * "SECURITY: a NON-ALLOWED inbound produces ZERO sendTyping calls". A pure
 * negative cannot fail on an adapter that has no typing at all. It is paired
 * with a discriminating partner that IS red — the very next test, which pins
 * PLACEMENT rather than presence. Measured at handoff: 15 red / 1 by-design
 * guard, out of 16. If a second test in this block is ever green before the
 * implementation lands, that is a broken test, not a second exception.
 */

/** Sleep, in the file's Effect idiom. */
const tick = (ms: number): Promise<void> => Effect.runPromise(Effect.sleep(Duration.millis(ms)))

/** Discord clears "is typing…" ~10s after the last trigger. */
const DISCORD_TYPING_EXPIRY_MS = 10_000
/** Long enough for a second refresh to have landed at the DEFAULT cadence. */
const PAST_ONE_DEFAULT_REFRESH_MS = DISCORD_TYPING_EXPIRY_MS - 500
/** Far enough above any test window that no refresh perturbs breaker counting. */
const NO_REFRESH_MS = 60_000

const setupTyping = (o?: {
  readonly allowedUsers?: string[]
  readonly allowedChannels?: string[]
  /** Omit to exercise the real production cadence. */
  readonly refreshMs?: number
  readonly typingImpl?: (
    channelId: string,
    attempt: number,
    attemptForChannel: number,
  ) => Promise<void>
  /** false → never call setMessageHandler (the C5 "nothing will dispatch" case). */
  readonly installHandler?: boolean
  /** true → the handler replies via deliver(), i.e. a real end-to-end turn. */
  readonly replyFromHandler?: boolean
}) => {
  const fake = makeFakeTransport(
    o?.typingImpl !== undefined ? { typingImpl: o.typingImpl } : {},
  )
  const adapter = makeDiscordAdapter({
    id: "d-typing",
    transport: fake.transport,
    logLogin: false,
    allowedUsers: o?.allowedUsers ?? ["user-allowed"],
    ...(o?.allowedChannels !== undefined ? { allowedChannels: o.allowedChannels } : {}),
    // SLICE 1 — RED BY DESIGN: `typingRefreshMs` is not on DiscordAdapterConfig
    // yet, so tsc reports an excess property here until it is added.
    ...(o?.refreshMs !== undefined ? { typingRefreshMs: o.refreshMs } : {}),
  })

  const received: ChannelMessage[] = []
  let release: () => void = () => {}
  const held = new Promise<void>((r) => {
    release = r
  })

  const install = () => {
    adapter.setMessageHandler((m) =>
      Effect.gen(function* () {
        received.push(m)
        if (o?.replyFromHandler === true) {
          yield* adapter.deliver(
            {
              inReplyTo: m,
              address: { channelId: m.channelId, senderId: m.senderId, transport: m.transport },
            },
            "the answer",
            FINAL,
          )
          return
        }
        // Hold the turn open: no delivery has happened, so the indicator must
        // still be refreshing. Released in each test's finally.
        yield* Effect.promise(() => held)
      }),
    )
  }
  if (o?.installHandler !== false) install()

  return { fake, adapter, received, release, install }
}

/** Every test tears down the same way: release held turns, sweep the adapter. */
const teardown = async (s: ReturnType<typeof setupTyping>): Promise<void> => {
  s.release()
  await Effect.runPromise(s.adapter.stop())
}

describe("Slice 1 — typing indicator: the allowlist gate", () => {
  it("SECURITY: a NON-ALLOWED inbound produces ZERO sendTyping calls", async () => {
    // GREEN ON ARRIVAL BY DESIGN — a pure negative cannot fail on an adapter
    // with no typing at all. It is kept standalone because it is the single
    // assertion an auditor checks first and the one most likely to regress
    // later. Its RED partner is the next test, which pins PLACEMENT.
    const s = setupTyping({ allowedUsers: ["user-allowed"] })
    try {
      await withStarted(s.adapter, async () => {
        s.fake.fire(inbound({ authorId: "attacker", content: "are you there?" }))
        await tick(60)
      })
      expect(s.fake.attempts().typing).toBe(0)
      expect(s.fake.typingCalls).toHaveLength(0)
      // Anti-vacuity for the *gate*: the message really was rejected.
      expect(s.received).toHaveLength(0)
    } finally {
      await teardown(s)
    }
  })

  it("SECURITY: typing starts strictly AFTER the allowlist gate, never before it", async () => {
    // THE placement rail. An implementation that starts typing at the top of
    // handleInbound — before `isInboundAllowed` — passes the pure-negative test
    // above only by accident; it fails HERE, on `typingAfterStrangers`.
    const s = setupTyping({
      allowedUsers: ["user-allowed"],
      allowedChannels: ["chan-ok"],
    })
    let typingAfterStrangers = -1
    try {
      await withStarted(s.adapter, async () => {
        // Every way to be non-allowed, incl. both halves of the AND gate.
        s.fake.fire(inbound({ id: "201", authorId: "attacker", channelId: "chan-ok" }))
        s.fake.fire(inbound({ id: "202", authorId: "user-allowed", channelId: "chan-elsewhere" }))
        s.fake.fire(inbound({ id: "203", authorId: "attacker", channelId: "chan-evil" }))
        s.fake.fire(inbound({ id: "204", authorId: "user-allowed", authorBot: true, channelId: "chan-ok" }))
        await tick(60)
        typingAfterStrangers = s.fake.attempts().typing
        // Only now does a legitimate message arrive.
        s.fake.fire(inbound({ id: "205", authorId: "user-allowed", channelId: "chan-ok" }))
        await tick(60)
      })
      expect(typingAfterStrangers).toBe(0)
      expect(s.fake.attempts().typing).toBeGreaterThanOrEqual(1)
      // and never for a channel the gate rejected
      expect(s.fake.typingCalls.every((t) => t.channelId === "chan-ok")).toBe(true)
    } finally {
      await teardown(s)
    }
  })

  it("does not type when no message handler is installed (nothing would dispatch)", async () => {
    // The gate is not the only precondition: typing must start AFTER the
    // `messageHandler === null` check too, or the bot claims to be working on a
    // message that nothing will ever process.
    const s = setupTyping({ installHandler: false })
    let typingWithNoHandler = -1
    try {
      await withStarted(s.adapter, async () => {
        s.fake.fire(inbound({ id: "210", authorId: "user-allowed" }))
        await tick(60)
        typingWithNoHandler = s.fake.attempts().typing
        // Same adapter, same message shape — now a handler exists.
        s.install()
        s.fake.fire(inbound({ id: "211", authorId: "user-allowed" }))
        await tick(60)
      })
      expect(typingWithNoHandler).toBe(0)
      expect(s.fake.attempts().typing).toBeGreaterThanOrEqual(1)
    } finally {
      await teardown(s)
    }
  })

  it("starts typing in the inbound's own channel for an accepted message", async () => {
    const s = setupTyping({ allowedUsers: ["user-allowed"] })
    try {
      await withStarted(s.adapter, async () => {
        s.fake.fire(inbound({ id: "220", authorId: "user-allowed", channelId: "chan-1" }))
        await tick(60)
      })
      expect(s.received).toHaveLength(1)
      expect(s.fake.attempts().typing).toBeGreaterThanOrEqual(1)
      expect(s.fake.typingCalls[0]?.channelId).toBe("chan-1")
    } finally {
      await teardown(s)
    }
  })
})

describe("Slice 1 — typing indicator: refresh, cap and stop", () => {
  it("refreshes on a cadence that beats Discord's ~10s expiry (real DEFAULT interval)", async () => {
    // The ONE test that runs without the refresh override, so the production
    // default is pinned by behaviour rather than by a constant: whatever the
    // interval is, a second trigger must land before the indicator lapses.
    const s = setupTyping({ allowedUsers: ["user-allowed"] })
    try {
      await withStarted(s.adapter, async () => {
        s.fake.fire(inbound({ id: "230", authorId: "user-allowed" }))
        await tick(PAST_ONE_DEFAULT_REFRESH_MS)
      })
      expect(s.fake.attempts().typing).toBeGreaterThanOrEqual(2)
    } finally {
      await teardown(s)
    }
  }, 40_000)

  it("caps the refresh loop, so a turn that never delivers cannot type forever", async () => {
    // A turn with NO delivery is normal, not exotic: service-level dedup drops
    // a gateway-resume redelivery AFTER this adapter's gate has already run,
    // chat.send can return none, and the breaker only counts FAILURES — so a
    // successful-but-never-stopped loop is bounded by nothing else.
    const s = setupTyping({ allowedUsers: ["user-allowed"], refreshMs: 30 })
    let atCap = -1
    let wellAfterCap = -1
    try {
      await withStarted(s.adapter, async () => {
        s.fake.fire(inbound({ id: "240", authorId: "user-allowed" }))
        await tick(900)
        atCap = s.fake.attempts().typing
        await tick(1000)
        wellAfterCap = s.fake.attempts().typing
      })
      // Bounded…
      expect(wellAfterCap).toBe(atCap)
      // …and bounded at a sane place: ~15 refreshes of cover, not 2 and not 500.
      expect(atCap).toBeGreaterThanOrEqual(10)
      expect(atCap).toBeLessThanOrEqual(31)
    } finally {
      await teardown(s)
    }
  }, 30_000)

  it("stops the loop as soon as the first deliver() for that channel lands", async () => {
    const s = setupTyping({ allowedUsers: ["user-allowed"], refreshMs: 40 })
    let atDeliver = -1
    let afterDeliver = -1
    let muchLater = -1
    try {
      await withStarted(s.adapter, async () => {
        s.fake.fire(inbound({ id: "250", authorId: "user-allowed" }))
        await tick(120)
        atDeliver = s.fake.attempts().typing
        await Effect.runPromise(
          s.adapter.deliver(target({ platformMessageId: "250" }), "on it", PARTIAL),
        )
        afterDeliver = s.fake.attempts().typing
        await tick(400)
        muchLater = s.fake.attempts().typing
      })
      expect(atDeliver).toBeGreaterThanOrEqual(1)
      expect(muchLater).toBe(afterDeliver)
    } finally {
      await teardown(s)
    }
  }, 20_000)

  it("stops the loop even when the delivered content is EMPTY (stop precedes the empty-text return)", async () => {
    // Placement inside deliver(): the stop must sit above the `text.length === 0`
    // early return, or an empty first chunk leaves the indicator spinning.
    const s = setupTyping({ allowedUsers: ["user-allowed"], refreshMs: 40 })
    let atDeliver = -1
    let afterDeliver = -1
    let muchLater = -1
    try {
      await withStarted(s.adapter, async () => {
        s.fake.fire(inbound({ id: "260", authorId: "user-allowed" }))
        await tick(120)
        atDeliver = s.fake.attempts().typing
        await Effect.runPromise(s.adapter.deliver(target({ platformMessageId: "260" }), "", FINAL))
        afterDeliver = s.fake.attempts().typing
        await tick(400)
        muchLater = s.fake.attempts().typing
      })
      expect(atDeliver).toBeGreaterThanOrEqual(1)
      expect(muchLater).toBe(afterDeliver)
      // The empty-text return still applies: nothing was posted.
      expect(s.fake.sent).toHaveLength(0)
    } finally {
      await teardown(s)
    }
  }, 20_000)

  it("does NOT stop the loop for a FOREIGN-transport deliver (stop follows the transport guard)", async () => {
    // The other half of the placement pin: a Telegram-addressed delivery that
    // this adapter refuses must not silently clear a live Discord indicator.
    const s = setupTyping({ allowedUsers: ["user-allowed"], refreshMs: 40 })
    let beforeForeign = -1
    let afterForeign = -1
    try {
      await withStarted(s.adapter, async () => {
        s.fake.fire(inbound({ id: "270", authorId: "user-allowed" }))
        await tick(120)
        beforeForeign = s.fake.attempts().typing
        await Effect.runPromise(
          s.adapter.deliver(
            target({ platformMessageId: "270", transport: "telegram" }),
            "wrong platform",
            FINAL,
          ),
        )
        await tick(400)
        afterForeign = s.fake.attempts().typing
      })
      expect(beforeForeign).toBeGreaterThanOrEqual(1)
      expect(afterForeign).toBeGreaterThan(beforeForeign)
    } finally {
      await teardown(s)
    }
  }, 20_000)

  it("stop() sweeps a live typing fiber", async () => {
    // ChannelService calls stop() AFTER the scope closes, so scope teardown
    // alone is not enough: the loop is a runFork root and outlives it.
    const s = setupTyping({ allowedUsers: ["user-allowed"], refreshMs: 40 })
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(Effect.scoped(s.adapter.start()))
          yield* Effect.sleep(Duration.millis(20))
          yield* Effect.promise(async () => {
            s.fake.fire(inbound({ id: "280", authorId: "user-allowed" }))
            await tick(120)
          })
          yield* Fiber.interrupt(fiber)
        }),
      )
      s.release()
      await Effect.runPromise(s.adapter.stop())
      const atStop = s.fake.attempts().typing
      expect(atStop).toBeGreaterThanOrEqual(1)
      await tick(400)
      expect(s.fake.attempts().typing).toBe(atStop)
    } finally {
      await teardown(s)
    }
  }, 20_000)
})

describe("Slice 1 — sendTyping failure breaker (per channel)", () => {
  /**
   * One turn = one accepted inbound, then a delivery that stops that channel's
   * loop. Starting typing is idempotent per channel, so this is the only way to
   * accumulate attempts without waiting for real refreshes: each turn
   * contributes EXACTLY ONE sendTyping attempt. The refresh override is parked
   * far beyond every window below so no refresh perturbs the arithmetic.
   */
  const runTurn = async (
    s: ReturnType<typeof setupTyping>,
    id: string,
    channelId = "chan-1",
  ): Promise<void> => {
    s.fake.fire(inbound({ id, authorId: "user-allowed", channelId }))
    await tick(40)
    await Effect.runPromise(
      s.adapter.deliver(target({ platformMessageId: id, channelId }), `reply ${id}`, FINAL),
    )
    await tick(20)
  }

  const alwaysFails = async (): Promise<void> => {
    throw new Error("Missing Access")
  }

  it("opens after 3 CONSECUTIVE failures and never attempts a 4th", async () => {
    const s = setupTyping({
      allowedUsers: ["user-allowed"],
      refreshMs: NO_REFRESH_MS,
      typingImpl: alwaysFails,
    })
    let afterThree = -1
    let afterFour = -1
    try {
      await withStarted(s.adapter, async () => {
        await runTurn(s, "401")
        await runTurn(s, "402")
        await runTurn(s, "403")
        afterThree = s.fake.attempts().typing
        await runTurn(s, "404")
        afterFour = s.fake.attempts().typing
      })
      expect(afterThree).toBe(3)
      // The breaker is permanently open: no 4th attempt, ever.
      expect(afterFour).toBe(3)
      // The turns themselves were unaffected.
      expect(s.received).toHaveLength(4)
    } finally {
      await teardown(s)
    }
  }, 20_000)

  it("is PER-CHANNEL: a broken channel A does not silence typing in channel B", async () => {
    // A missing VIEW_CHANNEL / SEND_MESSAGES grant is channel-scoped
    // (Discord 50001 / 50013). An adapter-wide breaker would let one
    // misconfigured channel kill the indicator everywhere, with one log line
    // ever — the exact debugging trap this rail exists to prevent.
    const s = setupTyping({
      allowedUsers: ["user-allowed"],
      refreshMs: NO_REFRESH_MS,
      typingImpl: async (channelId) => {
        if (channelId === "chan-a") throw new Error("Missing Access")
      },
    })
    try {
      await withStarted(s.adapter, async () => {
        await runTurn(s, "411", "chan-a")
        await runTurn(s, "412", "chan-a")
        await runTurn(s, "413", "chan-a")
        await runTurn(s, "414", "chan-a")
        await runTurn(s, "415", "chan-b")
        await runTurn(s, "416", "chan-b")
      })
      expect(s.fake.typingFor("chan-a")).toBe(3)
      expect(s.fake.typingFor("chan-b")).toBe(2)
    } finally {
      await teardown(s)
    }
  }, 20_000)

  it("logs exactly ONE warning when a channel's breaker opens", async () => {
    const s = setupTyping({
      allowedUsers: ["user-allowed"],
      refreshMs: NO_REFRESH_MS,
      typingImpl: alwaysFails,
    })
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "))
    })
    try {
      await withStarted(s.adapter, async () => {
        await runTurn(s, "421", "chan-a")
        await runTurn(s, "422", "chan-a")
        await runTurn(s, "423", "chan-a")
        await runTurn(s, "424", "chan-a")
        await runTurn(s, "425", "chan-a")
      })
    } finally {
      warnSpy.mockRestore()
      await teardown(s)
    }
    const hits = warnings.filter(
      (w) => w.includes("[discord-adapter]") && /typing/i.test(w) && w.includes("chan-a"),
    )
    // Cosmetic feature: it announces itself once, then stays quiet forever.
    expect(hits).toHaveLength(1)
  }, 20_000)

  it("a 429 neither increments NOR resets the consecutive-failure count", async () => {
    // Rate limiting is the one realistic TRANSIENT here and it self-heals, so
    // the "does not self-heal" rationale for opening the breaker does not apply
    // to it. Counting 429s would let three rate-limited refreshes permanently
    // kill typing; resetting on them would let a rate-limited channel never
    // open at all. Sequence: fail, 429, fail, fail -> the 3rd real failure is
    // attempt 4, so attempt 5 must never happen. A counting impl opens one
    // attempt early (3); a resetting impl stays closed and reaches 5.
    const s = setupTyping({
      allowedUsers: ["user-allowed"],
      refreshMs: NO_REFRESH_MS,
      typingImpl: async (_channelId, _attempt, attemptForChannel) => {
        if (attemptForChannel === 2) throw { code: 429, retry_after: 0.01 }
        throw new Error("Missing Access")
      },
    })
    try {
      await withStarted(s.adapter, async () => {
        await runTurn(s, "431")
        await runTurn(s, "432")
        await runTurn(s, "433")
        await runTurn(s, "434")
        await runTurn(s, "435")
      })
      expect(s.fake.attempts().typing).toBe(4)
    } finally {
      await teardown(s)
    }
  }, 20_000)

  it("a success RESETS the consecutive-failure count", async () => {
    // fail, fail, OK, fail, fail -> still closed (2 consecutive), so turn 6 must
    // still attempt. Without the reset the breaker opens at attempt 5 and the
    // total stops at 5. Turn 6 is that 3rd consecutive failure, so turn 7 is
    // then correctly refused — the reset must not disable the breaker.
    const s = setupTyping({
      allowedUsers: ["user-allowed"],
      refreshMs: NO_REFRESH_MS,
      typingImpl: async (_channelId, _attempt, attemptForChannel) => {
        if (attemptForChannel === 3) return
        throw new Error("Missing Access")
      },
    })
    let afterSix = -1
    try {
      await withStarted(s.adapter, async () => {
        await runTurn(s, "441")
        await runTurn(s, "442")
        await runTurn(s, "443")
        await runTurn(s, "444")
        await runTurn(s, "445")
        await runTurn(s, "446")
        afterSix = s.fake.attempts().typing
        await runTurn(s, "447")
      })
      expect(afterSix).toBe(6)
      expect(s.fake.attempts().typing).toBe(6)
    } finally {
      await teardown(s)
    }
  }, 20_000)

  it("a rejecting sendTyping never fails the turn — the reply is still delivered", async () => {
    // Cosmetic feature, non-cosmetic blast radius: a typing failure must not
    // propagate out of the inbound path or interrupt delivery.
    const s = setupTyping({
      allowedUsers: ["user-allowed"],
      refreshMs: NO_REFRESH_MS,
      typingImpl: alwaysFails,
      replyFromHandler: true,
    })
    try {
      await withStarted(s.adapter, async () => {
        s.fake.fire(inbound({ id: "450", authorId: "user-allowed" }))
        await tick(120)
      })
      // Anti-vacuity: typing really was attempted and really did fail…
      expect(s.fake.attempts().typing).toBeGreaterThanOrEqual(1)
      // …and the turn completed anyway.
      expect(s.received).toHaveLength(1)
      expect(s.fake.sent).toHaveLength(1)
      expect(s.fake.sent[0]?.content).toBe("the answer")
      expect(s.fake.sent[0]?.channelId).toBe("chan-1")
    } finally {
      await teardown(s)
    }
  }, 20_000)
})
