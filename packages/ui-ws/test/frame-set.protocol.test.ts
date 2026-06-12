/**
 * frame-set.protocol.test.ts — VERSION-SKEW defence (server half).
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * Client (Moon app) and server (luna-update-server) now update independently,
 * so their wire protocol WILL drift. The failure mode that motivated this test:
 * a frame TYPE-STRING was renamed within the SAME protocol version (Moon sent
 * "subscribe-thread"; the server only handled "subscribe"). Nothing failed
 * loudly — the connection just hung silently for 40 minutes.
 *
 * This test pins the SET of wire `type` string literals for BOTH ClientFrame and
 * ServerFrame, plus the current UI_WS_PROTOCOL_VERSION. If anyone adds, removes,
 * renames, or re-semantics a frame `type` WITHOUT updating this test, the test
 * fails — forcing the author to consciously decide whether the change needs a
 * protocol-version bump.
 *
 * HOW THE CATCH ACTUALLY WORKS (read this before "fixing" it)
 * ----------------------------------------------------------
 * The frame unions in protocol.ts are TypeScript types — they are fully erased
 * at runtime, so a runtime test cannot introspect them. AND, in this repo, the
 * package typecheck (`tsc -p tsconfig.json`) EXCLUDES test files (the root
 * tsconfig `exclude` lists the `.test.ts` glob), so a compile-time
 * `satisfies Record<Frame["type"],…>` placed in a test file would never be
 * checked by tsc, and vitest (esbuild)
 * strips types without checking them. A type-level assertion here would be a
 * dead no-op — exactly the trap the existing convention tests fell into (their
 * type-level "proofs" never run; only their runtime `expect(...)` calls do).
 *
 * So instead we read protocol.ts AS SOURCE TEXT and parse the literals out:
 *   1. Map each `export interface XxxFrame { readonly type: "literal" }` →
 *      { XxxFrame: "literal" }  (`type` is always the first field of a frame).
 *   2. Slice each union's right-hand side (`export type ServerFrame = …` up to
 *      the next divider) and read its member interface names.
 *   3. Resolve names → literals via the map.
 * Then assert the parsed sets equal the hardcoded EXPECTED sets below, and that
 * UI_WS_PROTOCOL_VERSION is the expected value. A rename like
 * "subscribe"→"subscribe-thread" changes the parsed set but not EXPECTED → red.
 *
 * HOW TO UPDATE THIS TEST CORRECTLY (the rule)
 * --------------------------------------------
 * - ADDITIVE frame gated by the `capabilities{}` block (older clients negotiate
 *   down and never see it): just ADD the new literal to the EXPECTED set here.
 *   No version bump strictly required.
 * - RENAME / REMOVE / RE-SEMANTIC of an existing frame `type`: update the
 *   EXPECTED set here AND bump `UI_WS_PROTOCOL_VERSION` in
 *   packages/ui-ws/src/protocol.ts AND update the `toBe(...)` assertion below.
 *   These changes break old peers, so the version MUST move.
 *
 * The set assertion is what TRIPS on the session bug; the version `toBe(N)`
 * assertion is a separate hygiene guard — it is deliberately NOT wired to force
 * a bump on every set change (additive-behind-capabilities is exempt by rule).
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { UI_WS_PROTOCOL_VERSION } from "../src/protocol.js"

/* -------------------------------------------------------------------------- */
/* Expected wire contract — derived from the unions in src/protocol.ts.       */
/* NOTE: `bye` appears in BOTH unions (server can send it, client can send it).*/
/* `ping` is server→client; `pong` is client→server.                          */
/* -------------------------------------------------------------------------- */

const EXPECTED_SERVER_FRAME_TYPES = [
  "hello",
  "event",
  "drop",
  "ping",
  "bye",
  "thread-list",
  "thread-created",
  "thread-snapshot",
  "user-accepted",
  "assistant-delta",
  "assistant-done",
  "assistant-error",
  "artifacts-extracted",
  "tool-call",
  "tool-result",
  "turn-complete",
  "account-list",
  "skill-catalog",
  "skill-status",
  "connector-catalog",
  "connector-list",
  "connector-oauth-redirect",
  "connector-status",
  "artifact-list",
  "artifact-update",
  "workflow-list",
  "workflow-runs",
  "local-shell-request",
  "local-shell-status",
  "register-op-token-status",
  "secret-request",
  "secret-status",
  "job-input-request",
  "job-input-status",
  "memory-search-result",
  "memory-search-error",
  "survey-request",
  "pty-output",
  "vault-list",
  "vault-status",
  "widget-open",
].sort()

