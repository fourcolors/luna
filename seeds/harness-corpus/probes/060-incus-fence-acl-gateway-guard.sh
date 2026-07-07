#!/usr/bin/env bash
# PROBE:    incus fence ACL egress reject rules must not contain the gateway of
#           the bridge the ACL is attached to
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

# Collect all network ACLs that look like fence ACLs (name contains "fence")
mapfile -t fence_acls < <(incus network acl list --format csv 2>/dev/null | awk -F, '{print $1}' | grep -i 'fence' || true)

if [[ ${#fence_acls[@]} -eq 0 ]]; then
  echo "SKIP: no fence-like ACLs found (nothing to check)"
  exit 77
fi

fail=0
checked=0

# Helper: check if an IP is contained in a range or CIDR
# Usage: _ip_in_dest <ip> <dest>
# dest can be: a.b.c.d/prefix  or  a.b.c.d-a.b.c.e
_ip_to_int() {
  local IFS='.'
  read -r a b c d <<< "$1"
  printf '%d' $(( (a << 24) | (b << 16) | (c << 8) | d ))
}

_ip_in_dest() {
  local ip="$1" dest="$2"
  local ip_int
  ip_int="$(_ip_to_int "$ip")"

  if [[ "$dest" == *"/"* ]]; then
    # CIDR notation
    local net="${dest%%/*}" prefix="${dest##*/}"
    [[ "$prefix" =~ ^[0-9]+$ ]] || return 1
    local net_int mask
    net_int="$(_ip_to_int "$net")"
    mask=$(( ( 0xFFFFFFFF << (32 - prefix) ) & 0xFFFFFFFF ))
    [[ $(( ip_int & mask )) -eq $(( net_int & mask )) ]]
  elif [[ "$dest" == *"-"* ]]; then
    # Range notation
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

  acl_yaml="$(incus network acl show "$acl_name" 2>/dev/null || true)"
  if [[ -z "$acl_yaml" ]]; then
    echo "SKIP: could not read ACL $acl_name"
    continue
  fi

  # Resolve which network bridges this ACL is attached to via used_by: entries
  # of the form /1.0/networks/<bridge>.  NIC-level attachments (/1.0/instances/...)
  # are intentionally ignored here; we only check network-level fence semantics.
  # Uses grep + sed for mawk compatibility (avoids 3-arg match()).
  mapfile -t bridges < <(
    awk '
      /^used_by:/ { in_used=1; next }
      /^[a-z_]/ && !/^used_by:/ { in_used=0 }
      in_used { print }
    ' <<< "$acl_yaml" \
    | grep '/1\.0/networks/' \
    | sed 's|.*/1\.0/networks/||; s|[[:space:]"]*$||' \
    || true
  )

  if [[ ${#bridges[@]} -eq 0 ]]; then
    echo "SKIP: ACL $acl_name has no network used_by entries — skipping"
    continue
  fi

  # Extract egress reject destinations from the ACL YAML.
  # YAML list structure under egress: each rule is a block starting with
  # "- action: ..." (with or without leading spaces).  We collect destination:
  # values only from blocks whose action is reject.
  mapfile -t reject_dests < <(awk '
    /^egress:/ { in_egress=1; in_reject=0; next }
    /^[a-z_]/ && !/^egress:/ { in_egress=0; in_reject=0 }
    in_egress && /^[[:space:]]*-[[:space:]]*action:[[:space:]]*reject/ { in_reject=1; next }
    in_egress && /^[[:space:]]*-[[:space:]]*action:/ { in_reject=0; next }
    in_egress && in_reject && /[[:space:]]destination:/ {
      gsub(/^[[:space:]]*destination:[[:space:]]*/, "")
      gsub(/[[:space:]]*$/, "")
      if (length($0) > 0) print
    }
  ' <<< "$acl_yaml" || true)

  # Check each attached bridge's gateway against the reject destinations
  for bridge in "${bridges[@]}"; do
    gw_cidr="$(incus network get "$bridge" ipv4.address 2>/dev/null || true)"
    if [[ -z "$gw_cidr" ]]; then
      echo "SKIP: bridge $bridge has no ipv4.address — skipping ACL $acl_name on this bridge"
      continue
    fi
    gw_ip="${gw_cidr%%/*}"

    (( checked++ )) || true

    for dest in "${reject_dests[@]}"; do
      [[ -n "$dest" ]] || continue
      if _ip_in_dest "$gw_ip" "$dest"; then
        printf 'DRIFT: ACL %s (attached to bridge %s, gateway %s) has egress reject destination "%s" which contains that bridge'"'"'s gateway\n' \
          "$acl_name" "$bridge" "$gw_ip" "$dest"
        printf '  This causes ALL container-to-gateway traffic to be dropped (including Ollama).\n'
        printf '  Fix: recreate the ACL with luna-container-create --fence, which derives a\n'
        printf '  reject range that excludes the gateway.\n'
        fail=1
      fi
    done
  done
done

if [[ $checked -eq 0 ]]; then
  echo "SKIP: fence ACLs found but none could be checked (no resolvable bridge gateways)"
  exit 77
fi

if [[ $fail -ne 0 ]]; then
  exit 1
fi

echo "OK: all fence ACL egress reject destinations exclude the gateway of the bridge they are attached to"
exit 0
