/**
 * SLICE 3a — INBOUND INVARIANT (mechanical, source-level).
 *
 * THE INVARIANT: every inbound entry point on the Discord transport routes
 * through the single fail-closed gate (`isInboundAllowed`) BEFORE its first
 * side effect. gate -> ack -> dispatch. This is settled (lead ruling R1), not
 * an open question: no ack for strangers, ever — an ack is a side effect and
 * a pre-gate ack is an "is something listening" oracle at a shell boundary.
 *
 * This file is a RATCHET, not a behavior test (behavior lives in
 * discord-adapter.test.ts). It totally enumerates the transport's entrances
 * so that a FUTURE entrance (onReaction, onThreadCreate, ...) cannot be added
 * without (a) classifying it here and (b) passing the ordering scan.
 *
 * OUT OF SCOPE — the implementation for this scenario must NOT modify:
 *   - packages/channels/src/service.ts, delivery.ts, types.ts, dedup.ts,
 *     commands.ts, index.ts
 *   - packages/channels/src/adapters/telegram.ts and every telegram test
 *   - packages/channels/test/channels.test.ts
 *   - this file and discord-adapter.test.ts (the spec is frozen)
 * The ONLY production file in scope is packages/channels/src/adapters/discord.ts.
 * (This file READS telegram.ts and service.ts sources; reading is not scope.)
 *
 * KNOWN BLIND SPOTS of the lexical scans below (documented per advisor ruling
 * 5 — a scan that overclaims is worse than none):
 *   1. INDIRECTION: a side effect buried in a helper whose name is not in
 *      SIDE_EFFECT_TOKENS is invisible. The token list names the primitives
 *      that exist today; a new effectful primitive must be added to the list.
 *   2. TOKENS ARE WORDS, NOT SEMANTICS: matching is word-boundary regex over
 *      comment-stripped source. Deliberately NO bare `ack` token — it would
 *      match `callback`/`track`; the full member name is matched instead.
 *   3. COMMENT STRIPPING IS NAIVE: `//` preceded by a non-`:` non-space char
 *      survives (protects `https://` in strings) and block-comment stripping
 *      is non-greedy. A `*` / `/` sequence inside a string literal could
 *      confuse it. Acceptable for this file's shapes; re-verify if discord.ts
 *      grows string literals containing comment markers.
 *   4. THE SCAN PROVES ORDER OF APPEARANCE, NOT ORDER OF EXECUTION. Runtime
 *      ordering (ack awaited before dispatch fork, via the one Proxy call
 *      log) is asserted in discord-adapter.test.ts, not here.
 *
 * CAPACITY PRE-FLIGHT: none required — pure source analysis, no network, no
 * LLM seam (deterministic => no multi-trial parametrization applies).
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(path.join(here, rel), "utf8")

const discordSrc = read("../src/adapters/discord.ts")
const telegramSrc = read("../src/adapters/telegram.ts")
const serviceSrc = read("../src/service.ts")

/* -------------------------------------------------------------------------- */
/* Scan machinery                                                              */
/* -------------------------------------------------------------------------- */

/** Return the `{ ... }` block starting at the first `{` at/after `from`. */
const braceBlock = (src: string, from: number): string => {
  const open = src.indexOf("{", from)
  if (open === -1) throw new Error("braceBlock: no opening brace")
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error("braceBlock: unbalanced braces")
}

/** Strip comments (see header blind spot 3 for the deliberate naivety). */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\S]|\s)\/\/.*$/gm, "$1")

/** Member names declared on an interface block. */
const interfaceMembers = (src: string, name: string): string[] => {
  const decl = src.indexOf(`export interface ${name} `)
  expect(decl, `interface ${name} must exist in discord.ts`).toBeGreaterThanOrEqual(0)
  const block = stripComments(braceBlock(src, decl))
  return [...block.matchAll(/^\s*readonly (\w+)\s*:/gm)].map((m) => m[1]!)
}

/** Body of a file-level `const <name> = (...) => { ... }` named function. */
const namedFnBody = (src: string, name: string): string => {
  const decl = src.indexOf(`const ${name} = `)
  expect(decl, `named function ${name} must exist at file level`).toBeGreaterThanOrEqual(0)
  const arrow = src.indexOf("=>", decl)
  expect(arrow, `${name} must be an arrow function`).toBeGreaterThanOrEqual(0)
  return stripComments(braceBlock(src, arrow))
}

