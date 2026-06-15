#!/usr/bin/env bash
# PROBE:    lesson<->probe coverage integrity (the mutation gate)
# LESSON:   P3 governance — no load-bearing red lesson without a probe or an
#           explicit waiver. Enforces the lessons.md registry against probes/.
# SEVERITY: normal
#
# FAILs if: a `covered` lesson names a missing/non-executable probe; a real
# lesson-probe exists but isn't registered as covered; or a `waived` lesson has
# no reason. This is what makes "add a red lesson -> add a probe" enforceable.
set -uo pipefail

CORPUS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REG="$CORPUS_DIR/lessons.md"
[[ -f "$REG" ]] || { echo "DRIFT: lessons.md registry missing"; exit 1; }

# meta-probes that guard the harness itself, not a lesson
SKIP_PROBES=("000-runner-selfcheck.sh" "005-lesson-coverage.sh")

trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }

errs=()
declare -A covered_probe

in_fence=0
while IFS= read -r line; do
  case "$line" in '```'*) in_fence=$((1 - in_fence)); continue ;; esac
  [[ $in_fence -eq 1 ]] || continue          # only parse rows inside the table fence
  [[ -z "${line//[[:space:]]/}" ]] && continue
  IFS='|' read -r id status probe note _rest <<<"$line"
  id="$(trim "${id:-}")"
  [[ -z "$id" || "${id:0:1}" == "#" || "$id" == "id" ]] && continue
  status="$(trim "${status:-}")"
  probe="$(trim "${probe:-}")"
  note="$(trim "${note:-}")"
  case "$status" in
    covered)
      if [[ -z "$probe" || "$probe" == "-" ]]; then
        errs+=("lesson '$id' is covered but names no probe")
      elif [[ ! -f "$CORPUS_DIR/$probe" ]]; then
        errs+=("lesson '$id' -> $probe (probe file missing)")
      elif [[ ! -x "$CORPUS_DIR/$probe" ]]; then
        errs+=("lesson '$id' -> $probe (probe not executable)")
      else
        covered_probe["$(basename "$probe")"]=1
      fi
      ;;
    waived)
      [[ -z "$note" ]] && errs+=("lesson '$id' is waived but gives no reason")
      ;;
    *)
      errs+=("lesson '$id' has unknown status '$status'")
      ;;
  esac
done < "$REG"

# every real lesson-probe must be registered as covered
shopt -s nullglob
for p in "$CORPUS_DIR"/probes/*.sh; do
  bn="$(basename "$p")"
  [[ "$bn" == _* ]] && continue
  for s in "${SKIP_PROBES[@]}"; do [[ "$bn" == "$s" ]] && continue 2; done
  [[ -n "${covered_probe[$bn]:-}" ]] || errs+=("probe $bn is not registered as a covered lesson in lessons.md")
done

if [[ ${#errs[@]} -eq 0 ]]; then
  echo "OK: lesson<->probe coverage intact (${#covered_probe[@]} lesson probes registered, registry consistent)"
  exit 0
fi
for e in "${errs[@]}"; do echo "DRIFT: $e"; done
echo "DRIFT: ${#errs[@]} coverage violation(s)"
exit 1
