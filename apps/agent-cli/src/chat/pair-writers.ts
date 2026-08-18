import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

/**
 * Config writers shared by `luna pair`. These persist a secret WS token to two
 * on-disk client configs, so both writers:
 *   - create ~/.luna with mode 0700 if missing,
 *   - write to a SAME-DIR temp file then rename(2) (atomic on one filesystem),
 *   - create the temp with mode 0600 from the start (never a world-readable
 *     window, even transiently), and chmod the final file 0600 after rename.
 *
 * `upsertEnv` mirrors install.sh's bash `upsert_env`: replace the line that
 * starts with `KEY=`, else append; preserve every OTHER line verbatim; atomic
 * same-dir-temp rename; mode 0600. `writeMoonConnection` writes the EXACT JSON
 * shape (camelCase wsUrl/wsToken) the Moon widget's Rust save_connection writes
 * so Moon reads it on next launch.
 */

const lunaDir = (homeDir: string): string => join(homeDir, ".luna")

/** Ensure ~/.luna exists (mode 0700 — it holds secrets), return its path. */
const ensureLunaDir = (homeDir: string): string => {
  const dir = lunaDir(homeDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * Atomically write `contents` to `finalPath` with mode 0600, via a same-dir
 * temp file. The temp is created mode 0600 from birth so the secret never has a
 * world-readable window. `dir` must be the directory containing `finalPath`.
 */
const writeAtomic0600 = (dir: string, finalPath: string, contents: string): void => {
  const tmp = join(dir, `.${randomSuffix()}.tmp`)
  // mode in writeFileSync is applied on creation (subject to umask), so chmod
  // immediately after to guarantee 0600 regardless of the process umask.
  writeFileSync(tmp, contents, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  try {
    renameSync(tmp, finalPath)
  } catch (e) {
    // Best-effort cleanup of the temp on a failed rename so we never leave a
    // stray secret-bearing .tmp behind.
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
    throw e
  }
  // rename preserves the source's 0600, but chmod again to be explicit (the
  // safest available pattern; never relies on a write-then-chmod 0644 window).
  chmodSync(finalPath, 0o600)
}

const randomSuffix = (): string =>
  `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`

export const lunaEnvPath = (homeDir: string): string => join(lunaDir(homeDir), ".env")

export const moonConnectionPath = (homeDir: string): string =>
  join(lunaDir(homeDir), "moon-connection.json")

export const clientTomlPath = (homeDir: string): string => join(lunaDir(homeDir), "client.toml")

/**
 * Escape a string for a TOML basic string (double-quoted). Pair URLs are
 * ascii ws(s)://… so this is defensive rather than a full TOML encoder.
 */
const tomlBasicString = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

/**
 * Upsert `route.<profile>.endpoints[0]` in ~/.luna/client.toml (what Moon
 * dials after C3). No-op when the file is absent — pre-migration Moon still
 * reads moon-connection.json, and migrate_legacy_connection will snapshot
 * the just-written URL on first boot.
 *
 * When `setDefault` is true, also sets top-level `default = "<profile>"`
 * (luna pair --activate). Creates a missing `[route.<profile>]` table with
 * `tokenRef = "legacy"` rather than inventing a whole client.toml.
 */
export const upsertClientTomlEndpoint = (
  homeDir: string,
  profile: string,
  url: string,
  options?: { readonly setDefault?: boolean },
): void => {
  const path = clientTomlPath(homeDir)
  if (!existsSync(path)) return

  const setDefault = options?.setDefault === true
  const lines = readFileSync(path, "utf8").replace(/\n$/, "").split("\n")
  const header = `[route.${profile}]`
  const urlLit = tomlBasicString(url)

  if (setDefault) {
    let defaultIdx = lines.findIndex((l) => /^default\s*=/.test(l))
    if (defaultIdx >= 0) {
      lines[defaultIdx] = `default = ${tomlBasicString(profile)}`
    } else {
      const versionIdx = lines.findIndex((l) => /^fileFormatVersion\s*=/.test(l))
      const insertAt = versionIdx >= 0 ? versionIdx + 1 : 0
      lines.splice(insertAt, 0, `default = ${tomlBasicString(profile)}`)
    }
  }

  let routeStart = lines.findIndex((l) => l.trim() === header)
  if (routeStart < 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("")
    lines.push(header)
    lines.push(`endpoints = [${urlLit}]`)
    lines.push(`label = ${tomlBasicString(profile)}`)
    lines.push(`tokenRef = "legacy"`)
  } else {
    let routeEnd = lines.length
    for (let i = routeStart + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i]!)) {
        routeEnd = i
        break
      }
    }
    const block = lines.slice(routeStart + 1, routeEnd)
    let endpointsIdx = block.findIndex((l) => /^endpoints\s*=/.test(l))
    let hasLabel = block.some((l) => /^label\s*=/.test(l))
    let hasTokenRef = block.some((l) => /^tokenRef\s*=/.test(l))

    if (endpointsIdx >= 0) {
      const existing = block[endpointsIdx]!
      // Multi-line arrays are rare in our fixtures; handle single-line form.
      const match = existing.match(/^endpoints\s*=\s*\[(.*)\]\s*$/)
      if (match) {
        const parts = match[1]!
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
        const rest = parts.slice(1)
        block[endpointsIdx] = `endpoints = [${[urlLit, ...rest].join(", ")}]`
      } else {
        block[endpointsIdx] = `endpoints = [${urlLit}]`
      }
    } else {
      block.unshift(`endpoints = [${urlLit}]`)
    }
    if (!hasLabel) block.push(`label = ${tomlBasicString(profile)}`)
    if (!hasTokenRef) block.push(`tokenRef = "legacy"`)
    lines.splice(routeStart + 1, routeEnd - routeStart - 1, ...block)
  }

  const dir = ensureLunaDir(homeDir)
  writeAtomic0600(dir, path, `${lines.join("\n")}\n`)
}
/**
 * Replace-or-append a single `KEY=value` line in ~/.luna/.env, preserving all
 * other lines. Mirrors install.sh upsert_env: match is a line whose START is
 * exactly `KEY=` (so `KEY=` but not `OTHERKEY=` nor a comment `#KEY=`). If the
 * key is absent, the line is appended. Atomic + mode 0600.
 */