/** Object-literal keys inside a `{...}` block (values never carry `key:`). */
const literalKeys = (block: string): string[] =>
  [...stripComments(block).matchAll(/(\w+)\s*:/g)].map((m) => m[1]!)

/* -------------------------------------------------------------------------- */
/* The classification map — EVERY transport member must appear here            */
/* -------------------------------------------------------------------------- */

/**
 * inbound-dispatch: registers a callback that receives USER-CONTROLLED content
 *   and can reach the agent (and therefore the shell). MUST pass the gate scan.
 * lifecycle-callback: registers a callback whose payload is not user-addressed
 *   content (ready tag, transport error) and which must never dispatch.
 * lifecycle / outbound: not callback registration at all.
 */
const CLASSIFICATION: Record<string, "inbound-dispatch" | "lifecycle-callback" | "lifecycle" | "outbound"> = {
  onMessage: "inbound-dispatch",
  onInteraction: "inbound-dispatch",
  onReady: "lifecycle-callback",
  onError: "lifecycle-callback",
  login: "lifecycle",
  destroy: "lifecycle",
  send: "outbound",
  edit: "outbound",
  sendTyping: "outbound",
  ackInteractionEphemeral: "outbound",
  registerGuildCommands: "outbound",
  fetchAttachment: "outbound",
  fetchReferencedMessage: "outbound",
}

/**
 * The effectful primitives reachable from an inbound handler today. A handler
 * body must not contain ANY of these before `isInboundAllowed`. Word-boundary
 * matched; deliberately no bare `ack` (blind spot 2).
 */
const SIDE_EFFECT_TOKENS = [
  "startTyping",
  "runFork",
  "runPromise",
  "ackInteractionEphemeral",
  "sendTyping",
  "fetchAttachment",
  "fetchReferencedMessage",
  "noteDrop", // drop-logging a message the gate has not REJECTED is also pre-gate observation
] as const

describe("discord inbound invariant — total enumeration", () => {
  const members = interfaceMembers(discordSrc, "DiscordTransport")

  it("classification map is exhaustive and exact against DiscordTransport (new entrances must register here)", () => {
    // Bidirectional: no member without a classification, no classification
    // without a member. TODAY this is RED: the map requires onInteraction and
    // ackInteractionEphemeral, which the interface does not yet declare.
    expect([...members].sort()).toEqual(Object.keys(CLASSIFICATION).sort())
  })

  it("EXACT-SET: the inbound dispatch surface is onInteraction + onMessage and NOTHING else", () => {
    const declared = members.filter((m) => CLASSIFICATION[m] === "inbound-dispatch").sort()
    // RED today (only onMessage exists). GREEN exactly when the second gated
    // path exists — and RED AGAIN the day anyone adds a third path without
    // bringing it through this file.
    expect(declared).toEqual(["onInteraction", "onMessage"])
  })

  it("bidirectional payload cross-check: Inbound* exported types <=> inbound-dispatch callback payloads", () => {
    const inboundTypes = [...discordSrc.matchAll(/export interface (Inbound\w+)\b/g)]
      .map((m) => m[1]!)
      .sort()
    const decl = discordSrc.indexOf("export interface DiscordTransport ")
    const block = stripComments(braceBlock(discordSrc, decl))
    const dispatchPayloads = members
      .filter((m) => CLASSIFICATION[m] === "inbound-dispatch")
      .map((m) => {
        const sig = new RegExp(`readonly ${m}\\s*:\\s*\\(cb:\\s*\\(\\w+:\\s*(\\w+)\\)`).exec(block)
        expect(sig, `${m} must take a cb whose payload is a named type`).not.toBeNull()
        return sig![1]!
      })
      .sort()
    // Every inbound payload type is Inbound-prefixed…
    for (const t of dispatchPayloads) {
      expect(t, "inbound payloads use the Inbound* naming convention").toMatch(/^Inbound/)
    }
    // …and the exported Inbound* types are EXACTLY the dispatch payloads:
    // an Inbound* type nothing dispatches is a lie, an un-prefixed payload
    // hides an entrance from the naming convention this scan keys on.
    expect(inboundTypes).toEqual([...new Set(dispatchPayloads)].sort())
  })
})

