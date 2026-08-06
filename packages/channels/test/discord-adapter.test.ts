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
import { Buffer } from "node:buffer"
import { describe, expect, it, vi } from "vitest"
import { Duration, Effect, Fiber, Redacted } from "effect"
// SLICE 4 — the limits are REUSED from @luna/core attachment-limits.ts, never
// redefined. The implementation must import these same names (task #5 FAIL
// condition: any locally redefined limit constant is an automatic FAIL).
import {
  MAX_ATTACHMENTS_PER_TURN,
  MAX_IMAGE_RAW_BYTES,
  MAX_PDF_RAW_BYTES,
  MAX_TURN_RAW_BYTES,
} from "@luna/core"
import {
  discordCommandManifest,
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

/**
 * SLICE 3a — the inbound interaction the transport seam delivers, already
 * normalized by the wrapper (mirror of `InboundDiscordMessage`). This
 * test-local interface IS the contract for the `InboundDiscordInteraction`
 * type the implementation must export from discord.ts: same member names,
 * same types (`| undefined` explicit — exactOptionalPropertyTypes).
 */
interface FakeInboundInteraction {
  /** Interaction snowflake. Stable across gateway resume replay → dedup key. */
  readonly id: string
  readonly channelId: string
  readonly authorId: string
  /** The slash-command verb, without the leading "/". */
  readonly commandName: string
  /**
   * The interaction callback token — a ~15-minute capability to post AS THE
   * BOT. It exists here ONLY so the ack can be sent. It must never enter the
   * synthesized ChannelMessage, its metadata, or any log line.
   */
  readonly token: string
  readonly guildId?: string | undefined
  readonly isThread: boolean
  readonly parentId?: string | undefined
  readonly isDM: boolean
  /** ISO-8601. */
  readonly createdAt: string
}

/**
 * SLICE 3a — one entry per transport-method invocation, in call order.
 * The tests' handler also pushes a `"__dispatch__"` marker into the SAME
 * array, so gate/ack/dispatch ordering is a single-timeline assertion.
 */
interface TransportCallRecord {
  readonly member: string
  readonly args: ReadonlyArray<unknown>
}

/**
 * SLICE 3a — Proxy retrofit (advisor ruling 6). The previous fake
 * hand-instrumented each transport method, so any FUTURE transport member
 * (e.g. the interaction ack) would be silently EXCLUDED from every existing
 * "stranger => zero calls" security rail until someone remembered to
 * instrument it. This wrapper records EVERY method call into ONE ordered log
 * BY CONSTRUCTION — a member added tomorrow is watched the day it lands.
 */
const wrapWithCallLog = <T extends object>(obj: T, log: TransportCallRecord[]): T =>
  new Proxy(obj, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          log.push({ member: String(prop), args })
          return (value as (...a: unknown[]) => unknown)(...args)
        }
      }
      return value
    },
  })

/* -------------------------------------------------------------------------- */
/* SLICE 4 — attachment byte fixtures (magic-byte-true, tiny)                   */
/* -------------------------------------------------------------------------- */

/** Bytes whose head carries a real file-type signature, padded to `len`. */
const bytesWithMagic = (magic: ReadonlyArray<number>, len = 64): Uint8Array => {
  const b = new Uint8Array(Math.max(len, magic.length))
  b.set(magic)
  return b
}
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] // \x89PNG\r\n\x1a\n
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] // GIF89a
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-
const smallPng = (): Uint8Array => bytesWithMagic(PNG_MAGIC)

/**
 * SLICE 4 — one record per attachment download the adapter attempts through
 * the transport seam. `hasAbortSignal` is the timeout contract: the donor's
 * bare `fetch` with no timeout (census Finding 4) is exactly what Luna's spec
 * refuses to port, so every download must carry an AbortSignal.
 */
interface AttachmentFetchRecord {
  readonly url: string
  readonly hasAbortSignal: boolean
}

/**
 * SLICE 5 — the referenced (replied-to) message the transport seam resolves,
 * already normalized. This test-local interface IS the contract for the
 * `DiscordReferencedMessage` type the implementation must export from
 * discord.ts (3a/4 precedent). NOT named `Inbound*`: the invariant file's
 * bidirectional cross-check reserves that prefix for dispatch payloads.
 * `null` = the parent message no longer exists (deleted), which is ORDINARY;
 * a REJECTION is a real fetch failure (e.g. missing READ_MESSAGE_HISTORY) —
 * the donor's `.catch(() => null)` conflated the two, Luna does not.
 */
interface FakeReferencedMessage {
  readonly content: string
  readonly author: {
    readonly displayName?: string | undefined
    readonly username?: string | undefined
  } | null
}

/** SLICE 5 — one record per reference-fetch attempt through the seam. */
interface RefFetchRecord {
  readonly channelId: string
  readonly messageId: string
}