const EXPECTED_CLIENT_FRAME_TYPES = [
  "pong",
  "bye",
  "subscribe",
  "unsubscribe",
  "list-threads",
  "new-thread",
  "user-message",
  "interrupt",
  "local-shell-capability",
  "local-shell-result",
  "memory-search-request",
  "register-op-token",
  "secret-result",
  "job-input-result",
  "survey-response",
  "skill-toggle",
  "connector-oauth-begin",
  "connector-oauth-code",
  "connector-connect",
  "connector-disconnect",
  "connector-set-client",
  "artifact-pin",
  "artifact-unpin",
  "workflow-runs-request",
  "workflow-refresh",
  "pty-input",
  "pty-resize",
  "vault-put",
  "vault-delete",
  "vault-sync-config",
  "vault-import",
  "widget-directory",
].sort()

const EXPECTED_PROTOCOL_VERSION = 2

/* -------------------------------------------------------------------------- */
/* Parse the actual literals out of protocol.ts source text.                  */
/* -------------------------------------------------------------------------- */

/** Read the live protocol source (cwd-independent — resolved relative to here). */
function readProtocolSource(): string {
  return readFileSync(new URL("../src/protocol.ts", import.meta.url), "utf8")
}

/** Read the ui-shared wire mirror (the standalone copy non-Node clients use). */
function readWireSource(): string {
  return readFileSync(
    new URL("../../ui-shared/src/wire.ts", import.meta.url),
    "utf8",
  )
}

/**
 * Map each frame INTERFACE NAME to its `type` string literal.
 * `type` is always the first field of a frame interface, so we match
 * `export interface <Name> {` immediately followed by `readonly type: "<lit>"`.
 */
function parseInterfaceTypeLiterals(src: string): Map<string, string> {
  const re = /export interface (\w+)\s*\{\s*\n\s*readonly type:\s*"([^"]+)"/g
  const map = new Map<string, string>()
  for (const m of src.matchAll(re)) {
    map.set(m[1]!, m[2]!)
  }
  return map
}

/**
 * Read the member interface names of a union `export type <UnionName> = A | B …`.
 * Slices from the union declaration to the next top-level boundary (`export `
 * or a block-comment divider or EOF), then pulls each `| Identifier`.
 */
function parseUnionMemberNames(src: string, unionName: string): string[] {
  const startMarker = `export type ${unionName} =`
  const start = src.indexOf(startMarker)
  if (start === -1) throw new Error(`union "${unionName}" not found in protocol.ts`)
  const rest = src.slice(start + startMarker.length)
  // End at the next top-level export or a block-comment divider, whichever first.
  const boundaries = [rest.indexOf("\nexport "), rest.indexOf("\n/*")].filter((i) => i !== -1)
  const end = boundaries.length > 0 ? Math.min(...boundaries) : rest.length
  const body = rest.slice(0, end)
  return [...body.matchAll(/\|\s*(\w+)/g)].map((m) => m[1]!)
}

/** Resolve a union's member interface names to their wire `type` literals. */
function literalsForUnion(src: string, unionName: string): string[] {
  const nameToLiteral = parseInterfaceTypeLiterals(src)
  return parseUnionMemberNames(src, unionName).map((name) => {
    const literal = nameToLiteral.get(name)
    if (literal === undefined) {
      throw new Error(
        `union member "${name}" in ${unionName} has no parseable \`readonly type: "..."\` literal`,
      )
    }
    return literal
  })
}

