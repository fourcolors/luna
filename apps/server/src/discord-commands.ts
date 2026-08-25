#!/usr/bin/env bun
/**
 * discord-commands: operator CLI for the guild-scoped Discord slash-command
 * set (Slice 3b, task #10).
 *
 * Bulk-overwrites (or lists, or clears) the slash commands of ONE home
 * guild. The payload is NEVER written here: it is `discordCommandManifest`,
 * derived in the channels package from the shared `channelCommands` catalog,
 * imported RELATIVELY from the channels source because the package index
 * deliberately does not re-export it. Registration is guild-scoped ONLY
 * (instant propagation; the global endpoint caches for up to an hour and
 * pollutes every guild); the route comes from the channels module's single
 * `guildCommandsRoute` authority. All mutations are fail-closed by design:
 * a missing token, guild id, or subcommand prints an error and exits 1;
 * nothing is guessed and nothing falls back to a global write. `clear` is
 * the rollback: the same bulk PUT with the empty list.
 *
 * Usage: bun run apps/server/src/discord-commands.ts <command> [--dry-run]
 *
 * Commands:
 *   list       Print the guild's currently registered commands (GET, read-only)
 *   register   Bulk-overwrite the guild's commands with the shared manifest
 *   clear      Bulk-overwrite the guild's commands with [] (rollback)
 *
 * Flags:
 *   --dry-run  (register|clear) Print the exact payload that WOULD be PUT,
 *              make no network call, need no credentials
 *
 * Env vars:
 *   LUNA_DISCORD_GUILD_ID   Home guild id (required for live commands)
 *   LUNA_DISCORD_BOT_TOKEN  Bot token (required for live commands; sent only
 *                           as the Authorization header, never printed)
 */
import {
  discordCommandManifest,
  guildCommandsRoute,
  putGuildCommands,
  type GuildCommandsRest,
} from "@luna/channels"

/**
 * Re-exported so the sibling test (and any future tooling) reaches the ONE
 * registration function through this module: the script owns no endpoint or
 * payload knowledge of its own.
 */
export { discordCommandManifest, guildCommandsRoute, putGuildCommands }

const DISCORD_API = "https://discord.com/api/v10"

/**
 * Minimal REST client over fetch, satisfying the `GuildCommandsRest` shape
 * putGuildCommands needs. discord.js is deliberately NOT imported here: it
 * is a dependency of packages/channels, not of apps/ui-web, and this bun
 * workspace uses the isolated linker, so "discord.js" does not resolve from
 * this directory. A non-2xx response throws with the response BODY included
 * (a 4xx means the payload or addressing is wrong; the body says which).
 * The token travels only in the Authorization header.
 */
const makeFetchRest = (token: string): GuildCommandsRest & {
  readonly get: (route: string) => Promise<unknown>
} => {
  const call = async (method: "GET" | "PUT", route: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${DISCORD_API}${route}`, {
      method,
      headers: {
        "Authorization": `Bot ${token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      throw new Error(
        `${method} ${route} failed: ${res.status} ${res.statusText}` +
          (detail === "" ? "" : `: ${detail}`),
      )
    }
    return res.json()
  }
  return {
    get: (route) => call("GET", route),
    put: (route, opts) => call("PUT", route, opts.body),
  }
}

const printUsage = (): void => {
  console.error(
    "usage: bun run apps/server/src/discord-commands.ts <list|register|clear> [--dry-run]\n" +
      "  env: LUNA_DISCORD_GUILD_ID (home guild id), LUNA_DISCORD_BOT_TOKEN (bot token)",
  )
}

/** Fail-closed env read: absent OR empty is a refusal, never a default. */
const requireEnv = (name: string): string => {
  const v = process.env[name]
  if (v === undefined || v === "") {
    console.error(`error: ${name} is not set (fail-closed: no default, no fallback)`)
    process.exit(1)
  }
  return v
}

/** The application id, resolved from the token itself: GET /applications/@me. */
const fetchApplicationId = async (rest: { get: (route: string) => Promise<unknown> }): Promise<string> => {
  const app = (await rest.get("/applications/@me")) as { id?: unknown }
  if (typeof app.id !== "string" || app.id === "") {
    console.error("error: could not resolve the application id from the bot token")
    process.exit(1)
  }
  return app.id
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const dryRun = argv.includes("--dry-run")

  switch (cmd) {
    case "register":
    case "clear": {
      const payload = cmd === "clear" ? [] : [...discordCommandManifest]
      if (dryRun) {
        console.log(`dry run (${cmd}): would bulk-overwrite the guild command set with:`)
        console.log(JSON.stringify(payload, null, 2))
        break
      }
      const guildId = requireEnv("LUNA_DISCORD_GUILD_ID")
      const rest = makeFetchRest(requireEnv("LUNA_DISCORD_BOT_TOKEN"))
      const appId = await fetchApplicationId(rest)
      // ONE bulk PUT via the shared function, the same call the adapter's ready
      // path makes; `clear` is the same call with the explicit empty list.
      const echo = await putGuildCommands(rest, appId, guildId, payload)
      const count = Array.isArray(echo) ? echo.length : payload.length
      console.log(
        cmd === "clear"
          ? `cleared: guild=${guildId} now has ${count} commands`
          : `registered: guild=${guildId} count=${count}`,
      )
      break
    }

    case "list": {
      if (dryRun) {
        console.error("error: --dry-run applies to register|clear (list is already read-only)")
        process.exit(1)
      }
      const guildId = requireEnv("LUNA_DISCORD_GUILD_ID")
      const rest = makeFetchRest(requireEnv("LUNA_DISCORD_BOT_TOKEN"))
      const appId = await fetchApplicationId(rest)
      const commands = await rest.get(guildCommandsRoute(appId, guildId))
      console.log(JSON.stringify(commands, null, 2))
      break
    }

    default: {
      if (cmd !== undefined) console.error(`error: unknown command "${cmd}"`)
      printUsage()
      process.exit(1)
    }
  }
}