/** SLICE 5 — the parent message the fake resolves when no impl is injected. */
const DEFAULT_REF_MSG: FakeReferencedMessage = {
  content: "deploy is done, ready for review",
  author: { displayName: "Riven", username: "riven_writes" },
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
  /** Slice 3a. Invoked for every interaction ack; reject to make it fail. */
  readonly ackImpl?: (interactionId: string, token: string, content: string) => Promise<void>
  /**
   * Slice 3b. Invoked for every guild command registration attempt; reject to
   * make it fail. The Proxy log records the call either way.
   */
  readonly registerImpl?: (guildId: string, commands: ReadonlyArray<unknown>) => Promise<void>
  /**
   * Slice 4. Invoked for every attachment download attempt; reject to make
   * the download fail. `call` is the 1-based transport-wide attempt index.
   * When absent, the fake resolves a small REAL PNG (magic bytes intact) so
   * the sniff-after-download check passes for image/png fixtures.
   */
  readonly fetchImpl?: (url: string, call: number) => Promise<Uint8Array>
  /**
   * Slice 5. Invoked for every reply-reference fetch attempt; resolve null to
   * model a DELETED parent, reject to model a real fetch failure. `call` is
   * the 1-based transport-wide attempt index. When absent, the fake resolves
   * DEFAULT_REF_MSG so the happy-path quote renders.
   */
  readonly refMsgImpl?: (
    channelId: string,
    messageId: string,
    call: number,
  ) => Promise<FakeReferencedMessage | null>
}) => {
  let msgCb: ((m: InboundDiscordMessage) => void) | null = null
  let interactionCb: ((i: FakeInboundInteraction) => void) | null = null
  let readyCb: ((botTag: string) => void) | null = null
  const sent: SendRecord[] = []
  const edits: EditRecord[] = []
  const typingCalls: TypingRecord[] = []
  const fetchCalls: AttachmentFetchRecord[] = []
  const refFetchCalls: RefFetchRecord[] = []
  const log: TransportCallRecord[] = []
  let idCounter = 0
  let sendAttempts = 0
  let editAttempts = 0
  let typingAttempts = 0
  const typingAttemptsByChannel = new Map<string, number>()

  // NOTE: deliberately NOT annotated `: DiscordTransport`. The literal carries
  // two members the interface does not declare yet (`onInteraction`,
  // `ackInteractionEphemeral` — Slice 3a's seam), and an annotation would
  // TS2353 until they land. The cast below keeps the package tsc gate green
  // both before and after; the CONTRACT on their signatures is enforced
  // behaviorally by the Slice 3a tests (the ack-payload rail pins the exact
  // argument order (interactionId, token, content)).
  const underlying = {
    onMessage: (cb: (m: InboundDiscordMessage) => void) => {
      msgCb = cb
    },
    // SLICE 3a — RED BY DESIGN until the adapter registers it in start().
    onInteraction: (cb: (i: FakeInboundInteraction) => void) => {
      interactionCb = cb
    },
    // SLICE 3b — captured so tests can fire the gateway `ready` event. Never
    // fired implicitly: tests that do not call `fireReady` see the exact
    // pre-3b world (no test before this slice ever fired ready).
    onReady: (cb: (botTag: string) => void) => {
      readyCb = cb
    },
    onError: () => {},
    login: async () => {},
    destroy: async () => {},
    send: async (channelId: string, content: string) => {
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
    edit: async (channelId: string, messageId: string, content: string) => {
      editAttempts++
      if (opts?.editImpl !== undefined) {
        await opts.editImpl(channelId, messageId, content, editAttempts)
      }
      edits.push({ channelId, messageId, content })
    },
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
    /**
     * SLICE 3a — the ephemeral type-4 ack. The REAL implementation posts the
     * interaction callback (type 4, content, flags 64); the fake only records
     * the call (via the Proxy log) and honours an injected failure.
     */
    ackInteractionEphemeral: async (interactionId: string, token: string, content: string) => {
      if (opts?.ackImpl !== undefined) {
        await opts.ackImpl(interactionId, token, content)
      }
    },
    /**
     * SLICE 3b — RED BY DESIGN until the adapter calls it from the ready
     * path. The REAL implementation bulk-overwrites the guild-scoped command
     * endpoint (PUT /applications/{appId}/guilds/{guildId}/commands — the
     * Sol donor's rest.put shape); the fake only records the call (via the
     * Proxy log) and honours an injected failure. NOTE a fake structurally
     * CANNOT catch a global-endpoint impl (it records whatever guildId it is
     * handed) — endpoint choice is pinned at the REST layer by the ops-script
     * test (apps/ui-web/scripts/discord-commands.test.ts) and by the auditor
     * reading the real transport.
     */
    registerGuildCommands: async (guildId: string, commands: ReadonlyArray<unknown>) => {
      if (opts?.registerImpl !== undefined) {
        await opts.registerImpl(guildId, commands)
      }
    },
    /**
     * SLICE 4 — RED BY DESIGN until the adapter downloads attachments.
     * Download one attachment's bytes. The REAL implementation performs an
     * HTTPS GET of the CDN **proxy** URL (never the direct url — commit
     * 0ca615e in the Sol donor: the direct url's ?ex=&is=&hm= auth params get
     * dropped => 403) bounded by an AbortSignal timeout, and NEVER reads
     * process.env (hazard H2: the negative cases below are expressed by
     * EXPLICIT injection of a failing fetchImpl, not by omitting config).
     * Recorded BEFORE the impl runs, like sendTyping: a rejected download
     * still counts, both for the failure-resilience rails and for the
     * "zero fetches for a stranger" security rail.
     */
    fetchAttachment: async (url: string, init?: { readonly signal?: AbortSignal }) => {
      fetchCalls.push({ url, hasAbortSignal: init?.signal instanceof AbortSignal })
      if (opts?.fetchImpl !== undefined) {
        return opts.fetchImpl(url, fetchCalls.length)
      }
      return smallPng()
    },
    /**
     * SLICE 5 — RED BY DESIGN until the adapter resolves reply references.
     * Fetch the replied-to message so its content can be quoted into the
     * user text. The REAL implementation is cache-first then network (donor
     * gateway.ts reply block), resolves NULL for a deleted parent (Unknown
     * Message is ordinary, not an error) and REJECTS on real failures such
     * as missing READ_MESSAGE_HISTORY — the donor's `.catch(() => null)`
     * made those indistinguishable. Recorded BEFORE the impl runs, like
     * sendTyping/fetchAttachment: a rejected fetch still counts, both for
     * the failure-resilience rails and the "zero fetches for a stranger"
     * security rail.
     */
    fetchReferencedMessage: async (channelId: string, messageId: string) => {
      refFetchCalls.push({ channelId, messageId })
      if (opts?.refMsgImpl !== undefined) {
        return opts.refMsgImpl(channelId, messageId, refFetchCalls.length)
      }
      return DEFAULT_REF_MSG
    },
  }

  const transport = wrapWithCallLog(underlying, log) as unknown as DiscordTransport

  return {
    transport,
    fire: (m: InboundDiscordMessage) => msgCb?.(m),
    isWired: () => msgCb !== null,
    fireInteraction: (i: FakeInboundInteraction) => interactionCb?.(i),
    isInteractionWired: () => interactionCb !== null,
    /** SLICE 3b — fire the gateway ready event (RESUME can refire it). */
    fireReady: (tag = "eddy#0001") => readyCb?.(tag),
    /** The ONE ordered call log. Tests may push "__dispatch__" markers into it. */
    log,
    sent,
    edits,
    typingCalls,
    /** SLICE 4 — every attachment download attempt, in order. */
    fetchCalls,
    /** SLICE 5 — every reply-reference fetch attempt, in order. */
    refFetchCalls,
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

/* ========================================================================== */
/* SLICE 1b+11 — measured send classifier for FINAL sends (task #7)            */
/* ========================================================================== */

/**
 * EXECUTABLE SPEC (written before the implementation; RED on arrival).
 *
 * GIVEN a FINAL Discord send that rejects,
 * WHEN the adapter classifies the failure,
 * THEN it behaves per Sol Agent's MEASURED classifier (1295 production
 * failures: 571 channel-cache, 415 network, 155 token, 0 rate-limit):
 *   - "Could not find the channel"  => REFETCH: one immediate re-attempt
 *     (Luna's transport.send re-fetches the channel internally, so the donor's
 *     separate REST re-fetch collapses into simply calling send again).
 *   - "Expected token to be set"    => PERMANENT: abort immediately, no retry.
 *   - HTTP 4xx (and not 429)        => PERMANENT: abort immediately, no retry.
 *   - network / abort / 5xx         => RETRY: EXACTLY ONE app-level retry at a
 *     flat 750ms (donor DELIVERY_RETRY_MS; exported here as
 *     `discordDeliveryRetryMs`). Not a loop, not exponential.
 *   - in every non-recovered case the failure SURFACES out of deliver() (an
 *     Exit failure), so delivery.ts's chunk loop can stop. Defect vs typed
 *     error is pong's choice: `Effect.die` typechecks under the frozen
 *     `Effect.Effect<void>` signature in types.ts, which is OUT OF SCOPE.
 *
 * NO 429 BRANCH, BY DESIGN (AP4 is binding): Sol measured ZERO 429s at this
 * seam because @discordjs/rest queues and waits on rate limits internally,
 * and Luna's client shares those defaults. Do not add a 429 classifier branch
 * and do not spec one. The existing `withRateLimitRetry` tests above
 * (:457-547) keep their belt-and-suspenders behaviour AS IS.
 *
 * SCOPE CARVE-OUT — FINAL sends only. Three existing rails pin today's
 * best-effort swallow for the OTHER paths and must stay green UNEDITED:
 *   - "gives up after the attempt ceiling..." (persistent 429, PARTIAL):
 *     resolves, exactly 3 transport attempts. Your classifier must NOT add a
 *     second withRateLimitRetry round on top (3 + 3 = 6 breaks it).
 *   - "does not retry a non-429 failure" (status-LESS Missing Permissions,
 *     PARTIAL): resolves, exactly 1 attempt. Partials stay swallowed.
 *   - "swallows a benign edit failure..." (FINAL via the EDIT path): the
 *     placeholder-edit path keeps its swallow; this spec covers SENDS.
 * Stream partials are superseded by the final, so best-effort is correct
 * there; the chunk loop's finals are exactly where silent loss became the
 * donor's measured incident.
 *
 * OUT OF SCOPE — the implementation for Slice 1b+11 may modify ONLY:
 *   - packages/channels/src/adapters/discord.ts
 *   - packages/channels/src/delivery.ts
 *   - packages/channels/test/discord-adapter.test.ts (additions below existing
 *     tests only; never edit or weaken an existing test)
 *   - packages/channels/test/channels.test.ts (same constraint)
 * It must NOT touch: src/types.ts, src/index.ts, src/service.ts,
 * src/session-map.ts, src/commands.ts, src/dedup.ts, src/adapters/telegram*,
 * telegram tests, or any other package. The auditor enforces this from the
 * diff. (This is why the constant pin below imports from
 * "../src/adapters/discord.js" directly, not via index.js.)
 *
 * Tier B: donor constants are CLOSED (750ms, one retry, 120000ms, 1900).
 *
 * TALLY for this file's block: 8 tests, 7 RED on arrival, 1 control
 * (labelled CONTROL, green on arrival). Timing assertions are lower-bound
 * only, except the control's generous 700ms ceiling on a pure in-memory path.
 */

/** Donor-measured error shapes (sol-agent test/discord-multichunk-loss.test.ts). */
const ERR_CHANNEL_CACHE = () =>
  new Error("Could not find the channel chan-1 to send the reply to.")
const ERR_TOKEN = () =>
  new Error("Expected token to be set for this request, but none was present")
const ERR_FORBIDDEN = () => Object.assign(new Error("Missing Permissions"), { status: 403 })
const ERR_5XX = () => Object.assign(new Error("Internal Server Error"), { status: 502 })
const ERR_NETWORK = () =>
  Object.assign(new Error("getaddrinfo ENOTFOUND discord.com"), { code: "ENOTFOUND" })

const mkClassifierAdapter = (fake: ReturnType<typeof makeFakeTransport>) =>
  makeDiscordAdapter({
    id: "d-classify",
    transport: fake.transport,
    logLogin: false,
    allowedUsers: ["user-allowed"],
  })

describe("Slice 1b+11 — measured send classifier (FINAL sends)", () => {
  it("CONTROL (GREEN ON ARRIVAL): a clean FINAL send is exactly ONE attempt with no retry pause", async () => {
    // Survival rail pairing the attempt bounds below: a bound of "exactly 2"
    // is satisfiable by always retrying, and a flat-750ms sleep smuggled onto
    // the happy path would satisfy every RED test too. 700ms is far above an
    // in-memory transport call, so this ceiling is load-safe.
    const t0 = Date.now()
    const fake = makeFakeTransport()
    const adapter = mkClassifierAdapter(fake)
    const exit = await Effect.runPromiseExit(adapter.deliver(target(), "clean single send", FINAL))
    expect(exit._tag).toBe("Success")
    expect(fake.attempts().send).toBe(1)
    expect(fake.sent).toHaveLength(1)
    expect(Date.now() - t0).toBeLessThan(700)
  })

  it("REFETCH: a channel-cache miss gets one immediate re-attempt and recovers", async () => {
    // Donor's dominant failure (571 of 1295): the cached channel handle went
    // stale; fetching again succeeds. Luna's transport.send re-fetches
    // internally, so "refetch" here means exactly one more send() call.
    // Immediacy is deliberately UNASSERTED (no timing rail): only the count
    // and the recovery are the contract.
    const fake = makeFakeTransport({
      sendImpl: async (_c, _content, attempt) => {
        if (attempt === 1) throw ERR_CHANNEL_CACHE()
        return { id: "msg-refetched" }
      },
    })
    const adapter = mkClassifierAdapter(fake)
    const exit = await Effect.runPromiseExit(adapter.deliver(target(), "cache miss then fine", FINAL))
    expect(fake.attempts().send).toBe(2) // RED today: no re-attempt, stays 1
    expect(fake.sent).toHaveLength(1)
    expect(exit._tag).toBe("Success")
  })

  it("REFETCH: a PERSISTENT channel-cache miss stops after the one re-attempt and surfaces the failure", async () => {
    const fake = makeFakeTransport({
      sendImpl: async () => {
        throw ERR_CHANNEL_CACHE()
      },
    })
    const adapter = mkClassifierAdapter(fake)
    const exit = await Effect.runPromiseExit(adapter.deliver(target(), "channel is gone", FINAL))
    expect(fake.attempts().send).toBe(2) // exactly one re-attempt, NOT a loop
    expect(fake.sent).toHaveLength(0)
    expect(exit._tag).toBe("Failure") // RED today: swallowed into Success
  })

  it("PERMANENT: a token error aborts immediately, no retry, failure surfaced", async () => {
    // 155 of 1295 in the donor's measurement: the client lost its token
    // (restart mid-login, revoked credential). Retrying cannot help and each
    // retry burns the delivery deadline for the WHOLE turn.
    const fake = makeFakeTransport({
      sendImpl: async () => {
        throw ERR_TOKEN()
      },
    })
    const adapter = mkClassifierAdapter(fake)
    const exit = await Effect.runPromiseExit(adapter.deliver(target(), "who am I", FINAL))
    expect(exit._tag).toBe("Failure") // RED today: swallowed into Success
    expect(fake.attempts().send).toBe(1)
    expect(fake.sent).toHaveLength(0)
  })

  it("PERMANENT: an HTTP 4xx (not 429) aborts immediately, no retry, failure surfaced", async () => {
    // status 403 Missing Permissions: the bot cannot post here and a retry
    // cannot change that. NOTE the deliberate contrast with the status-LESS
    // "Missing Permissions" rail at the 429 block above: classification keys
    // on the numeric status, exactly as the donor's classifier does.
    const fake = makeFakeTransport({
      sendImpl: async () => {
        throw ERR_FORBIDDEN()
      },
    })
    const adapter = mkClassifierAdapter(fake)
    const exit = await Effect.runPromiseExit(adapter.deliver(target(), "no entry", FINAL))
    expect(exit._tag).toBe("Failure") // RED today: swallowed into Success
    expect(fake.attempts().send).toBe(1)
    expect(fake.sent).toHaveLength(0)
  })

  it("RETRY: a transient network failure gets EXACTLY ONE flat-750ms retry and recovers (constant exported)", async () => {
    const times: number[] = []
    const fake = makeFakeTransport({
      sendImpl: async (_c, _content, attempt) => {
        times.push(Date.now())
        if (attempt === 1) throw ERR_NETWORK()
        return { id: "msg-after-net-retry" }
      },
    })
    const adapter = mkClassifierAdapter(fake)
    const exit = await Effect.runPromiseExit(adapter.deliver(target(), "flaky network", FINAL))
    expect(fake.attempts().send).toBe(2) // RED today: no app-level retry, stays 1
    expect(fake.sent).toHaveLength(1)
    expect(exit._tag).toBe("Success")
    // Flat pacing, lower bound only (load-safe): the retry waited ~750ms.
    expect(times).toHaveLength(2)
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(700)
    // The donor constant, pinned as an export so the auditor and future
    // slices can reference it. Dynamic import + cast: a static named import
    // of a not-yet-existing export would kill this whole FILE at load time,
    // and this file must keep running its 48 existing tests while RED.
    const mod = (await import("../src/adapters/discord.js")) as unknown as Record<string, unknown>
    expect(mod["discordDeliveryRetryMs"]).toBe(750)
  })

  it("RETRY: a persistent 5xx stops after EXACTLY ONE retry and surfaces the failure", async () => {
    // The bound AND the survival rail live in different tests: "exactly 2"
    // here forbids a retry loop; the CONTROL above forbids satisfying this by
    // retrying everything always.
    const fake = makeFakeTransport({
      sendImpl: async () => {
        throw ERR_5XX()
      },
    })
    const adapter = mkClassifierAdapter(fake)
    const exit = await Effect.runPromiseExit(adapter.deliver(target(), "discord is down", FINAL))
    expect(fake.attempts().send).toBe(2) // RED today: stays 1
    expect(fake.sent).toHaveLength(0)
    expect(exit._tag).toBe("Failure")
  })
})

/**
 * SLICE 1b+11 RIDER — typing stop must be independent of delivery COMPLETION.
 *
 * The Slice 1 block already pins the other stop paths (first deliver lands,
 * EMPTY content, foreign transport, stop() sweep), and the breaker-open log
 * rider is already pinned by "logs exactly ONE warning when a channel's
 * breaker opens". Neither is duplicated here. A breaker RECOVERY log is
 * deliberately NOT specced: the landed Slice 1 breaker is permanent for the
 * life of the process ("never attempts a 4th"), so there is no recovery
 * transition to log; flagged to the lead in the task's Ping (spec) section.
 *
 * What was NOT covered anywhere: the send FAILING terminally. Today the
 * swallow hides that case; once failures surface, a restructured deliver()
 * could early-abort ABOVE the stopTyping call and leave the channel "typing"
 * for the rest of the refresh cap after a dead turn.
 */
describe("Slice 1b+11 rider — typing stops even when the FINAL send fails", () => {
  it("a terminally failing FINAL send still stops the typing loop, and the failure surfaces", async () => {
    const fake = makeFakeTransport({
      sendImpl: async () => {
        throw ERR_TOKEN()
      },
    })
    const adapter = makeDiscordAdapter({
      id: "d-fail-stops-typing",
      transport: fake.transport,
      logLogin: false,
      allowedUsers: ["user-allowed"],
      typingRefreshMs: 25,
    })
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    // Hold the turn open so the indicator keeps refreshing until deliver().
    adapter.setMessageHandler(() => Effect.promise(() => held))
    try {
      await withStarted(adapter, async () => {
        fake.fire(inbound({ id: "460", authorId: "user-allowed", content: "long task" }))
        await tick(90)
        // Anti-vacuity: the loop is really running before the failing send.
        expect(fake.attempts().typing).toBeGreaterThanOrEqual(2)

        const exit = await Effect.runPromiseExit(adapter.deliver(target(), "doomed reply", FINAL))
        expect(exit._tag).toBe("Failure") // RED today: swallowed into Success
        expect(fake.attempts().send).toBe(1) // token error is PERMANENT: no retry
        expect(fake.sent).toHaveLength(0)

        // The freeze half is a GUARD (green today, stopTyping precedes the
        // send): it must SURVIVE the classifier restructure. Settle one
        // window, snapshot, then wait five windows: no further refreshes.
        await tick(40)
        const frozen = fake.attempts().typing
        await tick(125)
        expect(fake.attempts().typing).toBe(frozen)
      })
    } finally {
      release()
      await Effect.runPromise(adapter.stop())
    }
  }, 20_000)
})

/* ========================================================================== */
/* SLICE 3a — InteractionCreate routing (EXECUTABLE SPEC, RED ON ARRIVAL)      */
/* ========================================================================== */

/**
 * EXECUTABLE SPEC (written before the implementation; RED on arrival).
 *
 * Feature: native slash commands become a SECOND gated inbound path into an
 * agent fronting an unrestricted local shell. The adapter must synthesize an
 * inbound message from a chat-input application command and route it through
 * the SINGLE existing gate and builder.
 *
 * THE INVARIANT (settled, not an open question — lead ruling R1):
 *   gate -> ack -> dispatch.
 * `isInboundAllowed` precedes the FIRST side effect on EVERY inbound path.
 * An ack is a side effect: acking a sender the gate has not cleared is a
 * pre-gate side effect and an automatic audit FAIL. No ack for strangers —
 * the client-rendered "did not respond" artifact is accepted (leaks nothing:
 * dead bot, offline bot and gating bot are indistinguishable). Do NOT
 * "improve" the drop into an ephemeral rejection.
 *
 * OUT OF SCOPE — the implementation for this scenario must NOT modify:
 *   - packages/channels/src/service.ts        (R3 reorder rides with 3b, NOT 3a)
 *   - packages/channels/src/delivery.ts
 *   - packages/channels/src/types.ts
 *   - packages/channels/src/dedup.ts
 *   - packages/channels/src/commands.ts       (catalog may be IMPORTED, not edited)
 *   - packages/channels/src/index.ts
 *   - packages/channels/src/adapters/telegram.ts and every telegram test
 *   - packages/channels/test/channels.test.ts
 *   - this file and discord-inbound-invariant.test.ts (specs are frozen)
 *   - registration wiring to Discord (rest.put, env, ops script — Slice 3b)
 * The ONLY production file this scenario may touch is
 * packages/channels/src/adapters/discord.ts.
 *
 * NEW SEAMS THIS BLOCK REQUIRES (all in discord.ts):
 *   1. `DiscordTransport.onInteraction(cb: (i: InboundDiscordInteraction) => void)`
 *      — the payload type MUST be `Inbound`-prefixed (the invariant test's
 *      bidirectional payload check enforces the convention). Shape: the
 *      test-local `FakeInboundInteraction` at the top of this file, verbatim.
 *   2. `DiscordTransport.ackInteractionEphemeral(interactionId, token, content)`
 *      — real impl posts interaction callback type 4 { content, flags: 64 }.
 *      NEVER type 5 / deferReply: replies go out-of-band via t.send, so a
 *      deferred ack strands every interaction in "thinking…".
 *   3. exported `normalizeDiscordInteraction(raw: unknown): InboundDiscordInteraction | null`
 *      — the wrapper's filter (advisor ruling 9): ONLY chat-input application
 *      commands normalize; autocomplete/component/modal/malformed => null,
 *      never a throw (mirrors the onMessage normalization try/catch). The
 *      real transport's InteractionCreate listener must call it and stay
 *      silent on null (no synthesis, no ack, no error).
 *   4. exported `discordCommandManifest` — registration DATA (3b wires it).
 *      Zero-option commands only (advisor ruling 4: an option-stripped
 *      "/deploy target" in front of a guessing agent is the dangerous state).
 *   5. Interaction handler must be a file-level NAMED function registered as
 *      `t.onInteraction(<name>)` — the invariant test's ordering scan resolves
 *      it by name.
 * Implementation notes bound by the advisor rulings (audit checks these):
 *   - AWAIT the ack (with catch), THEN runFork the dispatch. An un-caught
 *     expired-token rejection is an unhandledRejection => process death.
 *   - Route the synthesized message through toChannelMessage — hand-building
 *     mis-stamps `transport` and service.ts:233 then drops every reply
 *     silently (hazard H1).
 *   - Dedup on interaction.id at this seam: gateway session resume can REPLAY
 *     INTERACTION_CREATE, and a replayed command re-executes against the shell.
 *   - Key the drop log on channel:author:KIND (advisor D1 adoption): a
 *     stranger switching from message-probing to slash-probing must produce a
 *     NEW line — at a shell boundary the vector change is the signal.
 *   - Document AT THE ACK SITE the residual reply-permission asymmetry
 *     (advisor item 2): slash availability follows the INVOKER's perms and the
 *     callback endpoint bypasses channel perms, but t.send does not — an
 *     allowed user invoking in a no-send channel gets "On it." then silence
 *     with side effects committed. 3b's guild-scoped registration makes this
 *     rare; it is NOT closed here. Documentation, not a test.
 *
 * CAPACITY PRE-FLIGHT: none required — every transport is an in-memory fake;
 * no rate-limited vendor, no network, no LLM seam (deterministic => no N>=5
 * multi-trial parametrization applies).
 *
 * RED/GREEN inventory at handoff: 15 tests in this block are RED (the feature
 * is absent: onInteraction never registered, exports missing, zero dispatch).
 * Exactly 2 are GREEN-ON-ARRIVAL BY DESIGN and labelled CONTROL inline — both
 * exercise the Proxy-log retrofit this spec ships in makeFakeTransport, and
 * both are the survival rails the empty-delta assertions lean on.
 */

/** Everything Slice 3a imports is dynamic: exports do not exist yet. */
const discordModule = async (): Promise<Record<string, unknown>> =>
  (await import("../src/adapters/discord.js")) as unknown as Record<string, unknown>

const discordSourceText = async (): Promise<string> => {
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const path = await import("node:path")
  const here = path.dirname(fileURLToPath(import.meta.url))
  return readFileSync(path.join(here, "../src/adapters/discord.ts"), "utf8")
}

const interactionFixture = (o: Partial<FakeInboundInteraction> = {}): FakeInboundInteraction => ({
  id: "i-900",
  channelId: "chan-1",
  authorId: "user-allowed",
  commandName: "help",
  token: "itok-SECRET-901",
  guildId: "guild-1",
  isThread: false,
  isDM: false,
  createdAt: "2026-08-05T00:00:00.000Z",
  ...o,
})

const setup3a = (cfg?: {
  readonly allowedUsers?: string[]
  readonly allowedChannels?: string[]
  readonly ackImpl?: (interactionId: string, token: string, content: string) => Promise<void>
}) => {
  const fake = makeFakeTransport(cfg?.ackImpl !== undefined ? { ackImpl: cfg.ackImpl } : {})
  const received: ChannelMessage[] = []
  const adapter = makeDiscordAdapter({
    id: "d-3a",
    transport: fake.transport,
    logLogin: false,
    allowedUsers: cfg?.allowedUsers ?? ["user-allowed"],
    ...(cfg?.allowedChannels !== undefined ? { allowedChannels: cfg.allowedChannels } : {}),
  })
  adapter.setMessageHandler((m) =>
    Effect.sync(() => {
      // The dispatch marker rides the SAME ordered log as the transport calls,
      // so "ack strictly precedes dispatch" is one-timeline arithmetic.
      fake.log.push({ member: "__dispatch__", args: [m] })
      received.push(m)
    }),
  )
  return { fake, adapter, received }
}

const dispatchCount = (s: { fake: { log: TransportCallRecord[] } }): number =>
  s.fake.log.filter((e) => e.member === "__dispatch__").length

describe("Slice 3a — Proxy call log (retrofit controls)", () => {
  it("CONTROL: the ordered log records every transport method by construction", async () => {
    const { fake, adapter } = setup3a()
    await withStarted(adapter, async () => {
      await Effect.runPromise(adapter.deliver(target(), "one reply", FINAL))
    })
    const members = fake.log.map((e) => e.member)
    // start() wiring and login are all watched — no hand instrumentation left.
    for (const m of ["onMessage", "onError", "onReady", "login", "send"]) {
      expect(members, `log must contain ${m}`).toContain(m)
    }
    // The recorded args are the real args, not a summary.
    const send = fake.log.find((e) => e.member === "send")
    expect(send?.args[0]).toBe("chan-1")
    expect(send?.args[1]).toBe("one reply")
    // And the log agrees with the legacy per-method records it supersedes.
    expect(fake.sent).toHaveLength(1)
  })

  it("CONTROL: a stranger MESSAGE produces an EMPTY post-start log delta (all members, present and future)", async () => {
    const { fake, adapter, received } = setup3a()
    await withStarted(adapter, async () => {
      const mark = fake.log.length
      fake.fire(inbound({ authorId: "attacker", content: "sudo make me a sandwich" }))
      await tick(60)
      expect(fake.log.slice(mark)).toEqual([])
    })
    expect(received).toHaveLength(0)
  })
})

describe("Slice 3a — InteractionCreate: wrapper filter (normalizeDiscordInteraction)", () => {
  it("normalizes a chat-input application command (and ONLY then)", async () => {
    const mod = await discordModule()
    const norm = mod["normalizeDiscordInteraction"] as
      | ((raw: unknown) => FakeInboundInteraction | null)
      | undefined
    expect(typeof norm, "normalizeDiscordInteraction must be exported").toBe("function")
    const out = norm!({
      id: "i-1",
      token: "itok-raw-1",
      channelId: "chan-1",
      user: { id: "user-allowed" },
      commandName: "help",
      guildId: "guild-1",
      channel: null,
      createdTimestamp: 1754350000000,
      isChatInputCommand: () => true,
    })
    expect(out).not.toBeNull()
    expect(out).toMatchObject({
      id: "i-1",
      token: "itok-raw-1",
      channelId: "chan-1",
      authorId: "user-allowed",
      commandName: "help",
      isThread: false,
      isDM: false,
    })
    expect(out?.createdAt).toBe(new Date(1754350000000).toISOString())
  })

  it("returns null (never throws, never synthesizes) for every non-chat-input interaction", async () => {
    const mod = await discordModule()
    const norm = mod["normalizeDiscordInteraction"] as
      | ((raw: unknown) => unknown)
      | undefined
    expect(typeof norm, "normalizeDiscordInteraction must be exported").toBe("function")
    const core = {
      id: "i-2",
      token: "itok-raw-2",
      channelId: "chan-1",
      user: { id: "user-allowed" },
      channel: null,
      createdTimestamp: 1754350000000,
    }
    // Autocomplete acked with a message callback is an API error; components
    // and modals synthesize garbage. The WRAPPER ignores them all — this rail
    // must not depend on what we remember to register (advisor ruling 9).
    const rejects: ReadonlyArray<[string, unknown]> = [
      ["autocomplete", { ...core, isChatInputCommand: () => false, isAutocomplete: () => true }],
      ["component", { ...core, isChatInputCommand: () => false, isButton: () => true }],
      ["modal", { ...core, isChatInputCommand: () => false, isModalSubmit: () => true }],
      ["malformed (no type probe at all)", { ...core }],
      ["hostile (type probe throws)", { ...core, isChatInputCommand: () => { throw new Error("boom") } }],
    ]
    for (const [label, raw] of rejects) {
      expect(norm!(raw), `${label} must normalize to null`).toBeNull()
    }
  })

  it("thread parentage: nullable interaction.channel FAILS CLOSED to not-a-thread", async () => {
    const mod = await discordModule()
    const norm = mod["normalizeDiscordInteraction"] as
      | ((raw: unknown) => FakeInboundInteraction | null)
      | undefined
    expect(typeof norm, "normalizeDiscordInteraction must be exported").toBe("function")
    const base = {
      id: "i-3",
      token: "itok-raw-3",
      channelId: "thread-9",
      user: { id: "user-allowed" },
      commandName: "help",
      createdTimestamp: 1754350000000,
      isChatInputCommand: () => true,
    }
    // channel null => cannot prove parentage => NOT a thread (fail closed).
    const nullChannel = norm!({ ...base, channel: null })
    expect(nullChannel?.isThread).toBe(false)
    expect(nullChannel?.parentId).toBeUndefined()
    // channel present and a thread => parentage carried, so isAllowedChannel's
    // thread-inherits-parent grant works identically to the message path.
    const inThread = norm!({
      ...base,
      channel: { isThread: () => true, parentId: "parent-1" },
    })
    expect(inThread?.isThread).toBe(true)
    expect(inThread?.parentId).toBe("parent-1")
    // channel present, not a thread => plain channel.
    const plain = norm!({ ...base, channel: { isThread: () => false } })
    expect(plain?.isThread).toBe(false)
    expect(plain?.parentId).toBeUndefined()
  })
})

describe("Slice 3a — InteractionCreate: the gate (no ack for strangers)", () => {
  it("registers onInteraction on start()", async () => {
    const { fake, adapter } = setup3a()
    await withStarted(adapter, () => {})
    expect(
      fake.log.some((e) => e.member === "onInteraction"),
      "start() must register the interaction handler on the transport",
    ).toBe(true)
    expect(fake.isInteractionWired()).toBe(true)
  })

  it("SECURITY: a stranger's slash command is a SILENT drop — empty log delta, no dispatch, ONE drop line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const { fake, adapter, received } = setup3a()
      await withStarted(adapter, async () => {
        const mark = fake.log.length
        fake.fireInteraction(interactionFixture({ authorId: "attacker", token: "itok-SECRET-A" }))
        await tick(60)
        // NO ack, NO typing, NO send, NO dispatch: an ack here is a pre-gate
        // side effect and an "is something listening" oracle (ruling R1/D1).
        expect(fake.log.slice(mark)).toEqual([])
      })
      expect(received).toHaveLength(0)
      const dropLines = warn.mock.calls.filter((c) => /dropped inbound/.test(c.join(" ")))
      expect(dropLines, "exactly one drop line for the slash probe").toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it("drop log is keyed per VECTOR: message-probing then slash-probing is TWO lines, repeat slash adds none", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const { fake, adapter } = setup3a()
      await withStarted(adapter, async () => {
        fake.fire(inbound({ id: "500", authorId: "attacker", channelId: "chan-1" }))
        await tick(30)
        fake.fireInteraction(
          interactionFixture({ id: "i-501", authorId: "attacker", channelId: "chan-1" }),
        )
        await tick(30)
        fake.fireInteraction(
          interactionFixture({ id: "i-502", authorId: "attacker", channelId: "chan-1" }),
        )
        await tick(30)
      })
      const dropLines = warn.mock.calls.filter((c) => /dropped inbound/.test(c.join(" ")))
      // Today's channel:author key logs the vector CHANGE zero times. At a
      // shell boundary the vector change is the thing you most want to see.
      expect(dropLines, "message drop + FIRST slash drop = two lines").toHaveLength(2)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("Slice 3a — InteractionCreate: ack mechanics (gate -> ack -> dispatch)", () => {
  it("AWAITS the ack, THEN forks the dispatch — ack strictly precedes dispatch in the ONE ordered log", async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    const s = setup3a({ ackImpl: () => held })
    try {
      await withStarted(s.adapter, async () => {
        s.fake.fireInteraction(interactionFixture())
        await tick(50)
        const ackIdx = s.fake.log.findIndex((e) => e.member === "ackInteractionEphemeral")
        expect(ackIdx, "the ack must have been attempted").toBeGreaterThanOrEqual(0)
        // While the ack is in flight the dispatch must NOT have been forked:
        // the ack has a 3s deadline and must front-run event-loop contention
        // from the turn (advisor ruling 8).
        expect(dispatchCount(s)).toBe(0)
        release()
        await tick(50)
        const dispatchIdx = s.fake.log.findIndex((e) => e.member === "__dispatch__")
        expect(dispatchIdx, "dispatch must proceed once the ack settles").toBeGreaterThan(ackIdx)
      })
    } finally {
      release()
    }
  })

  it("acks ephemerally with the interaction's own credentials: args are (id, token, \"On it.\")", async () => {
    const s = setup3a()
    const i = interactionFixture({ id: "i-600", token: "itok-SECRET-600" })
    await withStarted(s.adapter, async () => {
      s.fake.fireInteraction(i)
      await tick(50)
    })
    const ack = s.fake.log.find((e) => e.member === "ackInteractionEphemeral")
    expect(ack, "allowed invoker must be acked").toBeDefined()
    expect(ack?.args).toEqual(["i-600", "itok-SECRET-600", "On it."])
  })

  it("an ack REJECTION (expired token) is survivable: dispatch proceeds, no unhandledRejection, one log line", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const s = setup3a({
        ackImpl: async () => {
          throw new Error("10062: Unknown interaction (token expired)")
        },
      })
      await withStarted(s.adapter, async () => {
        s.fake.fireInteraction(interactionFixture({ id: "i-700" }))
        await tick(80)
      })
      // The reply path is t.send, not the callback — a dead ack must not eat
      // the turn (ruling 8), and an un-caught rejection kills the process.
      expect(s.received).toHaveLength(1)
      expect(unhandled).toEqual([])
      const ackLines = [...errSpy.mock.calls, ...warnSpy.mock.calls].filter((c) =>
        /ack/i.test(c.join(" ")),
      )
      expect(ackLines, "exactly one log line for the failed ack").toHaveLength(1)
    } finally {
      errSpy.mockRestore()
      warnSpy.mockRestore()
      process.off("unhandledRejection", onUnhandled)
    }
  })
})

describe("Slice 3a — InteractionCreate: dedup, synthesis and hygiene", () => {
  it("dedups on interaction.id: gateway-resume replay of the SAME interaction dispatches ONCE", async () => {
    const s = setup3a()
    await withStarted(s.adapter, async () => {
      const replayed = interactionFixture({ id: "i-800" })
      s.fake.fireInteraction(replayed)
      await tick(40)
      s.fake.fireInteraction(replayed) // resume replay re-executes against the shell
      await tick(40)
      expect(s.received, "one dispatch for one interaction").toHaveLength(1)
      // Anti-vacuity partner: dedup keys on the ID, it is not a global latch.
      s.fake.fireInteraction(interactionFixture({ id: "i-801" }))
      await tick(40)
      expect(s.received).toHaveLength(2)
    })
  })

  it("synthesizes through toChannelMessage: correct transport stamp, address fields and '/verb' text", async () => {
    const s = setup3a()
    await withStarted(s.adapter, async () => {
      s.fake.fireInteraction(interactionFixture())
      await tick(50)
    })
    expect(s.received).toHaveLength(1)
    const m = s.received[0]!
    // H1: a mis-stamped transport makes service.ts:233 silently drop every
    // reply, forever, with the Slice 0 rail green the whole time.
    expect(m.transport).toBe("discord")
    expect(m.transport).toBe(s.adapter.transport)
    expect(m.channelId).toBe("chan-1")
    expect(m.senderId).toBe("user-allowed")
    expect(m.threadingKey).toBe("chan-1")
    expect(m.text).toBe("/help")
    // H1 second order: an undefined platformMessageId poisons the dedup store.
    expect(m.platformMessageId).toBe("i-900")
    expect(m.ts).toBe("2026-08-05T00:00:00.000Z")
    expect(m.metadata?.["messageId"]).toBe("i-900")
  })

  it("TOKEN HYGIENE: the interaction token appears NOWHERE in the synthesized message", async () => {
    const s = setup3a()
    await withStarted(s.adapter, async () => {
      s.fake.fireInteraction(interactionFixture({ token: "itok-SECRET-901" }))
      await tick(50)
    })
    expect(s.received).toHaveLength(1)
    const m = s.received[0]!
    // service.ts:111 spreads metadata into the delivery address, so a token in
    // metadata rides the delivery layer — a 15-minute post-as-the-bot
    // capability in an untyped bag (H4's mechanism, worse payload).
    expect(JSON.stringify(m)).not.toContain("itok-SECRET-901")
    const metaKeys = Object.keys(m.metadata ?? {})
    expect(metaKeys).not.toContain("token")
    expect(metaKeys).not.toContain("interactionToken")
    // And no metadata key may shadow a reserved address key (H4).
    for (const reserved of ["transport", "channelId", "senderId", "threadingKey"]) {
      expect(metaKeys, `metadata must not shadow address.${reserved}`).not.toContain(reserved)
    }
  })

  it("thread parentage feeds the gate: a thread inherits its parent's grant; unprovable parentage fails closed", async () => {
    const s = setup3a({ allowedChannels: ["parent-1"] })
    await withStarted(s.adapter, async () => {
      // Thread under an allowlisted parent: allowed, and the synthesized
      // message carries the parentage so the MESSAGE path in the same thread
      // agrees (no silent asymmetry between the two paths).
      s.fake.fireInteraction(
        interactionFixture({
          id: "i-810",
          channelId: "thread-77",
          isThread: true,
          parentId: "parent-1",
        }),
      )
      await tick(40)
      expect(s.received).toHaveLength(1)
      expect(s.received[0]?.metadata?.["isThread"]).toBe(true)
      expect(s.received[0]?.metadata?.["parentId"]).toBe("parent-1")
      // Same physical thread but the channel was null at normalization time:
      // not provably a thread => fail closed => dropped under the allowlist.
      s.fake.fireInteraction(
        interactionFixture({ id: "i-811", channelId: "thread-88", isThread: false }),
      )
      await tick(40)
      expect(s.received).toHaveLength(1)
    })
  })
})

describe("Slice 3a — registration manifest as data (wired to Discord by 3b)", () => {
  it("pins the manifest: exactly help/new/stop, ZERO options, guild-install + guild-context only, member perms '0'", async () => {
    const mod = await discordModule()
    const manifest = mod["discordCommandManifest"] as
      | ReadonlyArray<Record<string, unknown>>
      | undefined
    expect(Array.isArray(manifest), "discordCommandManifest must be exported").toBe(true)
    const names = manifest!.map((c) => c["name"]).sort()
    expect(names).toEqual(["help", "new", "stop"])
    for (const cmd of manifest!) {
      // EXACT shape: no options key AT ALL is the zero-option pin (advisor
      // ruling 4 — option serialization is deliberately deferred).
      expect(Object.keys(cmd).sort()).toEqual([
        "contexts",
        "default_member_permissions",
        "description",
        "integration_types",
        "name",
        "type",
      ])
      expect(cmd["type"], "CHAT_INPUT").toBe(1)
      // D1 complement: scoping is NOISE REDUCTION, never an auth layer —
      // isInboundAllowed remains the only boundary. These fields keep the
      // no-ack path RARE (strangers stop seeing the commands at all).
      expect(cmd["default_member_permissions"]).toBe("0")
      expect(cmd["contexts"], "guild context only, no DMs").toEqual([0])
      expect(cmd["integration_types"], "guild install only, no user-install").toEqual([0])
      const desc = cmd["description"]
      expect(typeof desc).toBe("string")
      expect((desc as string).length).toBeGreaterThan(0)
      expect((desc as string).length).toBeLessThanOrEqual(100)
    }
  })

  it("ack mechanics are type 4 ephemeral, never deferred: source pin", async () => {
    const src = await discordSourceText()
    // The real transport's ack posts interaction callback type 4 with content
    // and flags 64 (donor: every Sol ack is type 4; deferReply appears nowhere
    // in that repo). Type 5 with no webhook follow-up strands every
    // interaction in "thinking…" — our replies go out-of-band via t.send.
    expect(/\btype:\s*4\b/.test(src), "callback type 4 present").toBe(true)
    expect(/\bflags:\s*64\b/.test(src), "EPHEMERAL flag 64 present").toBe(true)
    expect(/\btype:\s*5\b/.test(src), "no deferred callback (type 5)").toBe(false)
    expect(/deferReply/.test(src), "deferReply must not appear (even in comments)").toBe(false)
  })
})

/* ========================================================================== */
/* SLICE 3b — guild-scoped slash-command registration (task #10)               */
/* ========================================================================== */

/**
 * EXECUTABLE SPEC (written before the implementation; RED on arrival).
 *
 * Scenario (task #10): on gateway `ready`, the adapter bulk-registers the
 * 3a manifest (`discordCommandManifest`, pinned as data at the "Slice 3a —
 * registration manifest as data" block above) via the transport seam
 * `registerGuildCommands(guildId, commands)` — guild-scoped, ONCE per
 * start(), only when a home guild is configured. Donor shape:
 * sol-agent lib/discord/commands.ts registerSlashCommands (guild-scoped
 * rest.put per guild, called from ready, "instant propagation, no 1-hour
 * cache"). What is deliberately NOT ported: the donor's console.error
 * swallow — registration failure here must be LOUD (and still non-fatal).
 *
 * Advisor D1 rider, restated because it is the posture of this whole slice:
 * registration scoping (guild-scoped, default_member_permissions "0",
 * guild-install only, no DM context) is NOISE REDUCTION, NEVER AUTH.
 * `isInboundAllowed` remains the only boundary. 3b exists to make 3a's
 * no-ack stranger-drop path and the residual reply-permission gap RARE.
 *
 * OUT OF SCOPE — pong may touch ONLY:
 *   - packages/channels/src/adapters/discord.ts  (transport member +
 *     `guildId?: string` on DiscordAdapterConfig + ready-path wiring)
 *   - packages/channels/src/service.ts           (ONE line: the
 *     buildDeliveryTarget metadata spread reorder — see the R3 test in
 *     channels.test.ts; NOTHING else in this file)
 *   - apps/ui-web/scripts/discord-commands.ts    (NEW ops script)
 * Explicitly NOT to be touched: telegram.ts, delivery.ts, commands.ts,
 * index.ts (the ops script reaches the manifest by relative import — do NOT
 * add an index re-export, it drags index.ts into scope), dedup.ts, types.ts,
 * this test file, discord-inbound-invariant.test.ts, channels.test.ts.
 * NOTE: task #10 also names apps/ui-web/scripts/chat-server.ts (:4791-:4817,
 * LUNA_DISCORD_GUILD_ID -> config.guildId wiring) while the 3b dispatch's
 * allowed list omits it; that conflict is bubbled to the lead in the task's
 * Ping (spec) section — pong must NOT touch chat-server.ts without the
 * lead's explicit ruling.
 *
 * CAPACITY PRE-FLIGHT: none required — in-memory fakes only, no network, no
 * LLM seam (deterministic => the N>=5 multi-trial rule does not apply).
 *
 * RED/GREEN inventory at handoff: all 6 tests in this block are RED (the
 * seam is absent: nothing calls registerGuildCommands, no skip/failure log
 * lines exist). Zero GREEN-by-design controls in THIS block; the harness
 * controls live in the 3a Proxy-log block above.
 */

/**
 * The evidence line GOAL.md's Slice-6 scripted check greps for
 * ("discord slash commands: registered guild=<id> count=3"). count is
 * COMPUTED from the manifest so a manifest change cannot silently rot it.
 */
const registeredLine = (guildId: string): string =>
  `discord slash commands: registered guild=${guildId} count=${discordCommandManifest.length}`

const setup3b = (cfg?: {
  readonly guildId?: string
  readonly registerImpl?: (guildId: string, commands: ReadonlyArray<unknown>) => Promise<void>
}) => {
  const fake = makeFakeTransport(
    cfg?.registerImpl !== undefined ? { registerImpl: cfg.registerImpl } : {},
  )
  const received: ChannelMessage[] = []
  const adapter = makeDiscordAdapter({
    id: "d-3b",
    transport: fake.transport,
    logLogin: false,
    allowedUsers: ["user-allowed"],
    // `guildId` is 3b's NEW config member (task #10: DiscordAdapterConfig
    // gains guildId?: string). The conditional spread keeps the package tsc
    // gate green BEFORE the member is declared — excess-property checking
    // does not fire through a conditional spread (GOAL.md caveat, proven on
    // typingRefreshMs in Slice 1). The member's behaviour, not its type, is
    // the contract under test here.
    ...(cfg?.guildId !== undefined ? { guildId: cfg.guildId } : {}),
  })
  adapter.setMessageHandler((m) =>
    Effect.sync(() => {
      fake.log.push({ member: "__dispatch__", args: [m] })
      received.push(m)
    }),
  )
  return { fake, adapter, received }
}

/** Registration attempts, straight off the ONE ordered Proxy log. */
const regCalls = (s: { fake: { log: TransportCallRecord[] } }): TransportCallRecord[] =>
  s.fake.log.filter((e) => e.member === "registerGuildCommands")

/** Every arg of every recorded console call, flattened to strings. */
const consoleText = (spies: ReadonlyArray<{ mock: { calls: unknown[][] } }>): string =>
  spies
    .flatMap((s) => s.mock.calls)
    .map((args) => args.map((a) => String(a)).join(" "))
    .join("\n")

describe("Slice 3b — guild command registration on ready (task #10)", () => {
  it("GIVEN a configured home guild WHEN the gateway fires ready THEN the manifest is bulk-registered exactly once, guild-scoped, with the Slice-6 evidence line", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      const s = setup3b({ guildId: "guild-home-1" })
      await withStarted(s.adapter, async () => {
        // Registration must NOT happen before ready: no application id
        // exists yet and the real endpoint would 404 (task #10 trap 3).
        await tick(20)
        expect(regCalls(s), "no registration before ready").toHaveLength(0)

        s.fake.fireReady("eddy#0001")
        await tick(40)

        const calls = regCalls(s)
        expect(calls, "exactly one registration per ready").toHaveLength(1)
        // Guild-scoped: the configured home guild, verbatim.
        expect(calls[0]?.args[0]).toBe("guild-home-1")
        // The payload IS the manifest — as data, same discipline as 3a. The
        // manifest's own content (help/new/stop, ZERO options, "0"/[0]/[0])
        // is already pinned by the 3a manifest block above; re-pinning the
        // fields here would only add duplicate green assertions. What a fake
        // cannot see (a literal ["new","stop","help"] hand-copy inside
        // discord.ts, or a global endpoint behind this member) is the
        // auditor's grep, per task #10's trap list.
        expect(calls[0]?.args[1]).toEqual([...discordCommandManifest])
      })
      // Operational evidence: GOAL.md Slice 6 greps for this exact line.
      expect(
        consoleText([logSpy]),
        "registered evidence line for the ops runbook",
      ).toContain(registeredLine("guild-home-1"))
    } finally {
      logSpy.mockRestore()
    }
  })

  it("WHEN gateway RESUME refires ready THEN registration still happens exactly once per start() (latch)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      const s = setup3b({ guildId: "guild-home-1" })
      await withStarted(s.adapter, async () => {
        s.fake.fireReady("eddy#0001")
        await tick(20)
        // Gateway session RESUME refires ready on the SAME start().
        s.fake.fireReady("eddy#0001")
        await tick(20)
        expect(regCalls(s), "ready refire must not re-register").toHaveLength(1)
      })
    } finally {
      logSpy.mockRestore()
    }
  })

  it("WHEN messages flow after ready THEN no per-message re-registration storm", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      const s = setup3b({ guildId: "guild-home-1" })
      await withStarted(s.adapter, async () => {
        s.fake.fireReady("eddy#0001")
        await tick(20)
        s.fake.fire(inbound({ id: "3b-m1", content: "first" }))
        s.fake.fire(inbound({ id: "3b-m2", content: "second" }))
        await tick(60)
        // Both messages really flowed (anti-vacuity: an adapter that stopped
        // dispatching would trivially satisfy the count below).
        expect(dispatchCount(s), "both allowed messages dispatched").toBe(2)
        expect(regCalls(s), "registration is per start(), never per message").toHaveLength(1)
      })
    } finally {
      logSpy.mockRestore()
    }
  })

  it.each([
    ["undefined", undefined],
    ["empty string", ""],
  ])(
    "GIVEN no home guild configured (%s) WHEN ready fires THEN ZERO registration calls, one visible skip line, and the adapter keeps working — never a throw",
    async (_label, guildId) => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      try {
        const s = setup3b(guildId === undefined ? {} : { guildId })
        await withStarted(s.adapter, async () => {
          s.fake.fireReady("eddy#0001")
          await tick(40)
          // GREEN-vacuous alone (nothing registers today either) — paired
          // with the RED skip-line assertion below, per the deletion-cheat
          // rule: silence must be a DECISION with evidence, not an accident.
          expect(regCalls(s), "no guild => no registration call at all").toHaveLength(0)

          // Visible decision line: contains BOTH the what and the why. The
          // exact phrasing is pinned loosely (two substrings) so pong owns
          // the sentence, but an operator grepping "slash commands" finds it.
          const text = consoleText([logSpy, warnSpy])
          expect(text, "skip line names the feature").toContain("slash commands: not registered")
          expect(text, "skip line names the reason").toContain("guildId")

          // Adapter is alive and gated messages still flow.
          s.fake.fire(inbound({ id: `3b-skip-${_label}`, content: "still alive?" }))
          await tick(40)
          expect(dispatchCount(s), "adapter continues without registration").toBe(1)
        })
      } finally {
        logSpy.mockRestore()
        warnSpy.mockRestore()
      }
    },
  )

  it("WHEN registration fails THEN the failure is LOUD, primitive-fields-only (A5: no err.name, no raw error object), and the adapter stays up", async () => {
    // A5 (3a audit finding, remediated at discord.ts:937-944): discord.js
    // RateLimitError.name embeds the tokened route, and String(err) /
    // console.error(err) serialize enumerable url/route members. The fake
    // failure plants a sentinel in exactly those places; err.message stays a
    // safe primitive ("Missing Permissions" — the realistic 50013 case).
    const LEAK = "itok-LEAK-SENTINEL-3B"
    const err = new Error("Missing Permissions")
    err.name = `RateLimitError[/applications/app/guilds/${LEAK}/commands]`
    ;(err as unknown as Record<string, unknown>)["url"] =
      `https://discord.com/api/v10/${LEAK}`
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const s = setup3b({
        guildId: "guild-home-1",
        registerImpl: async () => {
          throw err
        },
      })
      await withStarted(s.adapter, async () => {
        s.fake.fireReady("eddy#0001")
        await tick(40)
        // The attempt happened (this is what makes the loudness assertions
        // non-vacuous — and it is the assertion that is RED pre-impl).
        expect(regCalls(s), "registration was attempted").toHaveLength(1)

        // LOUD: exactly one console.error, naming the feature and the guild.
        // NOT the donor's swallow (Sol logs and moves on with no guild id and
        // at .message granularity only when it remembers) and NOT a crash.
        expect(errSpy.mock.calls, "exactly one failure line").toHaveLength(1)
        const line = errSpy.mock.calls[0]?.map((a) => String(a)).join(" ") ?? ""
        expect(line).toContain("slash commands")
        expect(line).toContain("failed")
        expect(line).toContain("guild-home-1")

        // A5: primitive fields only — no argument may be an object (that is
        // how enumerable url/route members reach the log), and the sentinel
        // planted in err.name/err.url must appear NOWHERE on any console.
        for (const arg of errSpy.mock.calls[0] ?? []) {
          expect(
            ["string", "number", "boolean"].includes(typeof arg),
            `console.error arg is a primitive, got ${typeof arg}`,
          ).toBe(true)
        }
        expect(consoleText([logSpy, warnSpy, errSpy])).not.toContain(LEAK)

        // Non-fatal: the gateway continues, gated messages still dispatch.
        // (The floating-rejection rule from 3a ruling 8 applies unchanged: a
        // rejected registration must never surface as an unhandledRejection —
        // this test completing at all is that evidence.)
        s.fake.fire(inbound({ id: "3b-fail-m1", content: "after the failure" }))
        await tick(40)
        expect(dispatchCount(s), "adapter survived the failed registration").toBe(1)
      })
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})

