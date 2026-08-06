/**
 * Exit-code contract for the deploy binary, carried forward VERBATIM from the
 * bash engine it replaces (scripts/luna-update-server:171-184) so a caller
 * (systemd, luna-guardian-remote-check, an operator's shell) reads the same
 * numbers regardless of which engine produced them. No scaffold-only aliases
 * live here - a stub subcommand exits `CRITICAL` (2) directly (the correct
 * "something is wrong, look closer" code for an unimplemented path), keeping
 * this table a faithful copy of the bash contract rather than a superset of it.
 */
export const EXIT_CODES = {
  /** Updated and healthy (or up-to-date / no-op). */
  OK: 0,
  /** Preflight error, OR readiness failed but rollback succeeded. */
  ROLLED_BACK: 1,
  /** CRITICAL: readiness failed AND rollback also failed (manual intervention required). */
  CRITICAL: 2,
  /** Deferred by the session guard (live or unknown sessions). */
  DEFERRED_SESSION_GUARD: 3,
  /** --restart-only only: deferred because another update holds the profile lock. */
  DEFERRED_LOCK_CONTENTION: 4,
} as const
