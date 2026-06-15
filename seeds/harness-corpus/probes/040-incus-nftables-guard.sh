#!/usr/bin/env bash
# PROBE:    incus firewall prerequisites are safe
# LESSON:   2026-06-13 — incus create-ops HANG when nf_tables module absent; and
#           enabling nftables.service runs `flush ruleset` which WIPES incus's NAT
#           rules, killing internet for every incusbr0 container. Invariant:
#           nf_tables loaded AND nftables.service NOT enabled.
# SEVERITY: critical
#
# Note: kernel modules are host-global (shared kernel), so the nf_tables check is
# meaningful even from inside a container; the service check reflects this
# runtime's systemd view.
set -uo pipefail

command -v lsmod     >/dev/null 2>&1 || { echo "SKIP: lsmod absent (not a Linux host)"; exit 77; }
command -v systemctl >/dev/null 2>&1 || { echo "SKIP: systemctl absent"; exit 77; }

fail=0
mod_ok=1; svc_bad=0

# Capture lsmod once: piping into `grep -q` under pipefail makes lsmod take
# SIGPIPE (grep closes early on match) and falsely reports "not loaded".
lsmod_out="$(lsmod 2>/dev/null)"
grep -q '^nf_tables' <<<"$lsmod_out" || { mod_ok=0; fail=1; }

enabled="$(systemctl is-enabled nftables.service 2>/dev/null || true)"
case "$enabled" in
  enabled|enabled-runtime) svc_bad=1; fail=1 ;;
esac

if [[ $fail -eq 0 ]]; then
  echo "OK: nf_tables loaded; nftables.service=${enabled:-absent} (not enabled)"
  exit 0
fi

msg="DRIFT:"
[[ $mod_ok  -eq 0 ]] && msg="$msg nf_tables module NOT loaded (incus create-ops will hang — modprobe nf_tables);"
[[ $svc_bad -eq 1 ]] && msg="$msg nftables.service is ENABLED (its flush ruleset will wipe incus NAT — systemctl disable nftables);"
echo "$msg"
exit 1