describe("discord inbound invariant — gate-before-side-effect ordering scan", () => {
  const members = interfaceMembers(discordSrc, "DiscordTransport")
  const dispatchMembers = [
    ...new Set([
      ...members.filter((m) => CLASSIFICATION[m] === "inbound-dispatch"),
      // Scan the REQUIRED surface even while the interface lags, so this
      // block reports the missing registration rather than vacuously passing.
      "onMessage",
      "onInteraction",
    ]),
  ]

  it.each(dispatchMembers)(
    "%s is registered with a file-level NAMED handler, and the gate precedes every side-effect token in it",
    (member) => {
      // Registration must be `t.<member>(<name>)` — a named function is what
      // makes this scan (and the auditor's reproduction of it) possible.
      const reg = new RegExp(`\\bt\\.${member}\\((\\w+)\\)`).exec(stripComments(discordSrc))
      expect(
        reg,
        `start() must register a file-level NAMED function via t.${member}(name)`,
      ).not.toBeNull()
      const body = namedFnBody(discordSrc, reg![1]!)
      const gateIdx = body.search(/\bisInboundAllowed\b/)
      expect(gateIdx, `${reg![1]} must call isInboundAllowed`).toBeGreaterThanOrEqual(0)
      for (const token of SIDE_EFFECT_TOKENS) {
        const idx = body.search(new RegExp(`\\b${token}\\b`))
        if (idx === -1) continue
        // noteDrop is the one token ALLOWED only on the rejection path, which
        // in source order still sits after the gate call — covered by the
        // same inequality.
        expect(
          idx,
          `${reg![1]}: side effect '${token}' appears BEFORE the isInboundAllowed gate`,
        ).toBeGreaterThan(gateIdx)
      }
    },
  )

  it("lifecycle callbacks never dispatch: onReady/onError registrations contain no dispatch or gate tokens", () => {
    const src = stripComments(discordSrc)
    for (const member of ["onReady", "onError"]) {
      const reg = new RegExp(`\\bt\\.${member}\\(`).exec(src)
      expect(reg, `t.${member} is registered in start()`).not.toBeNull()
      // The registered callback for these is inline and tiny; scan the call's
      // argument region (to the registration's closing line) for tokens.
      const region = src.slice(reg!.index, src.indexOf("})", reg!.index) + 2)
      for (const token of ["runFork", "toChannelMessage", "isInboundAllowed"]) {
        expect(region.includes(token), `${member} must not ${token}`).toBe(false)
      }
    }
  })
})

describe("discord inbound invariant — H4 metadata/address disjointness (control ratchet)", () => {
  // service.ts buildDeliveryTarget spreads inbound metadata into the reply
  // ADDRESS after the reserved keys, so any metadata key that collides with a
  // reserved key REROUTES THE REPLY (hazard H4). The spread-order fix rides
  // with Slice 3b; what 3a must guarantee is that no adapter MANUFACTURES a
  // colliding key — and that the interaction token (a ~15-minute
  // post-as-the-bot capability) never becomes metadata at all.
  const addressDecl = serviceSrc.indexOf("address: {")
  const reservedKeys = literalKeys(braceBlock(serviceSrc, addressDecl)).filter(
    (k) => k !== "metadata", // from the `msg.metadata ?? {}` spread expression
  )

  const metadataBlocks = (src: string): string[] => {
    const blocks: string[] = []
    for (const m of src.matchAll(/metadata:\s*\{/g)) blocks.push(braceBlock(src, m.index))
    return blocks
  }

  it("reserved address keys are what H4 says they are", () => {
    expect([...reservedKeys].sort()).toEqual(["channelId", "senderId", "threadingKey", "transport"])
  })

  it("no metadata literal in EITHER adapter shadows a reserved address key or carries a token", () => {
    const forbidden = new Set([...reservedKeys, "token", "interactionToken"])
    for (const [name, src] of [
      ["discord.ts", discordSrc],
      ["telegram.ts", telegramSrc],
    ] as const) {
      const blocks = metadataBlocks(src)
      expect(blocks.length, `${name} has at least one metadata literal`).toBeGreaterThan(0)
      for (const block of blocks) {
        for (const key of literalKeys(block)) {
          expect(forbidden.has(key), `${name} metadata key '${key}' collides with the delivery address (H4)`).toBe(
            false,
          )
        }
      }
    }
  })
})
