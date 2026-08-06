/**
 * Guardian health-debounce journal: byte-exact port of health_journal_write's
 * printf format (scripts/luna-guardian:393-412). This module writes only;
 * reads go through `readKeyValue` in atomic-file.ts directly, the same
 * `status_value()` port status-file.ts's callers share - the raw read
 * health_journal_read and health_journal_zero_recorded both build on
 * (scripts/luna-guardian:271-275, 414-434). The freshness-window gating that
 * turns those raw fields into the HJ_NEGATIVE/HJ_UNKNOWN evidence a check
 * tick acts on (health_journal_read, scripts/luna-guardian:344-379) is
 * guardian's own supervision-loop concern and stays bash-only until that
 * loop is folded (S24, docs/deploy-binary.md).
 *
 * FORMAT IS A CONTRACT: field names, order and the trailing newline must
 * byte-match what the bash writer produces - see
 * apps/deploy-cli/test/update/health-journal-parity.test.ts.
 */
import { dirname, join } from "node:path"
import { atomicWriteFileSync, ensureStateDir } from "./atomic-file.js"

export interface HealthJournalRecord {
  readonly profile: string
  /** Unix seconds, matching `date +%s` (`updated_at`). */
  readonly updatedAt: number
  readonly repoSha: string
  readonly consecutiveNegative: number
  readonly negativeAt: number
  readonly consecutiveUnknown: number
  readonly lastRepairAt: number
}

/** `$STATE_DIR/health-$profile` (health_journal_path, scripts/luna-guardian:339). */
export const healthJournalPath = (stateDir: string, profile: string): string => join(stateDir, `health-${profile}`)

/** Byte-exact port of health_journal_write's printf (scripts/luna-guardian:401-402). */
export const writeHealthJournalSync = (path: string, record: HealthJournalRecord): void => {
  const contents =
    `profile=${record.profile}\n` +
    `updated_at=${record.updatedAt}\n` +
    `repo_sha=${record.repoSha}\n` +
    `consecutive_negative=${record.consecutiveNegative}\n` +
    `negative_at=${record.negativeAt}\n` +
    `consecutive_unknown=${record.consecutiveUnknown}\n` +
    `last_repair_at=${record.lastRepairAt}\n`
  ensureStateDir(dirname(path))
  atomicWriteFileSync(path, contents)
}