/* -------------------------------------------------------------------------- */
/* SLICE 4 (task #5) — inbound attachments, limits enforced BEFORE download    */
/* -------------------------------------------------------------------------- */

/**
 * SLICE 4 SPEC — Given an inbound Discord message carrying attachments, when
 * the allowlist gate accepts it, then each attachment is validated against
 * @luna/core attachment-limits BEFORE its bytes are fetched, downloaded via
 * the CDN PROXY url under an AbortSignal, sniffed against its magic bytes,
 * and dispatched as a base64 ChannelAttachment on the ChannelMessage — and
 * every refusal is a per-attachment decision with an EMITTED user-facing
 * note, never a silent whole-turn drop and never a raw Error.message.
 *
 * WHY pre-download is a HARD requirement: this bot fronts an unrestricted
 * local shell on Eric's machine; a 2 GB "image" that is measured only after
 * download is a trivial resource attack (task #5). The Sol donor's inbound
 * path is REFUSED wholesale (census Finding 4: no size cap, no count cap, no
 * MIME allowlist, bare fetch, never reads attachment.size); only its gotchas
 * are ported (proxyURL, null-tolerant dimensions, MAX_IMAGE_PX=1568 CDN
 * downscale, never resize GIFs, sniff-after-download).
 *
 * OUT OF SCOPE — the implementation for this scenario must NOT modify:
 *   - packages/channels/src/service.ts, delivery.ts, types.ts (the
 *     ChannelAttachment / ChannelMessage.attachments contract ALREADY exists
 *     there), dedup.ts, commands.ts, index.ts
 *   - packages/channels/src/adapters/telegram.ts (frozen for the whole
 *     Discord sequence — the sniffing logic it holds is PRIVATE to it; write
 *     a Discord-local or NEW-module sniffer, do not extract from telegram.ts)
 *   - packages/core/** (limits are IMPORTED from @luna/core, never moved,
 *     never redefined — task #5 FAIL condition)
 *   - every telegram test, channels.test.ts
 * ALLOWED files: packages/channels/src/adapters/discord.ts; optionally ONE
 * new src module for the magic-byte sniffer (e.g.
 * packages/channels/src/media-sniff.ts); and
 * packages/channels/test/discord-inbound-invariant.test.ts for EXACTLY two
 * additive lines required by the 3a ratchet:
 *   1. CLASSIFICATION map: `fetchAttachment: "outbound"` (the exact-set test
 *      REDs the moment the member lands without it), and
 *   2. SIDE_EFFECT_TOKENS: `"fetchAttachment"` (so the gate-ordering scan
 *      mechanically proves no fetch can precede isInboundAllowed).
 * NAMING TRAP from the same ratchet: any NEW exported interface must NOT be
 * named `Inbound*` — the invariant file's bidirectional payload cross-check
 * requires exported Inbound*-prefixed interfaces to be EXACTLY the dispatch
 * callback payloads. Name the descriptor e.g. `DiscordAttachmentDescriptor`,
 * or keep it un-exported.
 *
 * THE SEAM: one new DiscordTransport member,
 *   readonly fetchAttachment: (url: string, init?: { readonly signal?: AbortSignal }) => Promise<Uint8Array>
 * and `InboundDiscordMessage` gains an optional `attachments` array whose
 * items carry the discord.js Attachment fields this spec's fixtures use:
 * { id, name, size, contentType: string|null, url, proxyURL,
 *   width: number|null, height: number|null } (contentType/width/height are
 * NULL-TOLERANT because discord.js types lie — donor lib/discord/attachments).
 * The FakeInboundAttachment interface below IS that contract (3a precedent).
 *
 * HAZARD H2 (GOAL.md): no test here reads the ambient environment, and the
 * implementation must not either — negative cases are EXPLICITLY injected
 * failing/lying fetchImpls, and every refusal is asserted as an EMITTED
 * transport.send, never a computed-but-unsent string.
 *
 * H4 note: this slice needs NO new metadata keys. If the implementation adds
 * any, they must be namespaced — the invariant file's H4 disjointness scan
 * REDs on a reserved-key collision.
 *
 * CAPACITY PRE-FLIGHT: none required — in-memory fakes only, no network, no
 * LLM seam (deterministic => the N>=5 multi-trial rule does not apply).
 *
 * RED/GREEN inventory at handoff: ALL 16 tests below are RED (the
 * attachment path is entirely absent: no fetch ever happens, no refusal note
 * is ever sent, no ChannelMessage ever carries attachments, and the
 * discordMaxImagePx pin resolves undefined). The stranger HALF of the gate
 * twin test is GREEN-vacuous alone, which is exactly why it shares one test
 * with its allowed-user twin — the twin's fetch assertion is RED today and
 * is what makes the stranger-zero non-vacuous after impl.
 */

