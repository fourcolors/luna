#!/usr/bin/env bash
# run-corpus.sh — Harness Regression Corpus runner (Epic #9, P0)
#
# Discovers every executable probe in ./probes/, runs each under a timeout,
# and reports PASS / FAIL / SKIP per the probe contract (see CONTRACT.md).
#
#   exit 0   from a probe -> PASS  (the guarded invariant still holds)
#   exit 77  from a probe -> SKIP  (precondition unmet; not a regression)
#   anything else         -> FAIL  (drift/regression detected) — includes 124 timeout
#
# Runner exit code: 0 if zero FAILs, 1 if any FAIL, 2 on usage error.
#
# Usage:
#   ./run-corpus.sh              # human-readable table
#   ./run-corpus.sh --json       # machine-readable (for the nightly workflow)
#   ./run-corpus.sh --filter foo # only probes whose filename contains "foo"
#   PROBE_TIMEOUT=60 ./run-corpus.sh
set -uo pipefail

CORPUS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_DIR="$CORPUS_DIR/probes"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-120}"
JSON=0
FILTER=""

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)    JSON=1; shift ;;
    --filter)  FILTER="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "run-corpus: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -d "$PROBE_DIR" ]] || { echo "run-corpus: no probes/ dir at $PROBE_DIR" >&2; exit 2; }

# --- discover probes -------------------------------------------------------
shopt -s nullglob
probes=()
for p in "$PROBE_DIR"/*.sh; do
  bn="$(basename "$p")"
  [[ "$bn" == _* ]] && continue                       # _template.sh, _lib.sh, ...
  [[ -n "$FILTER" && "$bn" != *"$FILTER"* ]] && continue
  [[ -x "$p" ]] || continue                           # contract: probes are executable
  probes+=("$p")
done
IFS=$'\n' probes=($(printf '%s\n' "${probes[@]}" | sort)); unset IFS

# --- probe metadata helper -------------------------------------------------
probe_field() { # $1=file $2=field-name -> value or ""
  grep -m1 -E "^#[[:space:]]*$2:" "$1" 2>/dev/null | sed -E "s/^#[[:space:]]*$2:[[:space:]]*//"
}

# --- run -------------------------------------------------------------------
pass=0; fail=0; skip=0
rows=()        # human rows
jrows=()       # json objects

for p in "${probes[@]}"; do
  name="$(basename "$p" .sh)"
  title="$(probe_field "$p" PROBE)"; title="${title:-$name}"
  t0=$(date +%s%N 2>/dev/null || echo 0)
  out="$(timeout "$PROBE_TIMEOUT" "$p" 2>&1)"; rc=$?
  t1=$(date +%s%N 2>/dev/null || echo 0)
  dur=$(( (t1 - t0) / 1000000 )); [[ $dur -lt 0 ]] && dur=0

  case $rc in
    0)  status="PASS"; ((pass++)) ;;
    77) status="SKIP"; ((skip++)) ;;
    *)  status="FAIL"; ((fail++)) ;;
  esac
  [[ $rc -eq 124 ]] && title="$title (TIMEOUT ${PROBE_TIMEOUT}s)"

  # one-line summary = last non-empty line of probe output
  summary="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n1)"

  rows+=("$(printf '%-6s %-32s %s' "$status" "$name" "$summary")")

  esc() { printf '%s' "$1" | python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))'; }
  jrows+=("{\"name\":$(esc "$name"),\"title\":$(esc "$title"),\"status\":\"$status\",\"exit\":$rc,\"duration_ms\":$dur,\"summary\":$(esc "$summary")}")
done

total=${#probes[@]}

# --- emit ------------------------------------------------------------------
if [[ $JSON -eq 1 ]]; then
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"ts":"%s","corpus":"%s","total":%d,"pass":%d,"fail":%d,"skip":%d,"probes":[%s]}\n' \
    "$ts" "$CORPUS_DIR" "$total" "$pass" "$fail" "$skip" "$(IFS=,; echo "${jrows[*]:-}")"
else
  echo "harness regression corpus — $CORPUS_DIR"
  echo "------------------------------------------------------------------"
  if [[ $total -eq 0 ]]; then
    echo "(no probes found — corpus is empty but runnable)"
  else
    for r in "${rows[@]}"; do echo "$r"; done
  fi
  echo "------------------------------------------------------------------"
  printf 'total=%d  pass=%d  fail=%d  skip=%d\n' "$total" "$pass" "$fail" "$skip"
fi

# any FAIL => red
[[ $fail -gt 0 ]] && exit 1 || exit 0
