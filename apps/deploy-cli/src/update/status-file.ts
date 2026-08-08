/**
 * Guardian status heartbeat: byte-exact port of write_guardian_status's
 * printf format (scripts/luna-guardian:283-326). This module writes only;
 * reads go through `readKeyValue` in atomic-file.ts directly, the same
 * `status_value()` port health-journal.ts's callers share
 * (scripts/luna-guardian:271-275). Pure state-file IO only - the "read the
 * previous count and increment" arithmetic that DECIDES consecutiveHealthy /
 * consecutiveRuntimeHealthy is guardian's own supervision-loop concern and
 * stays bash-only until that loop is folded (S24, docs/deploy-binary.md);
 * callers here pass every field explicit.
 *
 * FORMAT IS A CONTRACT: scripts/luna-guardian-remote-check parses this file
 * over ssh with `sed -n "s/^$1=//p" | head -1` (guardian-remote-check:34), so
 * field names, order and the trailing newline must byte-match what the bash
 * writer produces - see apps/deploy-cli/test/update/status-file-parity.test.ts,
 * which runs that exact sed idiom against a binary-written file.
 */
import { dirname, join } from "node:path"
import { atomicWriteFileSync, ensureStateDir } from "./atomic-file.js"

export interface GuardianStatus {
  readonly profile: string
  /** Unix seconds, matching `date +%s` (`completed_at`). */
  readonly completedAt: number
  readonly repoSha: string
  readonly engineSha: string
  readonly outcome: string
  readonly consecutiveHealthy: number
  readonly consecutiveRuntimeHealthy: number
}

/** `$STATE_DIR/status-$profile` (write_guardian_status, scripts/luna-guardian:286). */
export const statusFilePath = (stateDir: string, profile: string): string => join(stateDir, `status-${profile}`)

/** Byte-exact port of write_guardian_status's printf (scripts/luna-guardian:317-318). */
export const writeGuardianStatusSync = (path: string, status: GuardianStatus): void => {
  const contents =
    `profile=${status.profile}\n` +
    `completed_at=${status.completedAt}\n` +
    `repo_sha=${status.repoSha}\n` +
    `engine_sha=${status.engineSha}\n` +
    `outcome=${status.outcome}\n` +
    `consecutive_healthy=${status.consecutiveHealthy}\n` +
    `consecutive_runtime_healthy=${status.consecutiveRuntimeHealthy}\n`
  ensureStateDir(dirname(path))
  atomicWriteFileSync(path, contents)
}