/**
 * Test-local contract for the normalized inbound attachment descriptor —
 * field names mirror discord.js `Attachment` so the real transport's
 * normalization is a straight map. See the naming trap above before
 * exporting a type for this from discord.ts.
 */
interface FakeInboundAttachment {
  readonly id: string
  readonly name: string
  /** DECLARED size in bytes (Discord reports it pre-download; may LIE). */
  readonly size: number
  /** Declared MIME. NULL happens in production — must fail CLOSED. */
  readonly contentType: string | null
  /** Direct CDN url. Fetching THIS one is the 403 bug — never used. */
  readonly url: string
  /** Proxy CDN url with auth params. The ONLY legitimate fetch target. */
  readonly proxyURL: string
  readonly width: number | null
  readonly height: number | null
}

const att = (o: Partial<FakeInboundAttachment> = {}): FakeInboundAttachment => ({
  id: "att-1",
  name: "pic.png",
  size: 1024,
  contentType: "image/png",
  url: "https://cdn.discordapp.com/attachments/g1/c1/pic.png",
  proxyURL: "https://media.discordapp.net/attachments/g1/c1/pic.png?ex=68aa1&is=68bb2&hm=deadbeef",
  width: 800,
  height: 600,
  ...o,
})

/** Unique proxy URL per attachment id, auth params intact. */
const proxyFor = (id: string): string =>
  `https://media.discordapp.net/attachments/g1/c1/${id}.png?ex=68aa1&is=68bb2&hm=deadbeef`

