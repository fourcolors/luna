/**
 * discord-commands.test.ts — contract for the Slice 3b ops script
 * (task #10; EXECUTABLE SPEC, written before the implementation; RED on
 * arrival: the module `./discord-commands.ts` does not exist yet).
 *
 * The script is the operator CLI for manual (re/de)registration of the
 * guild-scoped Discord slash commands: `list | register | clear`, plus a
 * dry-run flag that prints the payload. Style precedent is mcp-cli.ts
 * (bun shebang, header docblock with Usage + Env vars LUNA_DISCORD_GUILD_ID /
 * LUNA_DISCORD_BOT_TOKEN, argv.slice(2) subcommand dispatch, fail-closed) —
 * a 42-sibling convention, checked by the AUDITOR from the diff, not here.
 *
 * WHAT THIS FILE PINS (the dispatch's stated bar: the registration function
 * is exported and callable with an injected REST fake — NO live-network
 * test, running against production is Slice 6 and EXCLUDED):
 *   1. importing the module must NOT execute the CLI — guard main with
 *      `if (import.meta.main)` (precedents: chat-server.ts:5089,
 *      vault-migrate-keychain.ts:341). If the CLI ran on import it would
 *      process.exit() and kill this very test run — failure is self-evident.
 *   2. `putGuildCommands(rest, appId, guildId, commands?)` is exported: ONE
 *      bulk-overwrite PUT (idempotent) to the GUILD-scoped endpoint. The
 *      route must name BOTH the application and the guild — this is the rail
 *      the adapter-level fake structurally cannot provide (task #10 trap 2:
 *      a global-endpoint impl propagates lazily for up to an hour and
 *      pollutes every guild).
 *   3. the registered payload IS the shared manifest
 *      (`discordCommandManifest` — derived in discord.ts from
 *      channelCommands; a hand-copied ["new","stop","help"] literal in the
 *      SCRIPT would still deep-equal here, so the catalog-duplication trap
 *      stays the auditor's grep, per task #10).
 *   4. `clear` is the same function handed an explicit empty list.
 *
 * NOTE for pong: the manifest is NOT exported from @luna/channels' index
 * (and index.ts is OUT OF SCOPE — do not add a re-export). Reach it by
 * relative import from the channels SOURCE module, exactly as this test
 * does. Signature note: `rest` is anything with a discord.js-REST-shaped
 * `put(route, { body })` — the real caller passes a `new REST()`; tests
 * pass the fake below. Whether putGuildCommands is defined here or defined
 * in discord.ts and re-exported by the script is pong's call; the contract
 * is only that the SCRIPT module exposes it.
 *
 * OUT OF SCOPE — pong may touch ONLY discord.ts, service.ts (one-line R3
 * reorder) and apps/ui-web/scripts/discord-commands.ts. chat-server.ts is
 * NOT on the dispatch's allowed list (conflict with task #10 bubbled to the
 * lead in the task's Ping (spec) section).
 *
 * CAPACITY PRE-FLIGHT: none required — injected fakes only, no network.
 *
 * RED/GREEN inventory at handoff: PRE-FLIGHT test GREEN by design (fixture
 * sanity — if a second green test ever appears here before pong lands, that
 * is a bug, not a second control); the 2 contract tests are RED (dynamic
 * import rejects: module not found).
 */
import { describe, expect, it } from "vitest"
import { discordCommandManifest } from "../../../packages/channels/src/adapters/discord.js"

/** Discord.js-REST-shaped fake: records every PUT, returns the API's echo. */
const makeRestFake = () => {
  const puts: Array<{ route: string; body: unknown }> = []
  return {
    puts,
    rest: {
      put: async (route: string, opts: { body: unknown }): Promise<unknown> => {
        puts.push({ route, body: opts.body })
        return opts.body
      },
    },
  }
}

/**
 * Dynamic import so a missing module is a PER-TEST rejection ("Failed to
 * load"), not a whole-suite transform abort, and so nothing here executes
 * before the pre-flight has proven the fixture import is healthy.
 */
const scriptModule = async (): Promise<Record<string, unknown>> =>
  (await import("./discord-commands.js")) as unknown as Record<string, unknown>

type PutGuildCommands = (
  rest: { put: (route: string, opts: { body: unknown }) => Promise<unknown> },
  appId: string,
  guildId: string,
  commands?: ReadonlyArray<unknown>,
) => Promise<unknown>

describe("discord-commands ops script (Slice 3b, task #10)", () => {
  it("PRE-FLIGHT (GREEN by design): the shared manifest imports from the channels source module — fixture sanity, not the seam", () => {
    // If THIS fails, every other red in the file is harness noise, not spec.
    expect(Array.isArray(discordCommandManifest)).toBe(true)
    expect(discordCommandManifest.length).toBeGreaterThanOrEqual(3)
    expect([...discordCommandManifest].map((c) => c.name).sort()).toEqual(["help", "new", "stop"])
  })

  it("exports putGuildCommands: ONE guild-scoped bulk overwrite of the shared manifest via an injected REST fake", async () => {
    const mod = await scriptModule() // RED today: module not found
    const fn = mod["putGuildCommands"] as PutGuildCommands | undefined
    expect(typeof fn, "putGuildCommands must be exported").toBe("function")

    const { puts, rest } = makeRestFake()
    await fn!(rest, "app-1", "guild-home-1")

    // Bulk overwrite = exactly one PUT, never one-per-command.
    expect(puts).toHaveLength(1)
    const route = puts[0]?.route ?? ""
    // Guild-scoped endpoint: names the app AND the guild
    // (/applications/{appId}/guilds/{guildId}/commands). The global
    // endpoint has no /guilds/ segment — that is the rail.
    expect(route).toContain("/applications/app-1")
    expect(route, "guild-scoped, never global").toContain("/guilds/guild-home-1")
    expect(route.endsWith("/commands"), `route ends with /commands: ${route}`).toBe(true)
    // The payload IS the manifest, as data.
    expect(puts[0]?.body).toEqual([...discordCommandManifest])
  })

  it("clear is the same function with an explicit empty list: bulk-overwrites [] to the same guild route", async () => {
    const mod = await scriptModule() // RED today: module not found
    const fn = mod["putGuildCommands"] as PutGuildCommands | undefined
    expect(typeof fn, "putGuildCommands must be exported").toBe("function")

    const { puts, rest } = makeRestFake()
    await fn!(rest, "app-1", "guild-home-1", [])

    expect(puts).toHaveLength(1)
    expect(puts[0]?.route ?? "").toContain("/guilds/guild-home-1")
    expect(puts[0]?.body, "clear = overwrite with the empty list").toEqual([])
  })
})
