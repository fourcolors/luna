#!/usr/bin/env bash
# PROBE:    one-line human title of the invariant this guards
# LESSON:   the red lesson / drift class (cite the date, e.g. 2026-06-14)
# SEVERITY: critical | high | normal
#
# Contract (see ../CONTRACT.md): exit 0 = PASS, 77 = SKIP, anything else = FAIL.
# Keep it deterministic, self-contained, and fast.
set -uo pipefail

# --- 0. preconditions: SKIP (77) if this host can't run the check -----------
# command -v some-tool >/dev/null 2>&1 || { echo "SKIP: some-tool absent"; exit 77; }

# --- 1. exercise the invariant ----------------------------------------------
# result="$(do_the_thing)"

# --- 2. assert; last line = the runner's summary ----------------------------
# if [[ "$result" == "$expected" ]]; then
#   echo "OK: <invariant> holds"
#   exit 0
# else
#   echo "DRIFT: <what changed> — got [$result]"
#   exit 1
# fi

echo "SKIP: _template.sh is not a real probe"
exit 77
