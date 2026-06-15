#!/usr/bin/env bash
# PROBE:    corpus self-integrity — runner, contract, and git are intact
# LESSON:   P0 bootstrap acceptance — an empty-but-runnable corpus must stay runnable
# SEVERITY: normal
#
# Smoke test for the harness itself: proves the runner contract is wired before
# any real lesson-probe is trusted. Guards against the corpus structure rotting.
set -uo pipefail

CORPUS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0

check() { # $1=desc  $2=test-expr-already-evaluated($?)
  if [[ $2 -eq 0 ]]; then :; else echo "MISSING: $1"; fail=1; fi
}

[[ -x "$CORPUS_DIR/run-corpus.sh" ]]; check "executable run-corpus.sh" $?
[[ -f "$CORPUS_DIR/CONTRACT.md" ]];  check "CONTRACT.md"               $?
[[ -d "$CORPUS_DIR/probes" ]];       check "probes/ directory"         $?
git -C "$CORPUS_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; check "under git" $?

if [[ $fail -eq 0 ]]; then
  echo "OK: corpus self-integrity intact (runner + contract + probes/ + git)"
  exit 0
fi
echo "DRIFT: corpus self-integrity broken"
exit 1