/**
 * An InboundDiscordMessage carrying attachments. The cast is the same
 * conditional-widening trick 3b used for `guildId`: `attachments` is not on
 * `InboundDiscordMessage` YET, so the cast keeps the package tsc gate green
 * before the member lands; its behaviour, not its type, is the contract.
 */
const inboundWith = (
  atts: ReadonlyArray<FakeInboundAttachment>,
  o: Partial<InboundDiscordMessage> = {},
): InboundDiscordMessage => ({ ...inbound(o), attachments: atts }) as InboundDiscordMessage

const setup4 = (cfg?: {
  readonly fetchImpl?: (url: string, call: number) => Promise<Uint8Array>
}) => {
  const fake = makeFakeTransport(cfg?.fetchImpl !== undefined ? { fetchImpl: cfg.fetchImpl } : {})
  const received: ChannelMessage[] = []
  const adapter = makeDiscordAdapter({
    id: "d-4",
    transport: fake.transport,
    logLogin: false,
    allowedUsers: ["user-allowed"],
  })
  adapter.setMessageHandler((m) =>
    Effect.sync(() => {
      received.push(m)
    }),
  )
  return { fake, adapter, received }
}

describe("Slice 4 — accepted attachments become ChannelAttachments (task #5)", () => {
  it("GIVEN an allowed image WHEN it arrives THEN it is fetched via the PROXY url (auth params intact, AbortSignal wired) and dispatched as base64", async () => {
    const s = setup4()
    await withStarted(s.adapter, async () => {
      s.fake.fire(inboundWith([att()], { id: "s4-1", content: "look at this" }))
      await tick(50)
    })
    expect(s.received, "the turn dispatched exactly once").toHaveLength(1)
    expect(s.received[0]?.text).toBe("look at this")
    const atts = s.received[0]?.attachments ?? []
    expect(atts, "one ChannelAttachment rides the ChannelMessage to the service").toHaveLength(1)
    expect(atts[0]?.mediaType).toBe("image/png")
    expect(atts[0]?.data, "raw base64 of the downloaded bytes, no data: prefix").toBe(
      Buffer.from(smallPng()).toString("base64"),
    )
    expect(s.fake.fetchCalls, "exactly one download").toHaveLength(1)
    const u = new URL(s.fake.fetchCalls[0]!.url)
    expect(
      u.host,
      "fetch targets the PROXY host, never the direct url (donor 0ca615e: dropped ?ex=&is=&hm= => 403)",
    ).toBe("media.discordapp.net")
    expect(u.searchParams.get("ex"), "proxy auth param preserved").toBe("68aa1")
    expect(u.searchParams.get("is"), "proxy auth param preserved").toBe("68bb2")
    expect(u.searchParams.get("hm"), "proxy auth param preserved").toBe("deadbeef")
    expect(
      s.fake.fetchCalls[0]?.hasAbortSignal,
      "download is bounded by an AbortSignal — the donor's bare no-timeout fetch is refused",
    ).toBe(true)
  })

  it("GIVEN a PDF above the image cap but within MAX_PDF_RAW_BYTES THEN the per-TYPE cap (attachmentByteCap) applies and it is accepted", async () => {
    const declared = MAX_PDF_RAW_BYTES - 1
    expect(declared, "fixture sanity: sits BETWEEN the two caps").toBeGreaterThan(MAX_IMAGE_RAW_BYTES)
    const s = setup4({ fetchImpl: async () => bytesWithMagic(PDF_MAGIC) })
    await withStarted(s.adapter, async () => {
      s.fake.fire(
        inboundWith(
          [
            att({
              name: "report.pdf",
              contentType: "application/pdf",
              size: declared,
              proxyURL: proxyFor("report-pdf"),
              width: null,
              height: null,
            }),
          ],
          { id: "s4-2", content: "read this" },
        ),
      )
      await tick(50)
    })
    const atts = s.received[0]?.attachments ?? []
    expect(atts, "the PDF is dispatched").toHaveLength(1)
    expect(atts[0]?.mediaType).toBe("application/pdf")
    expect(s.fake.fetchCalls).toHaveLength(1)
  })
})

