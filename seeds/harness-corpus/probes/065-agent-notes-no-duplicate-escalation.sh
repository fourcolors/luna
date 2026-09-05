#!/usr/bin/env bash
# PROBE:    agent_notes — no kind has >= 5 consecutive identical summaries in 7 days
# LESSON:   a periodic job re-emitting a byte-identical agent_notes row every run
#           makes a standing unresolved condition indistinguishable from a new event
#           and buries the ledger in noise; gate periodic notes on a state fingerprint
#           with a heartbeat
# SEVERITY: high
#
# Contract (see ../CONTRACT.md): exit 0 = PASS, 77 = SKIP, anything else = FAIL.
# Parameterized: no absolute paths, no hostnames, no operator-specific identifiers.
set -uo pipefail

DB="${LUNA_DB:-$HOME/.luna/luna.db}"

# --- 0. preconditions: SKIP if sqlite3 absent or DB missing ------------------
command -v sqlite3 >/dev/null 2>&1 || { echo "SKIP: sqlite3 absent"; exit 77; }
[[ -f "$DB" ]] || { echo "SKIP: DB not found at $DB"; exit 77; }

# --- 1. query: for each kind, find the maximum run of consecutive identical
#     summaries within the last 7 days. A "run" is counted by comparing each
#     row to its predecessor (same kind, ordered by ts).
#
#     The window_size=5 threshold is chosen to allow brief back-to-back runs
#     (which can happen under contention or during startup) while catching the
#     pathological case of a periodic job that never gates its output.
THRESHOLD=5
DAYS=7
CUTOFF=$(( $(date +%s) * 1000 - DAYS * 86400 * 1000 ))

result=$(sqlite3 "$DB" << SQL
WITH
-- Rows from the last 7 days, ordered per kind by ts
recent AS (
  SELECT kind, summary, ts,
         ROW_NUMBER() OVER (PARTITION BY kind ORDER BY ts) AS rn
  FROM agent_notes
  WHERE ts >= ${CUTOFF}
),
-- Compare each row to its predecessor within the same kind
runs AS (
  SELECT
    cur.kind,
    cur.summary,
    cur.rn,
    CASE WHEN cur.summary = prev.summary THEN 1 ELSE 0 END AS same_as_prev
  FROM recent cur
  LEFT JOIN recent prev
    ON cur.kind = prev.kind AND cur.rn = prev.rn + 1
),
-- Assign a group id: a new group starts each time same_as_prev = 0
groups AS (
  SELECT
    kind, summary,
    SUM(1 - same_as_prev) OVER (PARTITION BY kind ORDER BY rn) AS grp
  FROM runs
),
-- Count the size of each run
run_sizes AS (
  SELECT kind, summary, grp, COUNT(*) AS run_len
  FROM groups
  GROUP BY kind, summary, grp
),
-- Find violations
violations AS (
  SELECT kind, MAX(run_len) AS max_run
  FROM run_sizes
  WHERE run_len >= ${THRESHOLD}
  GROUP BY kind
)
SELECT kind, max_run FROM violations ORDER BY max_run DESC LIMIT 10;
SQL
)

# --- 2. assert ---------------------------------------------------------------
if [[ -z "$result" ]]; then
  echo "OK: no kind has >= ${THRESHOLD} consecutive identical summaries in the last ${DAYS} days"
  exit 0
fi

# Print each offending kind
while IFS='|' read -r kind run_len; do
  echo "DRIFT: kind='${kind}' has ${run_len} consecutive identical summary rows (threshold: ${THRESHOLD})"
done <<< "$result"

first_kind=$(echo "$result" | head -1 | cut -d'|' -f1)
first_run=$(echo "$result" | head -1 | cut -d'|' -f2)
echo "DRIFT: agent_notes duplicate escalation — kind='${first_kind}' repeated ${first_run}x; use recordIfChanged to gate periodic notes"
exit 1
