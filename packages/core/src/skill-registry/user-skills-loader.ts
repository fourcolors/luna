/**
 * User-skills loader — `~/.luna/skills/<id>/SKILL.md` → SkillManifest
 * (PRD Part B, S4).
 *
 * Format mirrors the agent definitions in `~/.luna/agents/*.md` and the
 * Claude-skill convention: YAML-ish frontmatter between `---` fences, body
 * after. Recognized frontmatter keys (everything else ignored):
 *
 *   name:        display name           (default: the directory name)
 *   description: one line, powers search (REQUIRED — file skipped if blank)
 *   whenToUse:   trigger hint for the agent (default: description)
 *   category:    workflow|knowledge|writing|data|ops|other (default other)
 *   tags:        comma list or [a, b]
 *
 * The skill id IS the directory name (stable across edits — toggles keyed
 * on it survive file changes). Malformed files are skipped with a warning
 * list, never thrown: a typo in one SKILL.md must not take down the rest.
 *
 * `syncUserSkills` diffs a scan against the registry's current user-sourced
 * entries: new → register, gone → unregister, changed → re-register.
 * Enabled state survives re-registration (the registry's live disabled-set;
 * see skill-registry.ts). Built-in ids win conflicts — a user skill cannot
 * shadow a built-in.
 *
 * New skills register ENABLED by default (Chairman decision, 2026-07-22,
 * superseding the 2026-07-14 quarantine-on-create policy). The operator can
 * still disable any skill explicitly from the Skills tab at any time — that
 * choice is durable and survives re-sync (the live disabled-set below).
 */
import { Effect } from "effect"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { SkillCategory, SkillManifest, SkillRegistryApi } from "./skill-registry.js"

const CATEGORIES: ReadonlySet<string> = new Set([
  "workflow",
  "knowledge",
  "writing",
  "data",
  "ops",
  "other",
])

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export interface UserSkillScan {
  readonly manifests: ReadonlyArray<SkillManifest>
  /** Human-readable skip reasons (bad id, missing description, …). */
  readonly warnings: ReadonlyArray<string>
}

/** Parse one SKILL.md (exported for tests). Returns null + reason on bad input. */
export const parseSkillMd = (
  raw: string,
  id: string,
): { manifest: SkillManifest | null; reason?: string } => {
  if (!ID_RE.test(id)) {
    return { manifest: null, reason: `"${id}": directory name is not a valid skill id (lowercase, digits, dashes)` }
  }
  let meta: Record<string, string> = {}
  let body = raw
  const fence = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (fence) {
    body = raw.slice(fence[0].length)
    for (const line of fence[1]!.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)
      if (m) meta[m[1]!.toLowerCase()] = m[2]!.trim()
    }
  }
  const description = meta["description"] ?? ""
  if (description.trim().length === 0) {
    return { manifest: null, reason: `"${id}": frontmatter is missing a description` }
  }
  if (body.trim().length === 0) {
    return { manifest: null, reason: `"${id}": SKILL.md has no body` }
  }
  const rawCat = (meta["category"] ?? "other").toLowerCase()
  const tagsRaw = meta["tags"] ?? ""
  const tags = tagsRaw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  return {
    manifest: {
      id,
      name: meta["name"]?.trim() || id,
      description: description.trim(),
      whenToUse: meta["whentouse"]?.trim() || description.trim(),
      category: (CATEGORIES.has(rawCat) ? rawCat : "other") as SkillCategory,
      tags,
      source: "user",
      body: body.trim(),
    },
  }
}

/** Scan `<dir>/<id>/SKILL.md`. Missing dir → empty scan (not an error). */
export const scanUserSkills = (dir: string): UserSkillScan => {
  if (!existsSync(dir)) return { manifests: [], warnings: [] }
  const manifests: SkillManifest[] = []
  const warnings: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch (e) {
    return { manifests: [], warnings: [`cannot read ${dir}: ${String(e)}`] }
  }
  for (const id of entries) {
    const file = join(dir, id, "SKILL.md")
    if (!existsSync(file)) continue
    let raw: string
    try {
      raw = readFileSync(file, "utf8")
    } catch (e) {
      warnings.push(`"${id}": unreadable SKILL.md: ${String(e)}`)
      continue
    }
    const { manifest, reason } = parseSkillMd(raw, id)
    if (manifest === null) warnings.push(reason ?? `"${id}": invalid`)
    else manifests.push(manifest)
  }
  return { manifests, warnings }
}

const sameManifest = (a: SkillManifest, b: SkillManifest): boolean =>
  a.name === b.name &&
  a.description === b.description &&
  a.whenToUse === b.whenToUse &&
  a.category === b.category &&
  a.body === b.body &&
  a.tags.length === b.tags.length &&
  a.tags.every((t, i) => t === b.tags[i])

export interface SyncUserSkillsOptions {
  /**
   * Formerly gated the quarantine-on-create decision (superseded
   * 2026-07-22 — see the module docstring). Kept as a no-op parameter so
   * existing callers/tests compile unchanged; no longer read by
   * `syncUserSkills`. A future policy that needs "ids the operator has
   * already seen" can still source it from `SkillPrefsStore.knownIds()`.
   */
  readonly approvedIds?: ReadonlySet<string>
}

/**
 * Reconcile the registry's user-sourced entries with a fresh scan.
 * Returns a change summary for logging. Non-user entries are never touched;
 * a scanned id that collides with a non-user entry is skipped (reported).
 */
export const syncUserSkills = (
  registry: SkillRegistryApi,
  scan: UserSkillScan,
  options: SyncUserSkillsOptions = {},
): Effect.Effect<{
  readonly added: number
  readonly updated: number
  readonly removed: number
  readonly conflicts: ReadonlyArray<string>
  /**
   * Always empty since the 2026-07-22 decision (kept for API stability —
   * new skills no longer quarantine on create).
   */
  readonly quarantined: ReadonlyArray<string>
}> =>
  Effect.gen(function* () {
    const catalog = yield* registry.catalog()
    const existingUser = new Map(
      catalog.filter((e) => e.source === "user").map((e) => [e.id, e] as const),
    )
    const nonUserIds = new Set(
      catalog.filter((e) => e.source !== "user").map((e) => e.id),
    )
    const scanned = new Map(scan.manifests.map((m) => [m.id, m] as const))

    let added = 0
    let updated = 0
    let removed = 0
    const conflicts: string[] = []
    const quarantined: string[] = []

    for (const [id, manifest] of scanned) {
      if (nonUserIds.has(id)) {
        conflicts.push(id)
        continue
      }
      const cur = existingUser.get(id)
      if (cur === undefined) {
        // Registers enabled (registry.register's default) — no quarantine
        // step. See module docstring for the 2026-07-22 decision.
        yield* registry.register(manifest).pipe(Effect.catchAll(() => Effect.void))
        added++
      } else if (!sameManifest(cur, manifest)) {
        yield* registry.unregister(id)
        yield* registry.register(manifest).pipe(Effect.catchAll(() => Effect.void))
        updated++
      }
    }
    for (const [id] of existingUser) {
      if (!scanned.has(id)) {
        yield* registry.unregister(id)
        removed++
      }
    }
    return { added, updated, removed, conflicts, quarantined }
  })
