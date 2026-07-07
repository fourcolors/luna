#!/usr/bin/env bash
# PROBE:    incus fence ACL egress reject rules must not contain the bridge gateway
# LESSON:   2026-07-07 — incus emits the broad reject rule BEFORE the narrow
#           allow-gateway rule regardless of the order they appear in the ACL
#           definition; if the gateway IP falls inside the reject destination
#           range, ALL container-to-gateway traffic is dropped (including Ollama
#           on :11434), crash-looping the chat-server with EmbedderError.
#           Fix: carve the gateway out of the reject destination so it is never
#           covered, making rule ordering irrelevant.
# SEVERITY: critical
#
# Contract: exit 0 = PASS, 77 = SKIP, anything else = FAIL.
set -uo pipefail

command -v incus >/dev/null 2>&1 || { echo "SKIP: incus not present"; exit 77; }
incus info >/dev/null 2>&1       || { echo "SKIP: incus daemon not reachable"; exit 77; }

# Collect all network ACLs whose name contains "fence"
mapfile -t fence_acls < <(incus network acl list --format csv 2>/dev/null | awk -F, '{print $1}' | grep -i 'fence' || true)

if [[ ${#fence_acls[@]} -eq 0 ]]; then
  echo "SKIP: no fence-like ACLs found (nothing to check)"
  exit 77
fi

fail=0
checked=0

# Convert a dotted-decimal IP to a 32-bit integer
_ip_to_int() {
  local IFS='.'
  read -r a b c d <<< "$1"
  printf '%d' $(( (a << 24) | (b << 16) | (c << 8) | d ))
}

# Return 0 if <ip> is contained within <dest> (CIDR or range notation)
_ip_in_dest() {
  local ip="$1" dest="$2"
  local ip_int
  ip_int="$(_ip_to_int "$ip")"

  if [[ "$dest" == *"/"* ]]; then
    # CIDR notation: a.b.c.d/prefix
    local net="${dest%%/*}" prefix="${dest##*/}"
    [[ "$prefix" =~ ^[0-9]+$ ]] || return 1
    local net_int mask
    net_int="$(_ip_to_int "$net")"
    mask=$(( ( 0xFFFFFFFF << (32 - prefix) ) & 0xFFFFFFFF ))
    [[ $(( ip_int & mask )) -eq $(( net_int & mask )) ]]
  elif [[ "$dest" == *"-"* ]]; then
    # Range notation: a.b.c.d-e.f.g.h
    local start_ip="${dest%%-*}" end_ip="${dest##*-}"
    local start_int end_int
    start_int="$(_ip_to_int "$start_ip")"
    end_int="$(_ip_to_int "$end_ip")"
    [[ $ip_int -ge $start_int && $ip_int -le $end_int ]]
  else
    # Single IP
    local single_int
    single_int="$(_ip_to_int "$dest")"
    [[ $ip_int -eq $single_int ]]
  fi
}

for acl_name in "${fence_acls[@]}"; do
  [[ -n "$acl_name" ]] || continue

  # Default bridge for fence ACLs; future: detect from ACL assignments
  local_bridge="incusbr0"

  gw_cidr="$(incus network get "$local_bridge" ipv4.address 2>/dev/null || true)"
  if [[ -z "$gw_cidr" ]]; then
    echo "SKIP: bridge $local_bridge has no ipv4.address — skipping ACL $acl_name"
    continue
  fi
  gw_ip="${gw_cidr%%/*}"

  acl_yaml="$(incus network acl show "$acl_name" 2>/dev/null || true)"
  if [[ -z "$acl_yaml" ]]; then
    echo "SKIP: could not read ACL $acl_name"
    continue
  fi

  # Extract reject destinations from egress section
  mapfile -t reject_dests < <(awk '
    /^egress:/ { in_egress=1; next }
    /^[a-z]/ && !/^egress:/ { in_egress=0 }
    in_egress && /action: reject/ { in_reject=1; next }
    in_egress && /action: allow/  { in_reject=0 }
    in_egress && in_reject && /destination:/ {
      gsub(/.*destination:[[:space:]]*/, "")
      gsub(/[[:space:]]*$/, "")
      if (length > 0) print
      in_reject=0
    }
  ' <<< "$acl_yaml" || true)

  (( checked++ )) || true

  for dest in "${reject_dests[@]}"; do
    [[ -n "$dest" ]] || continue
    if _ip_in_dest "$gw_ip" "$dest"; then
      printf 'DRIFT: ACL %s has egress reject destination "%s" which contains gateway %s\n' \
        "$acl_name" "$dest" "$gw_ip"
      printf '  This drops ALL container-to-gateway traffic (including Ollama on :11434).\n'
      printf '  Fix: recreate the ACL with scripts/luna-container-create --fence, which\n'
      printf '  derives a reject range that excludes the gateway.\n'
      printf '  See docs/runbooks/incus-fence-acl.md\n'
      fail=1
    fi
  done
done

if [[ $checked -eq 0 ]]; then
  echo "SKIP: fence ACLs found but none could be checked"
  exit 77
fi

if [[ $fail -ne 0 ]]; then
  exit 1
fi

echo "OK: all fence ACL egress reject destinations exclude the bridge gateway"
exit 0