describe("VERSION-SKEW: wire frame-type set is pinned (forces a conscious version bump on drift)", () => {
  const src = readProtocolSource()

  it("ServerFrame's set of wire `type` literals matches the expected contract", () => {
    const actual = literalsForUnion(src, "ServerFrame").sort()
    expect(actual).toEqual(EXPECTED_SERVER_FRAME_TYPES)
  })

  it("ClientFrame's set of wire `type` literals matches the expected contract", () => {
    const actual = literalsForUnion(src, "ClientFrame").sort()
    expect(actual).toEqual(EXPECTED_CLIENT_FRAME_TYPES)
  })

  it("UI_WS_PROTOCOL_VERSION is the expected version (bump this on rename/remove/re-semantic)", () => {
    // Hygiene guard: a rename/removal that updates the set above MUST also bump
    // this. Additive-behind-capabilities frames are exempt (extend the set only).
    expect(UI_WS_PROTOCOL_VERSION).toBe(EXPECTED_PROTOCOL_VERSION)
  })

  it("parser self-check: derived counts are sane (41 server, 32 client) — guards the regex itself", () => {
    // If the regex silently mis-parses, the toEqual above could pass for the
    // wrong reason. Pin the counts so a broken parser is caught here.
    // Prior base = 24 server / 15 client; the agent-summoned secure-secret-entry
    // feature adds secret-request + secret-status (server) and secret-result
    // (client) → 26 server / 16 client. The PRD Part B skills feature adds
    // skill-catalog + skill-status (server) and skill-toggle (client)
    // → 28 server / 17 client. The PRD Part A connectors feature adds
    // connector-catalog/-list/-oauth-redirect/-status (server) and
    // connector-oauth-begin/-oauth-code/-connect/-disconnect (client)
    // → 32 server / 21 client. The PRD Part C/W1 artifacts feature adds
    // artifact-list + artifact-update (server) and artifact-pin + artifact-unpin
    // (client) → 34 server / 23 client. The PRD Part C/W3 workflow gallery adds
    // workflow-list + workflow-runs (server) and workflow-runs-request +
    // workflow-refresh (client) → 36 server / 25 client. M2.6 adds
    // connector-set-client (client) for the inline OAuth-client setup form
    // → 36 server / 26 client. Luna Vault V1 adds vault-list + vault-status
    // (server) and vault-put + vault-delete + vault-sync-config + vault-import
    // (client) → 38 server / 30 client. Summon-by-name (widget-system.md)
    // adds widget-open (server) and widget-directory (client)
    // → 39 server / 31 client. Job-summoned operator input (widget-system.md
    // Phase 5) adds job-input-request + job-input-status (server) and
    // job-input-result (client) → 41 server / 32 client.
    expect(literalsForUnion(src, "ServerFrame")).toHaveLength(41)
    expect(literalsForUnion(src, "ClientFrame")).toHaveLength(32)
  })

  // VERSION-SKEW (client half): nothing else pins the ui-shared wire.ts mirror
  // to protocol.ts. A frame added/renamed in wire.ts but not protocol.ts (or
  // misspelled) would silently break the non-Node clients (Moon/web) without
  // any test going red (review W1/wire). wire.ts is a STRICT SUBSET of
  // protocol.ts (it omits server-internal frames like tool-call), so assert
  // containment with matching spellings.
  const wireSrc = readWireSource()
  for (const union of ["ServerFrame", "ClientFrame"] as const) {
    it(`wire.ts ${union} literals are a spelling-exact subset of protocol.ts (mirror stays in sync)`, () => {
      const wire = new Set(literalsForUnion(wireSrc, union))
      const proto = new Set(literalsForUnion(src, union))
      const orphans = [...wire].filter((t) => !proto.has(t))
      expect(orphans).toEqual([]) // every wire frame must exist in protocol.ts
    })
  }

  it("the artifact frames (W1) are present in BOTH wire.ts and protocol.ts", () => {
    const serverProto = new Set(literalsForUnion(src, "ServerFrame"))
    const serverWire = new Set(literalsForUnion(wireSrc, "ServerFrame"))
    const clientProto = new Set(literalsForUnion(src, "ClientFrame"))
    const clientWire = new Set(literalsForUnion(wireSrc, "ClientFrame"))
    for (const t of ["artifact-list", "artifact-update"]) {
      expect(serverProto.has(t)).toBe(true)
      expect(serverWire.has(t)).toBe(true)
    }
    for (const t of ["artifact-pin", "artifact-unpin"]) {
      expect(clientProto.has(t)).toBe(true)
      expect(clientWire.has(t)).toBe(true)
    }
  })
})
