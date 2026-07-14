/**
 * Doctor backup store — durable snapshots under ~/.luna/doctor-backups/
 * (or $LUNA_HOME/doctor-backups). Every mutating doctor action must create
 * a backup first; patch/restore APIs refuse without a valid backup id.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type {
  DoctorBackupManifest,
  DoctorFinding,
  DoctorPatient,
  RemedyClass,
} from "./types.js"

const DEFAULT_MAX_BACKUPS = 50
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface DoctorBackupStoreOptions {
  readonly rootDir?: string
  readonly maxBackups?: number
  readonly maxAgeMs?: number
}

export const resolveDoctorBackupRoot = (override?: string): string => {
  if (override) return override
  const home =
    process.env["LUNA_HOME"]?.trim() ||
    join(homedir(), ".luna")
  return join(home, "doctor-backups")
}

const safeId = (s: string): string =>
  s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80)

export interface CreateBackupInput {
  readonly finding: DoctorFinding
  readonly doctorAttempt: number
  readonly remedyClass: RemedyClass
  /** Arbitrary JSON-serializable snapshot of the patient before mutation. */
  readonly before: unknown
  readonly nowMs?: number
}

export interface DoctorBackupRecord {
  readonly manifest: DoctorBackupManifest
  readonly dir: string
  readonly beforePath: string
}

export class DoctorBackupStore {
  readonly rootDir: string
  private readonly maxBackups: number
  private readonly maxAgeMs: number

  constructor(opts?: DoctorBackupStoreOptions) {
    this.rootDir = resolveDoctorBackupRoot(opts?.rootDir)
    this.maxBackups = opts?.maxBackups ?? DEFAULT_MAX_BACKUPS
    this.maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  }

  ensureRoot(): void {
    mkdirSync(this.rootDir, { recursive: true })
  }

  create(input: CreateBackupInput): DoctorBackupRecord {
    this.ensureRoot()
    const now = input.nowMs ?? Date.now()
    const id = `${now}_${safeId(input.finding.patient.kind)}_${safeId(input.finding.patient.id)}_${safeId(input.finding.id)}`
    const dir = join(this.rootDir, id)
    mkdirSync(dir, { recursive: true })
    const beforeDir = join(dir, "before")
    mkdirSync(beforeDir, { recursive: true })
    const beforePath = join(beforeDir, "patient.json")
    writeFileSync(beforePath, JSON.stringify(input.before, null, 2), "utf8")
    const findingPath = join(dir, "finding.json")
    writeFileSync(findingPath, JSON.stringify(input.finding, null, 2), "utf8")

    const manifest: DoctorBackupManifest = {
      id,
      createdAt: now,
      findingId: input.finding.id,
      remedyClass: input.remedyClass,
      patient: input.finding.patient,
      doctorAttempt: input.doctorAttempt,
      backupPaths: [beforePath, findingPath],
      applyStatus: "pending",
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8")
    this.prune()
    return { manifest, dir, beforePath }
  }

  readManifest(backupId: string): DoctorBackupManifest | null {
    const path = join(this.rootDir, backupId, "manifest.json")
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, "utf8")) as DoctorBackupManifest
    } catch {
      return null
    }
  }

  readBefore(backupId: string): unknown | null {
    const path = join(this.rootDir, backupId, "before", "patient.json")
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, "utf8"))
    } catch {
      return null
    }
  }

  updateApplyStatus(
    backupId: string,
    applyStatus: DoctorBackupManifest["applyStatus"],
    note?: string,
  ): boolean {
    const manifest = this.readManifest(backupId)
    if (!manifest) return false
    const next: DoctorBackupManifest = {
      ...manifest,
      applyStatus,
      ...(note !== undefined ? { note } : {}),
    }
    writeFileSync(
      join(this.rootDir, backupId, "manifest.json"),
      JSON.stringify(next, null, 2),
      "utf8",
    )
    return true
  }

  writeAfter(backupId: string, after: unknown): void {
    const afterDir = join(this.rootDir, backupId, "after")
    mkdirSync(afterDir, { recursive: true })
    writeFileSync(
      join(afterDir, "patient.json"),
      JSON.stringify(after, null, 2),
      "utf8",
    )
  }

  /** Drop oldest / expired backups; never prune if dir missing. */
  prune(nowMs: number = Date.now()): number {
    if (!existsSync(this.rootDir)) return 0
    const entries = readdirSync(this.rootDir)
      .map((name) => {
        const dir = join(this.rootDir, name)
        try {
          const st = statSync(dir)
          if (!st.isDirectory()) return null
          return { name, dir, mtime: st.mtimeMs }
        } catch {
          return null
        }
      })
      .filter((e): e is { name: string; dir: string; mtime: number } => e !== null)
      .sort((a, b) => b.mtime - a.mtime)

    let removed = 0
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      const age = nowMs - e.mtime
      const overCount = i >= this.maxBackups
      const overAge = age > this.maxAgeMs
      if (overCount || overAge) {
        try {
          rmSync(e.dir, { recursive: true, force: true })
          removed++
        } catch {
          /* best-effort */
        }
      }
    }
    return removed
  }
}

export const patientKey = (p: DoctorPatient): string => `${p.kind}:${p.id}`