describe("Slice 4 — limits are enforced BEFORE download (task #5 hard requirement)", () => {
  it("GIVEN a disallowed declared type THEN ZERO bytes are fetched, a refusal is EMITTED, and the text still dispatches", async () => {
    const s = setup4()
    await withStarted(s.adapter, async () => {
      s.fake.fire(
        inboundWith([att({ name: "x.zip", contentType: "application/zip" })], {
          id: "s4-3",
          content: "see file",
        }),
      )
      await tick(50)
    })
    expect(s.fake.fetchCalls, "DoS boundary: a refused attachment costs zero bandwidth").toHaveLength(0)
    expect(s.received, "the text turn survives the refusal").toHaveLength(1)
    expect(s.received[0]?.text).toBe("see file")
    expect(s.received[0]?.attachments ?? [], "nothing refused rides to the model").toHaveLength(0)
    expect(s.fake.sent.length, "refusal must be EMITTED, not merely computed (H2)").toBeGreaterThanOrEqual(1)
    expect(s.fake.sent[0]?.channelId).toBe("chan-1")
    expect((s.fake.sent[0]?.content ?? "").length).toBeGreaterThan(0)
  })

  it("GIVEN a NULL declared contentType (discord.js lies) THEN it fails CLOSED: no fetch, an emitted note, text dispatches", async () => {
    const s = setup4()
    await withStarted(s.adapter, async () => {
      s.fake.fire(
        inboundWith([att({ name: "mystery.bin", contentType: null })], {
          id: "s4-3b",
          content: "what is this",
        }),
      )
      await tick(50)
    })
    expect(s.fake.fetchCalls, "unknown declared type is refused pre-download").toHaveLength(0)
    expect(s.received).toHaveLength(1)
    expect(s.received[0]?.attachments ?? []).toHaveLength(0)
    expect(s.fake.sent.length, "fail-closed still tells the user").toBeGreaterThanOrEqual(1)
  })

  it("GIVEN a DECLARED size over MAX_IMAGE_RAW_BYTES THEN no fetch happens; AT the cap the download proceeds (inclusive, telegram parity)", async () => {
    const s = setup4()
    await withStarted(s.adapter, async () => {
      s.fake.fire(
        inboundWith([att({ size: MAX_IMAGE_RAW_BYTES + 1 })], { id: "s4-4a", content: "too big" }),
      )
      await tick(50)
      expect(s.fake.fetchCalls, "over-cap: refused on DECLARED size, zero fetches").toHaveLength(0)
      expect(s.fake.sent.length, "over-cap refusal emitted").toBeGreaterThanOrEqual(1)
      s.fake.fire(
        inboundWith([att({ id: "att-boundary", size: MAX_IMAGE_RAW_BYTES, proxyURL: proxyFor("boundary") })], {
          id: "s4-4b",
          content: "at the cap",
        }),
      )
      await tick(50)
      expect(s.fake.fetchCalls, "at-cap: fetched — the cap is inclusive, like telegram's `> cap`").toHaveLength(1)
    })
    expect(s.received, "both turns dispatched").toHaveLength(2)
  })

  it("GIVEN more than MAX_ATTACHMENTS_PER_TURN attachments THEN the FIRST cap's-worth are processed and the rest refused UNFETCHED with a note", async () => {
    // Bounding semantics pinned here (task #5 says "bounded"; the plan does
    // not choose): FIRST-N processed in arrival order, remainder refused with
    // an emitted note. Total refusal of the whole turn would violate the
    // no-silent-whole-turn-drop rule for the N valid ones.
    const count = MAX_ATTACHMENTS_PER_TURN + 2
    const atts = Array.from({ length: count }, (_, i) => att({ id: `a${i}`, proxyURL: proxyFor(`a${i}`) }))
    const s = setup4()
    await withStarted(s.adapter, async () => {
      s.fake.fire(inboundWith(atts, { id: "s4-5", content: "album" }))
      await tick(80)
    })
    expect(s.fake.fetchCalls, "exactly the cap's worth of downloads").toHaveLength(MAX_ATTACHMENTS_PER_TURN)
    expect(
      s.fake.fetchCalls.map((c) => new URL(c.url).pathname),
      "and they are the FIRST N, in arrival order",
    ).toEqual(atts.slice(0, MAX_ATTACHMENTS_PER_TURN).map((a) => new URL(a.proxyURL).pathname))
    expect(s.received[0]?.attachments ?? []).toHaveLength(MAX_ATTACHMENTS_PER_TURN)
    expect(s.fake.sent.length, "overflow refusal emitted").toBeGreaterThanOrEqual(1)
  })

  it("GIVEN images whose DECLARED sizes cumulatively exceed MAX_TURN_RAW_BYTES THEN the excess attachment is refused with no fetch", async () => {
    // 0.4x the turn cap each: two fit (0.8x), the third breaches (1.2x).
    // Expressed as a fraction of the imported constant so this fixture tracks
    // @luna/core rather than hardcoding a rival copy of the limit.
    const each = Math.floor(MAX_TURN_RAW_BYTES * 0.4)
    expect(each, "fixture sanity: each fits the per-image cap").toBeLessThanOrEqual(MAX_IMAGE_RAW_BYTES)
    const atts = [0, 1, 2].map((i) => att({ id: `t${i}`, size: each, proxyURL: proxyFor(`t${i}`) }))
    const s = setup4()
    await withStarted(s.adapter, async () => {
      s.fake.fire(inboundWith(atts, { id: "s4-6", content: "batch" }))
      await tick(80)
    })
    expect(s.fake.fetchCalls, "turn budget gates on declared sizes BEFORE download").toHaveLength(2)
    expect(s.received[0]?.attachments ?? [], "the two within budget still ride").toHaveLength(2)
    expect(s.fake.sent.length, "turn-budget refusal emitted").toBeGreaterThanOrEqual(1)
  })
})

