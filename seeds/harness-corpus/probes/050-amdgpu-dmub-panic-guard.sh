#!/usr/bin/env bash
# PROBE:    a stray recursive read cannot panic the host via the amdgpu DMUB
#           debugfs nodes, and where a bind-mount guard is deployed it is active
# LESSON:   2026-06-15 — reading /sys/kernel/debug/dri/*/amdgpu_dm_dmub_trace_mask
#           (and siblings _fw_state / _tracebuffer) NULL-derefs the amdgpu *_show
#           handler on a NULL DMUB srv pointer and kernel-PANICS the whole box
#           (seen on an Apple T2 / linux-t2 amdgpu build). debugfs is root-only and
#           we run as root, so OUR OWN broad recursive reads are the only trigger.
#           Invariant: (A) no tracked script does a recursive descent that can wander
#           into /sys|/proc|/sys/kernel/debug; (B) on a host where the bind-mount
#           guard is installed, every present DMUB node is neutralised by /dev/null.
# SEVERITY: critical
#
# SAFETY: this probe NEVER read()s a DMUB node (the only op that panics). It only
# stat/ls's node names, reads /proc/mounts, queries systemd, and greps tracked
# *script* files. It must never be edited to cat/grep the nodes themselves.
set -uo pipefail

command -v grep >/dev/null 2>&1 || { echo "SKIP: grep absent"; exit 77; }

DEBUG_DRI="/sys/kernel/debug/dri"
DMUB_NAMES="amdgpu_dm_dmub_trace_mask amdgpu_dm_dmub_fw_state amdgpu_dm_dmub_tracebuffer"

# --- Part A: behavioural invariant (portable) -------------------------------
# Scan tracked scripts for recursive-descent reads that could reach /sys et al.
# Operators point HARNESS_SCAN_DIRS at their infra dirs; default = corpus root.
corpus_root="$(cd "$(dirname "$0")/.." && pwd)"
scan_dirs="${HARNESS_SCAN_DIRS:-$corpus_root}"
scan_hits=""
IFS=':' read -r -a _dirs <<<"$scan_dirs"
# Dangerous = a script that RECURSIVELY greps (`grep -r/-R`), broadly finds
# (`find /`, `find /sys|/proc`), or DIRECTLY reads a debugfs path with a read
# verb. A bare glob/stat of /sys (as this guard does) is SAFE and must not match.
read_verbs='cat|head|tail|less|more|read|xxd|od|strings|awk|sed|while[[:space:]]+read'
dpat="grep[[:space:]]+-[a-zA-Z]*[rR]|find[[:space:]]+/(sys|proc|[[:space:]])|(${read_verbs})[[:space:]][^|;&]*/sys/kernel/debug"
for d in "${_dirs[@]}"; do
  [[ -e "$d" ]] || continue
  h="$(grep -rnE "$dpat" "$d" 2>/dev/null \
        | grep -vE 'node_modules|/\.git/|\.bak|README|CONTRACT|lessons\.md|050-amdgpu-dmub' \
        | awk -F: '{ c=$0; sub(/^[^:]*:[^:]*:/,"",c); sub(/^[[:space:]]+/,"",c); if (substr(c,1,1) != "#") print }' \
        || true)"
  [[ -n "$h" ]] && scan_hits+="$h"$'\n'
done

# --- Part B: bind-mount guard (only where deployed) -------------------------
# Detect the hazard node by NAME ONLY (ls = readdir+stat, never a read()).
node_present=0
for n in $DMUB_NAMES; do
  for p in "$DEBUG_DRI"/*/"$n"; do
    [[ -e "$p" ]] && { node_present=1; break 2; }
  done
done

guard_installed=0
if command -v systemctl >/dev/null 2>&1; then
  systemctl cat jax-dmub-guard.service >/dev/null 2>&1 && guard_installed=1
fi

guard_drift=""
if [[ $guard_installed -eq 1 ]]; then
  # Guard is deployed here: every PRESENT DMUB node must be bind-mounted.
  for n in $DMUB_NAMES; do
    for p in "$DEBUG_DRI"/*/"$n"; do
      [[ -e "$p" ]] || continue
      canon="$(readlink -f "$p" 2>/dev/null || echo "$p")"
      if ! awk -v m="$canon" '$2==m{f=1} END{exit !f}' /proc/mounts; then
        guard_drift+="unguarded:$canon "
      fi
    done
  done
fi

# --- verdict ----------------------------------------------------------------
fail=0; notes=""
if [[ -n "$scan_hits" ]]; then
  fail=1
  notes+="recursive /sys-reachable read in tracked scripts: $(echo "$scan_hits" | head -3 | tr '\n' ';'); "
fi
if [[ -n "$guard_drift" ]]; then
  fail=1
  notes+="DMUB guard REGRESSED (node exposed, box can panic): $guard_drift; "
fi

if [[ $fail -ne 0 ]]; then
  echo "DRIFT: $notes"
  exit 1
fi

# Decide PASS vs SKIP: PASS if we actually asserted something meaningful.
if [[ $guard_installed -eq 1 ]]; then
  echo "OK: scan clean; jax-dmub-guard active over all present DMUB nodes (node_present=$node_present)"
  exit 0
fi
if [[ $node_present -eq 1 ]]; then
  echo "SKIP: DMUB hazard node present but no bind-mount guard installed on this host (scan clean)"
  exit 77
fi
echo "OK: scan clean; no amdgpu DMUB hazard node on this host"
exit 0
