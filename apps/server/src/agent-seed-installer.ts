/**
 * agent-seed-installer.ts — versioned install of the built-in agent
 * definitions into ~/.luna/agents/ (agent sidebar S6).
 *
 * WHY NOT "copy if the directory is absent": that scheme is not crash-safe
 * (a crash after mkdir leaves a partially seeded directory that every later
 * boot skips forever) and bundled fixes never propagate (the directory
 * exists, so an improved seed never lands). This installer is stamp-based
 * and idempotent instead.
 *
 * CONTRACT (per seed file, against `<target>/.seed-manifest.json` which
 * records the sha256 of the content THIS installer last wrote):
 *   - target file ABSENT            → install it, stamp the hash.
 *   - on-disk == manifest hash      → ours, unmodified: upgrade when the
 *                                     bundled seed changed, else no-op.
 *   - on-disk == seed content       → byte-identical to the bundle (e.g. a
 *                                     crash between file write and manifest
 *                                     write, or a manual cp of our seed):
 *                                     adopt into the manifest. Heals the
 *                                     crash window.
 *   - anything else                 → THE OPERATOR'S FILE. Never touched,
 *                                     never adopted, reported as kept.
 * Files in the target dir that no seed names are never listed, read, or
 * removed — the directory is the operator's; we own only our own seeds.
 *
 * Crash-safety: every write is tmp-in-same-dir + rename (atomic on one
 * volume); the manifest is written LAST, so a crash at any point leaves a
 * state the next boot converges from (the adopt rule above).
 *
 * Sync I/O by design: runs once at boot on a handful of small files —
 * matches loadAgents()'s own discipline. Never throws: any error degrades
 * to a warn + skipped file (a broken seed must not stop the server).
 */
import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const SEED_MANIFEST_NAME = ".seed-manifest.json"

interface SeedManifest {
  readonly version: 1
  /** filename → sha256 hex of the content this installer last wrote. */
  readonly files: Record<string, string>
}

export interface SeedInstallReport {
  readonly installed: string[]
  readonly upgraded: string[]
  /** Present but operator-modified (or unknown provenance) — untouched. */
  readonly kept: string[]
  /** Byte-identical to the bundle without a stamp — manifest healed. */
  readonly adopted: string[]
  readonly errors: string[]
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex")

const readManifest = (dir: string): SeedManifest => {
  try {
    const raw = readFileSync(join(dir, SEED_MANIFEST_NAME), "utf8")
    const parsed = JSON.parse(raw) as SeedManifest
    if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === "object") {
      return { version: 1, files: { ...parsed.files } }
    }
  } catch {
    /* absent or corrupt → treated as empty; the adopt rule re-converges */
  }
  return { version: 1, files: {} }
}

/** tmp-in-same-dir + rename — atomic on one volume. */
const atomicWrite = (dir: string, name: string, content: string): void => {
  const tmp = join(dir, `.${name}.${randomUUID()}.tmp`)
  writeFileSync(tmp, content, "utf8")
  renameSync(tmp, join(dir, name))
}

export const installAgentSeeds = (
  seedsDir: string,
  targetDir: string = join(homedir(), ".luna", "agents"),
  warn: (message: string) => void = (m) => console.warn(m),
): SeedInstallReport => {
  const report: SeedInstallReport = {
    installed: [],
    upgraded: [],
    kept: [],
    adopted: [],
    errors: [],
  }
  let seeds: string[]
  try {
    seeds = readdirSync(seedsDir).filter(
      (f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md",
    )
  } catch (err) {
    report.errors.push(`seeds dir unreadable: ${String(err)}`)
    return report
  }
  if (seeds.length === 0) return report

  try {
    mkdirSync(targetDir, { recursive: true })
  } catch (err) {
    report.errors.push(`target dir: ${String(err)}`)
    return report
  }

  const manifest = readManifest(targetDir)
  let manifestDirty = false

  for (const name of seeds) {
    try {
      const seedContent = readFileSync(join(seedsDir, name), "utf8")
      const seedHash = sha256(seedContent)
      const targetPath = join(targetDir, name)

      if (!existsSync(targetPath)) {
        atomicWrite(targetDir, name, seedContent)
        manifest.files[name] = seedHash
        manifestDirty = true
        report.installed.push(name)
        continue
      }

      const onDisk = readFileSync(targetPath, "utf8")
      const onDiskHash = sha256(onDisk)

      if (onDiskHash === seedHash) {
        // Already current. Stamp it if the manifest missed it (crash heal /
        // manual cp of our own seed).
        if (manifest.files[name] !== seedHash) {
          manifest.files[name] = seedHash
          manifestDirty = true
          report.adopted.push(name)
        }
        continue
      }

      if (manifest.files[name] === onDiskHash) {
        // Ours, unmodified since we wrote it — the bundled seed changed:
        // upgrade.
        atomicWrite(targetDir, name, seedContent)
        manifest.files[name] = seedHash
        manifestDirty = true
        report.upgraded.push(name)
        continue
      }

      // Operator-modified or unknown provenance — never touch it.
      report.kept.push(name)
    } catch (err) {
      report.errors.push(`${name}: ${String(err)}`)
      warn(`[agent-seeds] skipping "${name}": ${String(err)}`)
    }
  }

  if (manifestDirty) {
    try {
      atomicWrite(
        targetDir,
        SEED_MANIFEST_NAME,
        JSON.stringify({ version: 1, files: manifest.files }, null, 2) + "\n",
      )
    } catch (err) {
      report.errors.push(`manifest: ${String(err)}`)
      warn(`[agent-seeds] manifest write failed: ${String(err)}`)
    }
  }
  return report
}