describe("Slice 4 — post-download defence (metadata lies, magic bytes)", () => {
  it("GIVEN a declared size that LIES WHEN actual bytes exceed the cap THEN the attachment is refused post-download and never dispatched", async () => {
    const s = setup4({ fetchImpl: async () => bytesWithMagic(PNG_MAGIC, MAX_IMAGE_RAW_BYTES + 1) })
    await withStarted(s.adapter, async () => {
      s.fake.fire(inboundWith([att({ size: 1000 })], { id: "s4-7", content: "trust me" }))
      await tick(80)
    })
    expect(s.fake.fetchCalls, "the lie passes the cheap declared-size gate, so the fetch happens").toHaveLength(1)
    expect(s.received, "the turn survives").toHaveLength(1)
    expect(s.received[0]?.attachments ?? [], "actual-byte defence: the liar never rides").toHaveLength(0)
    expect(s.fake.sent.length, "refusal emitted").toBeGreaterThanOrEqual(1)
  })

  it("GIVEN declared image/png WHEN the magic bytes match no allowed type THEN sniff-after-download refuses it (never trust client Content-Type)", async () => {
    const s = setup4({
      fetchImpl: async () => new TextEncoder().encode("#!/bin/sh\necho definitely-not-a-png"),
    })
    await withStarted(s.adapter, async () => {
      s.fake.fire(inboundWith([att()], { id: "s4-8", content: "totally a png" }))
      await tick(50)
    })
    expect(s.fake.fetchCalls).toHaveLength(1)
    expect(s.received).toHaveLength(1)
    expect(s.received[0]?.attachments ?? [], "unsniffable bytes never reach the model").toHaveLength(0)
    expect(s.fake.sent.length, "sniff refusal emitted").toBeGreaterThanOrEqual(1)
  })
})

describe("Slice 4 — download failure never fails the turn (no silent drop, no raw errors)", () => {
  it("GIVEN one failing and one healthy download THEN the turn continues with the survivor, a note is emitted, and the raw Error NEVER reaches the channel", async () => {
    const SENTINEL = "SENTINEL-S4-RAW-ERROR-do-not-leak"
    const s = setup4({
      fetchImpl: async (url) => {
        if (url.includes("boom")) throw new Error(`ECONNRESET ${SENTINEL}`)
        return smallPng()
      },
    })
    await withStarted(s.adapter, async () => {
      s.fake.fire(
        inboundWith(
          [att({ id: "f1", proxyURL: proxyFor("boom") }), att({ id: "f2", proxyURL: proxyFor("fine") })],
          { id: "s4-9", content: "mixed bag" },
        ),
      )
      await tick(80)
    })
    expect(s.received, "download failure must not fail the turn").toHaveLength(1)
    expect(s.received[0]?.text).toBe("mixed bag")
    expect(s.received[0]?.attachments ?? [], "the healthy attachment still rides").toHaveLength(1)
    expect(s.fake.sent.length, "the user is told about the failure").toBeGreaterThanOrEqual(1)
    expect(
      s.fake.sent.map((x) => x.content).join("\n"),
      "raw Error.message never reaches the channel (same discipline as 3a's A5)",
    ).not.toContain(SENTINEL)
  })

  it("GIVEN an attachments-only message WHOSE downloads all fail THEN an explicit failure notice is emitted and NOTHING dispatches to the model", async () => {
    const SENTINEL = "SENTINEL-S4-ONLY-do-not-leak"
    const s = setup4({
      fetchImpl: async () => {
        throw new Error(SENTINEL)
      },
    })
    await withStarted(s.adapter, async () => {
      s.fake.fire(inboundWith([att()], { id: "s4-10", content: "" }))
      await tick(80)
    })
    expect(s.fake.sent.length, "a silent whole-turn drop is forbidden — explicit notice").toBeGreaterThanOrEqual(1)
    expect(s.fake.sent.map((x) => x.content).join("\n")).not.toContain(SENTINEL)
    expect(s.received, "an empty turn (no text, no attachments) must not reach the model").toHaveLength(0)
  })
})

describe("Slice 4 — the gate precedes every download (post-gate side effect)", () => {
  it("GATE: a stranger's attachment is NEVER fetched — zero transport activity (control twinned with the allowed-user fetch that makes it non-vacuous)", async () => {
    const s = setup4()
    const fixture = [att()]
    await withStarted(s.adapter, async () => {
      s.fake.fire(inboundWith(fixture, { id: "s4-g1", authorId: "attacker", content: "download this" }))
      await tick(50)
      // Mirror of telegram-adapter.test.ts's :708 rail: no bandwidth for
      // strangers, and no refusal note either — the gate is SILENT.
      expect(s.fake.fetchCalls, "no fetch for a stranger, ever").toHaveLength(0)
      expect(s.fake.sent, "no note for a stranger — silence, not an oracle").toHaveLength(0)
      expect(s.received).toHaveLength(0)
      // Non-vacuity TWIN (RED today): the IDENTICAL fixture is fetched once
      // the author is allowed, proving the zero above measures the gate and
      // not the absence of download code.
      s.fake.fire(inboundWith(fixture, { id: "s4-g2", authorId: "user-allowed", content: "download this" }))
      await tick(50)
      expect(s.fake.fetchCalls, "twin: the same fixture downloads post-gate").toHaveLength(1)
    })
  })
})

describe("Slice 4 — CDN downscale before the bytes move (donor gotchas)", () => {
  it("pins the Discord resize constant: discordMaxImagePx === 1568 (donor MAX_IMAGE_PX; adapter-LOCAL on purpose — it is a Discord-CDN knob, not an @luna/core ingestion limit)", async () => {
    // tsc-green RED pin shape (module namespace needs the double cast).
    const mod = (await import("../src/adapters/discord.js")) as unknown as Record<string, unknown>
    expect(mod["discordMaxImagePx"]).toBe(1568)
  })

  it("GIVEN an image with dims over the 1568 box THEN the fetch URL carries CDN ?width=&height= scaled into the box, auth params intact", async () => {
    const s = setup4()
    await withStarted(s.adapter, async () => {
      // 4000x2000 scales by 1568/4000 exactly: width=1568, height=784 (the
      // fixture divides cleanly so no rounding technique is pinned).
      s.fake.fire(inboundWith([att({ width: 4000, height: 2000 })], { id: "s4-13", content: "wide" }))
      await tick(50)
    })
    expect(s.fake.fetchCalls).toHaveLength(1)
    const u = new URL(s.fake.fetchCalls[0]!.url)
    expect(u.searchParams.get("width"), "longest edge capped at discordMaxImagePx").toBe("1568")
    expect(u.searchParams.get("height"), "aspect preserved").toBe("784")
    expect(u.searchParams.get("hm"), "resize params must not clobber the auth params").toBe("deadbeef")
  })

  it("GIVEN dims within the box or UNKNOWN (null) THEN no resize params — and null dims still download (null-tolerant: discord.js types lie)", async () => {
    const s = setup4()
    await withStarted(s.adapter, async () => {
      s.fake.fire(inboundWith([att({ id: "small", proxyURL: proxyFor("small") })], { id: "s4-14a", content: "small" }))
      await tick(50)
      s.fake.fire(
        inboundWith([att({ id: "nodims", proxyURL: proxyFor("nodims"), width: null, height: null })], {
          id: "s4-14b",
          content: "no dims",
        }),
      )
      await tick(50)
    })
    expect(s.fake.fetchCalls, "null dimensions are not an error — the fetch proceeds un-resized").toHaveLength(2)
    for (const c of s.fake.fetchCalls) {
      const u = new URL(c.url)
      expect(u.searchParams.has("width"), `no width param on ${u.pathname}`).toBe(false)
      expect(u.searchParams.has("height"), `no height param on ${u.pathname}`).toBe(false)
    }
  })

  it("NEVER resizes GIFs regardless of size (donor: flattening animation is destructive surprise behavior) — passed through unmodified", async () => {
    const s = setup4({ fetchImpl: async () => bytesWithMagic(GIF_MAGIC) })
    await withStarted(s.adapter, async () => {
      s.fake.fire(
        inboundWith(
          [att({ name: "anim.gif", contentType: "image/gif", width: 4000, height: 2000, proxyURL: proxyFor("anim-gif") })],
          { id: "s4-15", content: "gif" },
        ),
      )
      await tick(50)
    })
    expect(s.fake.fetchCalls).toHaveLength(1)
    const u = new URL(s.fake.fetchCalls[0]!.url)
    expect(u.searchParams.has("width"), "no CDN resize for GIFs, ever").toBe(false)
    expect(u.searchParams.has("height"), "no CDN resize for GIFs, ever").toBe(false)
    expect(s.received[0]?.attachments?.[0]?.mediaType).toBe("image/gif")
  })
})

/* -------------------------------------------------------------------------- */
/* SLICE 5 (task #6) — reply quote capture rendered into the user text        */
/* -------------------------------------------------------------------------- */

