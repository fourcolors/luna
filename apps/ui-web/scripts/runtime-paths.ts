import { homedir } from "node:os"
import { join } from "node:path"

export interface RuntimePathEnv {
  readonly LUNA_HOME?: string
  readonly LUNA_DB_PATH?: string
  readonly LUNA_MEMORY_DB?: string
  readonly LUNA_ANALYTICS_DB_PATH?: string
  readonly LUNA_EVENTS_JSONL_PATH?: string
}

export interface ResolveRuntimePathsOptions {
  readonly env?: RuntimePathEnv
  readonly homeDir?: string
}

export interface RuntimePaths {
  readonly lunaHome: string
  readonly envFilePath: string
  readonly lunaDbPath: string
  readonly memoryDbPath: string
  readonly analyticsDbPath: string
  readonly eventsJsonlPath: string
}

const nonEmpty = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export const resolveRuntimePaths = (
  opts: ResolveRuntimePathsOptions = {},
): RuntimePaths => {
  const env = opts.env ?? process.env
  const homeDir = opts.homeDir ?? homedir()
  const lunaHome = nonEmpty(env.LUNA_HOME) ?? join(homeDir, ".luna")

  return {
    lunaHome,
    envFilePath: join(lunaHome, ".env"),
    lunaDbPath: nonEmpty(env.LUNA_DB_PATH) ?? join(lunaHome, "luna.db"),
    memoryDbPath: nonEmpty(env.LUNA_MEMORY_DB) ?? join(lunaHome, "memory.db"),
    analyticsDbPath:
      nonEmpty(env.LUNA_ANALYTICS_DB_PATH) ?? join(lunaHome, "analytics.duckdb"),
    eventsJsonlPath:
      nonEmpty(env.LUNA_EVENTS_JSONL_PATH) ?? join(lunaHome, "events.jsonl"),
  }
}

export const applyRuntimePathEnvDefaults = (
  paths: RuntimePaths,
  env: NodeJS.ProcessEnv = process.env,
): void => {
  if (nonEmpty(env.LUNA_HOME) === undefined) env.LUNA_HOME = paths.lunaHome
  if (nonEmpty(env.LUNA_DB_PATH) === undefined) env.LUNA_DB_PATH = paths.lunaDbPath
  if (nonEmpty(env.LUNA_MEMORY_DB) === undefined) env.LUNA_MEMORY_DB = paths.memoryDbPath
  if (nonEmpty(env.LUNA_ANALYTICS_DB_PATH) === undefined) {
    env.LUNA_ANALYTICS_DB_PATH = paths.analyticsDbPath
  }
  if (nonEmpty(env.LUNA_EVENTS_JSONL_PATH) === undefined) {
    env.LUNA_EVENTS_JSONL_PATH = paths.eventsJsonlPath
  }
}