export const upsertEnv = (homeDir: string, key: string, value: string): void => {
  const dir = ensureLunaDir(homeDir)
  const path = lunaEnvPath(homeDir)
  const existing = existsSync(path) ? readFileSync(path, "utf8") : ""

  // Preserve the file's line structure. We treat content as a list of physical
  // lines; a trailing newline yields a trailing empty element we drop, then we
  // re-join with \n and append a final newline (POSIX text file).
  const hadTrailingNewline = existing.length === 0 || existing.endsWith("\n")
  const rawLines = existing.length === 0 ? [] : existing.replace(/\n$/, "").split("\n")

  const prefix = `${key}=`
  const newLine = `${key}=${value}`
  let replaced = false
  const out = rawLines.map((line) => {
    if (!replaced && line.startsWith(prefix)) {
      replaced = true
      return newLine
    }
    return line
  })
  if (!replaced) out.push(newLine)

  // Always end with a single trailing newline (matches awk's print behavior).
  void hadTrailingNewline
  const contents = `${out.join("\n")}\n`
  writeAtomic0600(dir, path, contents)
}

const DEFAULT_MOON_PROFILE = "stable"

/** A single channel's creds inside moon-connection.json. */
interface MoonProfile {
  readonly wsUrl: string
  readonly wsToken: string
}

/** The new (additive) on-disk shape of moon-connection.json. */
interface MoonConnectionFile {
  activeProfile: string
  profiles: Record<string, MoonProfile>
}

/**
 * Read + MIGRATE the existing moon-connection.json into the new
 * {activeProfile, profiles} shape. Backward-read-compatible (must never throw
 * or fail-closed on the running user's flat file):
 *   - new format ({profiles} + {activeProfile}) -> used verbatim.
 *   - legacy flat {wsUrl, wsToken}             -> profiles.stable, active=stable.
 *   - missing / empty / garbage                -> empty profiles, active=stable.
 * Mirrors the Rust normalize_profiles() so both writers agree.
 */
const readMoonConnection = (homeDir: string): MoonConnectionFile => {
  const path = moonConnectionPath(homeDir)
  let parsed: unknown
  try {
    if (!existsSync(path)) return { activeProfile: DEFAULT_MOON_PROFILE, profiles: {} }
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    // Unreadable / unparseable -> behave as no connection (never throw).
    return { activeProfile: DEFAULT_MOON_PROFILE, profiles: {} }
  }
  if (parsed === null || typeof parsed !== "object") {
    return { activeProfile: DEFAULT_MOON_PROFILE, profiles: {} }
  }
  const obj = parsed as Record<string, unknown>

  // New format: both keys present and well-typed.
  if (
    typeof obj["activeProfile"] === "string" &&
    obj["profiles"] !== null &&
    typeof obj["profiles"] === "object"
  ) {
    return {
      activeProfile: obj["activeProfile"] as string,
      profiles: { ...(obj["profiles"] as Record<string, MoonProfile>) },
    }
  }

  // Legacy flat format: carry it into the stable slot, preserving any extra keys
  // so the Moon's load_connection returns the same creds for the running user.
  if ("wsUrl" in obj || "wsToken" in obj) {
    return {
      activeProfile: DEFAULT_MOON_PROFILE,
      profiles: { [DEFAULT_MOON_PROFILE]: obj as unknown as MoonProfile },
    }
  }

  return { activeProfile: DEFAULT_MOON_PROFILE, profiles: {} }
}

/**
 * Write ~/.luna/moon-connection.json in the new (additive) {activeProfile,
 * profiles} shape, into the named `profile` slot, PRESERVING every OTHER
 * existing profile and migrating a legacy flat file first. This fixes the bug
 * where `luna pair --profile dev` clobbered the Moon's stable connection.
 *
 * activeProfile is switched to `profile` ONLY when `activate` is true OR there
 * was no prior file (first-ever pairing must point active at the just-paired
 * channel, else the Moon would have a creds-less active "stable" and could not
 * connect). When a prior activeProfile already exists, a non-activating pair
 * leaves it untouched — so pairing dev never hijacks a running stable Moon.
 *
 * Atomic + 0600. (Unlike the legacy flat writer this is no longer byte-matched
 * to the Rust serde output — the new format is nested and Moon's load uses
 * order-independent from_str, so functional equality is the contract.)
 */
export const writeMoonConnection = (
  homeDir: string,
  wsUrl: string,
  wsToken: string,
  options?: { readonly profile?: string; readonly activate?: boolean },
): void => {
  const dir = ensureLunaDir(homeDir)
  const path = moonConnectionPath(homeDir)
  const profile = options?.profile?.trim() || DEFAULT_MOON_PROFILE

  const hadFile = existsSync(path)
  const current = readMoonConnection(homeDir)
  current.profiles = { ...current.profiles, [profile]: { wsUrl, wsToken } }
  // First-ever pairing -> active follows the just-paired profile. Otherwise only
  // switch when explicitly asked, so we never hijack the running channel.
  if (!hadFile || options?.activate) {
    current.activeProfile = profile
  }

  const contents = JSON.stringify({
    activeProfile: current.activeProfile,
    profiles: current.profiles,
  })
  writeAtomic0600(dir, path, contents)
}