/**
 * SLICE 5 SPEC — Given an inbound Discord message that REPLIES to an earlier
 * message, when the allowlist gate accepts it, then the replied-to message is
 * resolved through the transport seam (cache-first then network in the REAL
 * transport) and its content is rendered into the user text with the donor's
 * VERBATIM template (sol gateway.ts reply block):
 *
 *     [Replying to ${repliedAuthor}: "${quoted}"]\n\n${userMessage}
 *
 * with author resolution VERBATIM:
 *     refMsg.author?.displayName ?? refMsg.author?.username ?? "Someone"
 *
 * DIRECT PORT plus exactly FOUR prescribed fixes, no more:
 *   1. the donor's `.slice(0, 500)` becomes its own truncateCodePoints
 *      helper (donor wrote it and then did not use it here) — a split
 *      surrogate earns a 400 from Discord;
 *   2. a truncation marker (single ellipsis char U+2026) when clipped;
 *   3. CROSS-CHANNEL references are skipped WITH a log line and NEVER
 *      fetched (a fetch there is a read outside the gated channel);
 *   4. a fetch FAILURE logs one line (the donor's `.catch(() => null)` made
 *      missing READ_MESSAGE_HISTORY indistinguishable from a deleted
 *      parent); behavior stays best-effort — no quote, message processed.
 *
 * ORDERING PORTED FROM THE DONOR: `replyToMsgId` is captured from
 * `message.reference` BEFORE the fetch, so it survives a deleted parent
 * (session-resume ordering). WHAT THIS SPEC PINS for that ordering: the
 * ChannelMessage metadata contract (`Readonly<Record<string, unknown>>`,
 * types.ts FROZEN and already sufficient) carries `replyToMsgId`, and the
 * deleted-parent test asserts it rides even when the seam resolves null —
 * capture-before-fetch made observable without new types.
 *
 * INVARIANT: the reference fetch is a side effect and runs only AFTER
 * `isInboundAllowed`. The stranger test asserts a ZERO Proxy-log delta.
 *
 * OUT OF SCOPE — the implementation for this scenario must NOT modify:
 *   - packages/channels/src/service.ts, delivery.ts, types.ts, dedup.ts,
 *     commands.ts, index.ts, chat-server.ts
 *   - packages/channels/src/adapters/telegram.ts and every telegram test
 *   - packages/channels/test/channels.test.ts
 * ALLOWED: packages/channels/src/adapters/discord.ts, and EXACTLY two
 * additive lines in discord-inbound-invariant.test.ts required by the 3a
 * ratchet (3b/4 precedent): CLASSIFICATION `fetchReferencedMessage:
 * "outbound"` and SIDE_EFFECT_TOKENS `"fetchReferencedMessage"`.
 * NAMING TRAP: the seam's payload type must NOT be named `Inbound*` (the
 * ratchet's bidirectional cross-check) — `DiscordReferencedMessage`.
 *
 * THE SEAM: one new DiscordTransport member,
 *   readonly fetchReferencedMessage: (channelId: string, messageId: string)
 *     => Promise<DiscordReferencedMessage | null>
 * and `InboundDiscordMessage` gains an optional
 *   `reference?: { messageId: string; channelId: string } | undefined`
 * (discord.js MessageReference fields this spec's fixtures use).
 *
 * CAPACITY PRE-FLIGHT: none required — in-memory fakes only, no network, no
 * LLM seam (deterministic => the N>=5 multi-trial rule does not apply).
 *
 * RED/GREEN inventory at handoff: ALL 8 tests below are RED (no reference is
 * ever fetched, no quote is ever rendered, no metadata.replyToMsgId exists).
 * The stranger HALF of test 8 is GREEN-vacuous alone, which is why it shares
 * one test with its allowed-user twin — the twin's fetch assertion is RED
 * today and makes the stranger-zero non-vacuous after impl.
 */

/** An InboundDiscordMessage replying to `parentMessageId`. Same conditional-
 * widening cast as `inboundWith` (Slice 4): `reference` is not on
 * `InboundDiscordMessage` YET; behaviour, not type, is the contract. */
const replyTo = (
  parentMessageId: string,
  o: Partial<InboundDiscordMessage> = {},
  referenceChannelId?: string,
): InboundDiscordMessage => {
  const base = inbound(o)
  return {
    ...base,
    reference: { messageId: parentMessageId, channelId: referenceChannelId ?? base.channelId },
  } as InboundDiscordMessage
}

/**
 * True when `s` contains a lone (unpaired) surrogate — the split-surrogate
 * defect a UTF-16 `.slice` produces. Hand-rolled because the package
 * tsconfig's lib predates ES2024's String.prototype.isWellFormed (tsconfig
 * is FROZEN for this slice).
 */
const hasLoneSurrogate = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++ // valid pair: skip the low half
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

const setup5 = (cfg?: {
  readonly refMsgImpl?: (
    channelId: string,
    messageId: string,
    call: number,
  ) => Promise<FakeReferencedMessage | null>
}) => {
  const fake = makeFakeTransport(cfg?.refMsgImpl !== undefined ? { refMsgImpl: cfg.refMsgImpl } : {})
  const received: ChannelMessage[] = []
  const adapter = makeDiscordAdapter({
    id: "d-5",
    transport: fake.transport,
    logLogin: false,
    allowedUsers: ["user-allowed"],
  })
  adapter.setMessageHandler((m) =>
    Effect.sync(() => {
      received.push(m)
    }),
  )
  return { fake, adapter, received }
}

describe("Slice 5 — reply quote rendered into the user text (task #6)", () => {
  it("1. GIVEN a same-channel reply THEN the user text gains the VERBATIM donor template quote prefix (author displayName path) via ONE seam fetch", async () => {
    const s = setup5()
    await withStarted(s.adapter, async () => {
      s.fake.fire(replyTo("p1", { id: "s5-1", content: "can you summarize this?" }))
      await tick(50)
    })
    expect(s.received, "the turn dispatched exactly once").toHaveLength(1)
    expect(s.received[0]?.text, "donor template, byte-for-byte").toBe(
      '[Replying to Riven: "deploy is done, ready for review"]\n\ncan you summarize this?',
    )
    expect(s.fake.refFetchCalls, "exactly one reference fetch through the seam").toEqual([
      { channelId: "chan-1", messageId: "p1" },
    ])
  })

  it("2. author fallback chain: no displayName => username; no author at all => \"Someone\"", async () => {
    const s = setup5({
      refMsgImpl: async (_c, messageId) =>
        messageId === "p-username"
          ? { content: "ship it", author: { username: "riven_writes" } }
          : { content: "who said this", author: null },
    })
    await withStarted(s.adapter, async () => {
      s.fake.fire(replyTo("p-username", { id: "s5-2a", content: "ok" }))
      await tick(50)
      s.fake.fire(replyTo("p-noauthor", { id: "s5-2b", content: "hm" }))
      await tick(50)
    })
    expect(s.received).toHaveLength(2)
    expect(s.received[0]?.text).toBe('[Replying to riven_writes: "ship it"]\n\nok')
    expect(s.received[1]?.text).toBe('[Replying to Someone: "who said this"]\n\nhm')
  })

  it("3. long parent content is clipped at 500 CODE POINTS (truncateCodePoints, never .slice) + U+2026 marker — no split surrogate", async () => {
    // 499 BMP chars then two astral chars: 501 code points, 503 UTF-16 units.
    // The donor's `.slice(0, 500)` cuts INSIDE the first astral char — the
    // fixture proves that trap is real, then the impl must avoid it.
    const ASTRAL = "\u{1F600}" // one code point, TWO UTF-16 units
    const parentContent = "x".repeat(499) + ASTRAL + ASTRAL
    expect([...parentContent].length, "fixture sanity: 501 code points").toBe(501)
    expect(
      hasLoneSurrogate(parentContent.slice(0, 500)),
      "fixture sanity: naive .slice(0,500) DOES split the surrogate (the donor bug)",
    ).toBe(true)
    const s = setup5({
      refMsgImpl: async () => ({ content: parentContent, author: { displayName: "Riven" } }),
    })
    await withStarted(s.adapter, async () => {
      s.fake.fire(replyTo("p-long", { id: "s5-3", content: "tldr?" }))
      await tick(50)
    })
    expect(s.received).toHaveLength(1)
    const expectedQuote = "x".repeat(499) + ASTRAL + "…"
    expect(s.received[0]?.text, "clip at 500 code points, whole astral char kept, marker appended").toBe(
      `[Replying to Riven: "${expectedQuote}"]\n\ntldr?`,
    )
    expect(
      hasLoneSurrogate(s.received[0]?.text ?? ""),
      "no lone surrogate anywhere in the rendered text",
    ).toBe(false)
  })

  it("4. parent content AT the bound (500 code points) is quoted verbatim with NO truncation marker", async () => {
    const parentContent = "y".repeat(500)
    const s = setup5({
      refMsgImpl: async () => ({ content: parentContent, author: { displayName: "Riven" } }),
    })
    await withStarted(s.adapter, async () => {
      s.fake.fire(replyTo("p-exact", { id: "s5-4", content: "noted" }))
      await tick(50)
    })
    expect(s.received).toHaveLength(1)
    expect(s.received[0]?.text).toBe(`[Replying to Riven: "${parentContent}"]\n\nnoted`)
    expect(s.received[0]?.text, "no marker when nothing was clipped").not.toContain("…")
  })

  it("5. CROSS-CHANNEL reference: ZERO fetches (never a read outside the gated channel), no quote, ONE log line, message still dispatched", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const s = setup5()
      await withStarted(s.adapter, async () => {
        s.fake.fire(replyTo("p-cross", { id: "s5-5", content: "what about this?" }, "chan-OTHER"))
        await tick(50)
      })
      expect(s.fake.refFetchCalls, "cross-channel is a SKIP, never a fetch").toHaveLength(0)
      expect(s.received, "best-effort: the message still dispatches").toHaveLength(1)
      expect(s.received[0]?.text, "no quote").toBe("what about this?")
      const lines = warn.mock.calls.filter((c) => /cross-channel/.test(c.join(" ")))
      expect(lines, "exactly one skip log line").toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it("6. fetch FAILURE (seam rejects): no quote, ONE log line (never the donor's silent conflation), message still dispatched", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const s = setup5({
        refMsgImpl: async () => {
          throw new Error("Missing Access")
        },
      })
      await withStarted(s.adapter, async () => {
        s.fake.fire(replyTo("p-fail", { id: "s5-6", content: "still here" }))
        await tick(50)
      })
      expect(s.fake.refFetchCalls, "the fetch was attempted").toHaveLength(1)
      expect(s.received, "best-effort: the turn survives the failed fetch").toHaveLength(1)
      expect(s.received[0]?.text, "no quote on failure").toBe("still here")
      const lines = err.mock.calls.filter((c) => /reference fetch failed/.test(c.join(" ")))
      expect(lines, "exactly one failure log line").toHaveLength(1)
    } finally {
      err.mockRestore()
    }
  })

  it("7. DELETED parent (seam resolves null): no quote, message dispatched, and replyToMsgId — captured BEFORE the fetch — still rides metadata", async () => {
    const s = setup5({ refMsgImpl: async () => null })
    await withStarted(s.adapter, async () => {
      s.fake.fire(replyTo("p-deleted", { id: "s5-7", content: "reviving this thread" }))
      await tick(50)
    })
    expect(s.fake.refFetchCalls).toHaveLength(1)
    expect(s.received).toHaveLength(1)
    expect(s.received[0]?.text, "a deleted parent quotes nothing").toBe("reviving this thread")
    // THE PINNED ORDERING (donor port): replyToMsgId comes from
    // message.reference BEFORE the fetch, so a deleted parent cannot erase
    // it — asserted on the metadata contract types.ts already carries.
    expect(s.received[0]?.metadata?.["replyToMsgId"], "capture-before-fetch survives a deleted parent").toBe(
      "p-deleted",
    )
  })

  it("8. GATE: a stranger's reply causes ZERO reference fetches — empty Proxy-log delta (twinned with the allowed-user fetch that makes it non-vacuous)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const s = setup5()
      await withStarted(s.adapter, async () => {
        const before = s.fake.log.length
        s.fake.fire(replyTo("p-str", { id: "s5-8a", authorId: "attacker", content: "quote me" }))
        await tick(50)
        expect(s.fake.log.length, "ZERO transport calls for a stranger — Proxy log delta empty").toBe(before)
        expect(s.fake.refFetchCalls, "no reference fetch for a stranger, ever").toHaveLength(0)
        expect(s.received, "no dispatch for a stranger").toHaveLength(0)
        // Non-vacuity TWIN (RED today): the IDENTICAL fixture fetches once
        // the author is allowed, proving the zero above measures the gate
        // and not the absence of reply-quote code.
        s.fake.fire(replyTo("p-str", { id: "s5-8b", content: "quote me" }))
        await tick(50)
        expect(s.fake.refFetchCalls, "twin: the same fixture fetches post-gate").toHaveLength(1)
      })
    } finally {
      warn.mockRestore()
    }
  })
})
