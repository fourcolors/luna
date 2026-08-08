/**
 * Shared temp-dir bookkeeping for the update/guardian bash-fixture rigs
 * (bash-fixtures.ts, guardian-fixtures.ts): both mkdtemp a scratch root per
 * fixture and must recursively remove it after each test. Split out so the
 * two rigs share one implementation instead of two copies that differ only
 * in the mkdtemp prefix string.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const repoRoot = new URL("../../../..", import.meta.url).pathname

const tempDirs: string[] = []

export const makeTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

export const cleanupTempDirs = (): void => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}
