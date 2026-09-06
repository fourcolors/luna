#!/usr/bin/env bash
# Shared helpers for repo-local Luna deployment scripts.

luna_info() { printf '%s\n' "-> $*"; }
luna_warn() { printf 'warning: %s\n' "$*" >&2; }
luna_die() { printf 'error: %s\n' "$*" >&2; exit 1; }

luna_run() {
  if [[ "${DRY_RUN:-false}" == true ]]; then
    printf '+'
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf '\n'
  else
    "$@"
  fi
}

luna_redact_if_secret() {
  case "$1" in
    *TOKEN*|*token*|*SECRET*|*secret*) printf '<redacted>' ;;
    *) printf '%s' "$2" ;;
  esac
}

luna_print_assignment() {
  local key="$1"
  local value="$2"
  printf '%s=' "$key"
  luna_redact_if_secret "$key" "$value"
  printf '\n'
}

luna_upsert_env() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  [[ -n "$value" ]] || return 0

  if [[ "${DRY_RUN:-false}" == true ]]; then
    luna_print_assignment "$key" "$value"
    return 0
  fi

  mkdir -p "$(dirname "$env_file")"
  touch "$env_file"
  chmod 600 "$env_file"

  # Create the temp file beside the target so the rename below is an atomic,
  # same-filesystem operation. A system `mktemp` (e.g. /tmp) can be on a
  # different filesystem, turning `mv` into a non-atomic copy-then-delete that
  # can lose the .env entirely if the process is killed mid-write.
  local tmp
  tmp="$(mktemp "$env_file.XXXXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 { print key "=" value; replaced = 1; next }
    { print }
    END { if (replaced == 0) print key "=" value }
  ' "$env_file" > "$tmp"
  mv "$tmp" "$env_file"
  chmod 600 "$env_file"
}

luna_remove_env() {
  local env_file="$1"
  local key="$2"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    printf 'unset %s\n' "$key"
    return 0
  fi

  [[ -f "$env_file" ]] || return 0

  # Temp file beside the target → atomic same-filesystem rename (see luna_upsert_env).
  local tmp
  tmp="$(mktemp "$env_file.XXXXXXXX")"
  awk -v key="$key" '
    index($0, key "=") == 1 { next }
    { print }
  ' "$env_file" > "$tmp"
  mv "$tmp" "$env_file"
  chmod 600 "$env_file"
}

luna_env_value() {
  local env_file="$1"
  local key="$2"
  [[ -f "$env_file" ]] || return 1

  awk -F= -v key="$key" '
    $1 == key {
      print substr($0, length(key) + 2)
      found = 1
      exit
    }
    END { exit found ? 0 : 1 }
  ' "$env_file"
}

luna_find_claude_executable() {
  local repo_dir="$1"
  local candidate

  # Prefer the repo's own installed SDK binary before falling back to PATH.
  # Detection priority mirrors the TS healer (claude-executable.ts):
  #   1. The glibc platform package inside node_modules (never the -musl twin,
  #      which errors "cannot execute: required file not found" on glibc hosts).
  #   2. PATH claude, as a last resort.
  # Each candidate is verified with `--version` rather than just -x, so a
  # mis-architecture binary (musl on glibc, wrong arch) is rejected early.
  #
  # WHY repo-first: `command -v claude` in PATH on a live host resolves the
  # INSTALLED symlink at /usr/local/bin/claude — a symlink that may point at a
  # stale SDK release (e.g. 0.3.175 on a box whose lockfile already has 0.3.239+).
  # Checking PATH first re-pins the stale binary even after a successful
  # bun install, making the bump a runtime no-op.

  if [[ -d "$repo_dir/node_modules" ]]; then
    # Hoisted layout: node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude
    candidate="$(
      find "$repo_dir/node_modules" \
        -path '*/@anthropic-ai/claude-agent-sdk-linux-x64/claude' \
        -not -path '*-musl*' \
        -type f -perm -111 2>/dev/null |
        sort |
        tail -n 1
    )"
    if [[ -n "$candidate" ]] && "$candidate" --version >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  # PATH fallback (e.g. the operator has no node_modules yet — fresh install path).
  if command -v claude >/dev/null 2>&1; then
    candidate="$(command -v claude)"
    if "$candidate" --version >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
    luna_warn "claude found in PATH ($candidate) but --version failed — skipping stale/mis-arch binary"
  fi

  return 1
}

luna_configure_claude_executable() {
  local env_file="$1"
  local repo_dir="$2"
  local value
  value="$(luna_env_value "$env_file" LUNA_CLAUDE_CODE_EXECUTABLE || true)"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    return 0
  fi

  if [[ -n "$value" && -x "$value" ]]; then
    return 0
  fi

  if [[ -n "$value" ]]; then
    luna_warn "removing stale LUNA_CLAUDE_CODE_EXECUTABLE ($value is not executable)"
    luna_remove_env "$env_file" "LUNA_CLAUDE_CODE_EXECUTABLE"
  fi

  local detected
  detected="$(luna_find_claude_executable "$repo_dir" || true)"
  if [[ -n "$detected" ]]; then
    luna_upsert_env "$env_file" "LUNA_CLAUDE_CODE_EXECUTABLE" "$detected"
  fi
}

# luna_repin_claude_executable <env_file> <repo_dir>
#
# Unconditionally re-detect and re-write LUNA_CLAUDE_CODE_EXECUTABLE.
# Unlike luna_configure_claude_executable, this function BYPASSES the
# keep-if-executable guard so a stale-but-executable pin (e.g. a 0.3.175
# symlink still pointing at the old release after a lockfile-bumping bun
# install) gets replaced by the freshly-installed binary.
#
# Call this AFTER a lockfile-changing bun install, mirroring repin_claude_releases
# which does the same for the releases layout. If detection finds nothing, the
# old pin is cleared and a warn-only degraded notice is emitted (the server
# still boots, just cannot spawn claude — same posture as repin_claude_releases).
luna_repin_claude_executable() {
  local env_file="$1"
  local repo_dir="$2"

  [[ "${DRY_RUN:-false}" == true ]] && return 0

  local detected
  detected="$(luna_find_claude_executable "$repo_dir" || true)"

  local old_pin
  old_pin="$(luna_env_value "$env_file" LUNA_CLAUDE_CODE_EXECUTABLE 2>/dev/null || true)"

  if [[ -n "$detected" ]]; then
    if [[ "$old_pin" != "$detected" ]]; then
      [[ -n "$old_pin" ]] && luna_warn "replacing stale claude pin: $old_pin -> $detected"
      luna_upsert_env "$env_file" "LUNA_CLAUDE_CODE_EXECUTABLE" "$detected"
    fi
  else
    if [[ -n "$old_pin" ]]; then
      luna_warn "no usable claude binary found after bun install; clearing stale pin: $old_pin"
      luna_remove_env "$env_file" "LUNA_CLAUDE_CODE_EXECUTABLE"
    fi
    luna_warn "POSTCONDITION degraded: no usable claude executable detected — server will boot but cannot spawn claude"
  fi
}

luna_env_has_nonempty_key() {
  local env_file="$1"
  shift
  [[ -f "$env_file" ]] || return 1

  local key
  for key in "$@"; do
    if awk -F= -v key="$key" '
      $1 == key {
        value = substr($0, length(key) + 2)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        if (value != "") found = 1
      }
      END { exit found ? 0 : 1 }
    ' "$env_file"; then
      return 0
    fi
  done
  return 1
}

# True if the server's UI WebSocket secret is present in the given .env.
# UI_WS_TOKEN is the canonical name; LUNA_UI_WS_TOKEN is a back-compat alias.
# Accept BOTH — never drop a name, so older on-disk .env files still pass (#6).
luna_env_has_token() {
  luna_env_has_nonempty_key "$1" UI_WS_TOKEN LUNA_UI_WS_TOKEN
}

luna_profile_env_name() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]/_/g'
}

luna_validate_profile() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] ||
    luna_die "profile must contain only letters, numbers, dot, underscore, or dash"
}

luna_service_name() {
  if [[ "$1" == "stable" ]]; then
    printf 'luna-chat-server.service\n'
  else
    printf 'luna-%s-chat-server.service\n' "$1"
  fi
}

luna_chat_server_name() {
  local service_name
  service_name="$(luna_service_name "$1")"
  printf '%s\n' "${service_name%.service}"
}

# Resolve a safe default bind/listen address for a remote-serving install when
# the operator did NOT choose one explicitly. Returns the host's Tailscale IPv4
# if a tailnet is present (the normal remote-serving case: reachable by tailnet
# peers over an encrypted link, never exposed on the public wire), else loopback
# 127.0.0.1 with a warning that the server will be local-only. Explicit
# env/flag/--i-understand-public always win in the caller; this only fills the
# unset default. The IP is printed to stdout; any warning goes to stderr
# (luna_warn), so `addr="$(luna_resolve_bind_addr)"` captures only the address.
#
# Why auto-detect: the primary Luna deployment is "server on a Linux box, reached
# from the Mac over Tailscale." A loopback-only default would make that documented
# path bind 127.0.0.1 and refuse every tailnet peer — a fresh remote install dead
# out of the box. Binding the tailnet interface makes the primary case Just Work
# while staying off any public interface.
#
# Test seam: if LUNA_TAILSCALE_IP is set (even to empty), its value is used
# verbatim instead of shelling out to `tailscale` — lets tests pin the outcome
# deterministically (same pattern as LUNA_TEST_BUN_PATH below). An empty value
# forces the loopback fallback; a tailnet IP exercises the detected path.
luna_resolve_bind_addr() {
  local ts=""
  if [[ "${LUNA_TAILSCALE_IP+set}" == "set" ]]; then
    ts="$LUNA_TAILSCALE_IP"
  elif command -v tailscale >/dev/null 2>&1; then
    ts="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  fi
  if [[ -n "$ts" ]]; then
    printf '%s' "$ts"
    return 0
  fi
  luna_warn "no Tailscale interface detected — binding to loopback (127.0.0.1); the server will be reachable only from this machine. To serve remote clients, bring Tailscale up and re-run, pass an explicit address (--bind-host/--listen-addr <tailnet-ip>), or pass --i-understand-public for an (unsafe) public 0.0.0.0 bind."
  printf '127.0.0.1'
}

# Count ESTABLISHED TCP connections on a given server port, optionally through
# an Incus container boundary.
#
# Why a shared helper: both luna-autodeploy (systemd poll-deploy) and the
# forthcoming `luna update` CLI (Slice 4) need the same connect-aware deferral
# logic — "don't restart the server while the operator is mid-conversation."
# Centralising here means one implementation to audit and one set of tests.
#
# Signature: luna_active_ws_count <port> [incus_container]
#   <port>             — the server's WebSocket listen port (e.g. 4753)
#   [incus_container]  — when non-empty, run ss(8) INSIDE the named Incus
#                        instance. Dev terminates connections inside the container
#                        (the host-side incusd proxy is transparent to ss), so
#                        checking the host would always return 0 and defeat the
#                        deferral guard.
#
# Returns non-zero when the count cannot be established. This is load-bearing:
# an unavailable `ss`, an installed-but-FAILING `ss`, a stopped Incus instance,
# or a failed exec is UNKNOWN, never "zero sessions". Unattended callers must
# fail closed and defer; an operator can still use their explicit force lever.
# The count is now also consumed by the deploy engine's in-primitive session
# guard (scripts/luna-update-server restart_session_guard), where a false
# "zero sessions" would authorize a restart — so a present-but-failing ss
# pipeline must report UNKNOWN, never 0.
#
# Test seam: if LUNA_TEST_WS_COUNT is set, a decimal value is returned verbatim;
# the literal `unknown` simulates an unavailable probe. Empty/garbage values are
# rejected instead of silently becoming zero.
luna_active_ws_count() {
  local port="$1"
  local incus="${2:-}"
  local n

  if [[ "${LUNA_TEST_WS_COUNT+set}" == "set" ]]; then
    n="$LUNA_TEST_WS_COUNT"
    [[ "$n" =~ ^[0-9]+$ ]] || return 1
    printf '%s' "$n"
    return
  fi

  # A SERVER TALKING TO ITSELF IS NOT A SESSION, and counting it as one froze a
  # channel for 154 commits while reporting success every three minutes.
  #
  # The chat server holds a loopback connection to its own port: both ends are
  # owned by the unit's own MainPID. The old count was `established` sockets
  # with `sport = :PORT`, which includes that self-pair, so the guard saw one
  # phantom session forever, deferred every deploy, and exited 0 looking
  # healthy. Nothing ever escalated, because deferring IS the correct answer to
  # a real session; only the count was wrong.
  #
  # The discriminator is ownership, not address. A real client reaches the
  # container through a forwarder, so the far end is a different process (and on
  # a remote client, not in this namespace at all). A self-connection has the
  # SAME pid on both ends. So: subtract only those established sockets that are
  # connected TO the port and owned by the pid that owns the LISTENER.
  #
  # IT FAILS SAFE BY CONSTRUCTION. `ss -p` needs privileges to name a process;
  # where it cannot, `lp` is empty, `self` stays 0, and the result is exactly
  # the old count. Undercounting drops live users mid-conversation, so every
  # uncertain path here must round UP, never down.
  #
  # THE SNIPPET CARRIES NO COMMENTS, deliberately. Its text is passed verbatim
  # as an argument to `sh -c` (and to `incus exec ... -- sh -c` on a container),
  # so it appears in the deploy engine's own command trace, and the TypeScript
  # port must run the IDENTICAL text or the two engines diverge. Explanations
  # therefore live out here, where they cost nothing. GATE 1's trace diff caught
  # the first version of this fix precisely because its inline comments made the
  # two engines' traced commands differ.
  #
  # ON THE UNPIPED ss CAPTURE, which is the subtle line: piping ss into grep or
  # wc hands the pipeline grep's exit status instead of ss's, and a FAILING ss
  # then reads as "zero sessions", which authorizes a restart and drops live
  # users. That is the hole the original implementation was hardened against,
  # and it is easy to reintroduce while tidying, so the capture stays plain.
  #
  # The -p probes are BEST EFFORT: they only ever subtract, so a failure there
  # must leave the count untouched rather than fail the whole call.
  #
  # ONE implementation, run either inside the container or on the host, because
  # two copies of a rule this subtle will drift.
  local probe='
port="$1"
command -v ss >/dev/null 2>&1 || exit 9
out="$(ss -tnH state established "( sport = :$port )" 2>/dev/null)" || exit 1
if [ -n "$out" ]; then total="$(printf "%s\n" "$out" | wc -l)"; else total=0; fi
lp="$(ss -tlnHp "( sport = :$port )" 2>/dev/null | grep -o "pid=[0-9]*" | head -1)" || lp=""
self=0
if [ -n "$lp" ]; then
  selfout="$(ss -tnHp state established "( dport = :$port )" 2>/dev/null)" || selfout=""
  if [ -n "$selfout" ]; then self="$(printf "%s\n" "$selfout" | grep -c "$lp," || true)"; fi
fi
[ -n "$self" ] || self=0
n=$((total - self))
[ "$n" -lt 0 ] && n=0
printf "%s" "$n"
'
  local out
  if [[ -n "$incus" ]]; then
    command -v incus >/dev/null 2>&1 || return 1
    out="$(incus exec "$incus" -- sh -c "$probe" _ "$port" 2>/dev/null)" || return 1
  else
    out="$(sh -c "$probe" _ "$port" 2>/dev/null)" || return 1
  fi
  n="$out"
  n="$(printf '%s' "$n" | tr -d '[:space:]')"
  [[ "$n" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$n"
}

# ── session-defer staleness (deploy.maxSessionDefer) ──────────────────────────
# Standing Moon sockets (hub + panel-chat) are ESTABLISHED forever and used to
# starve origin/master forever while every timer tick exited 0 looking healthy.
# luna_active_ws_count still counts those sockets (self-sessions already
# subtracted); this pair of helpers is the complementary gate: after
# deploy.maxSessionDefer wall-clock since the FIRST live-session defer for a
# profile, unattended apply proceeds and logs STALENESS — never an operator
# override. Unknown counts stay fail-closed and do not advance this clock.
#
# Test seam: LUNA_TEST_NOW_EPOCH pins wall-clock seconds (hermetic aged tests).

# luna_now_epoch — wall-clock seconds; LUNA_TEST_NOW_EPOCH wins when set.
luna_now_epoch() {
  if [[ "${LUNA_TEST_NOW_EPOCH+set}" == "set" && "$LUNA_TEST_NOW_EPOCH" =~ ^[0-9]+$ ]]; then
    printf '%s' "$LUNA_TEST_NOW_EPOCH"
    return 0
  fi
  date +%s
}

# luna_parse_systemd_duration <span>
# Prints integer seconds. Accepts systemd-style spans ("4h", "1h 30min", "90m",
# bare seconds). "infinity" / "0" / "0s" print 0 (caller treats 0 as "never
# force-apply on standing sessions" — fail closed toward not dropping users).
# Returns non-zero on garbage.
luna_parse_systemd_duration() {
  local raw="${1:-}" total=0 tok num unit
  # Lowercase via tr (bash 3.2-safe; macOS /bin/bash has no ${var,,}).
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  [[ -n "$raw" ]] || return 1
  if [[ "$raw" == "infinity" ]]; then
    printf '0'
    return 0
  fi
  # shellcheck disable=SC2086  # intentional word-split on space-separated tokens
  for tok in $raw; do
    if [[ "$tok" =~ ^([0-9]+)([a-z]*)$ ]]; then
      num="${BASH_REMATCH[1]}"
      unit="${BASH_REMATCH[2]}"
      case "$unit" in
        ""|s|sec|secs|second|seconds) total=$((total + num)) ;;
        m|min|mins|minute|minutes) total=$((total + num * 60)) ;;
        h|hr|hrs|hour|hours) total=$((total + num * 3600)) ;;
        d|day|days) total=$((total + num * 86400)) ;;
        w|week|weeks) total=$((total + num * 604800)) ;;
        *) return 1 ;;
      esac
    else
      return 1
    fi
  done
  printf '%s' "$total"
}

# luna_session_defer_state_path <profile>
luna_session_defer_state_path() {
  local profile="$1"
  local dir="${LUNA_UPDATE_STATE_DIR:-${LUNA_HOME:-${HOME:-/root}/.luna}/update}"
  printf '%s/session-defer-%s' "$dir" "$profile"
}

# luna_session_defer_mark <profile> — record first live-session defer (idempotent).
luna_session_defer_mark() {
  local profile="$1" path dir tmp since
  path="$(luna_session_defer_state_path "$profile")"
  dir="$(dirname "$path")"
  # shellcheck disable=SC2174  # mkdir -p -m 0700 applies mode to deepest dir only - acknowledged; known-red follow-up
  mkdir -p -m 0700 "$dir" 2>/dev/null || true
  if [[ -f "$path" ]]; then
    since="$(grep -E '^since=' "$path" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')"
    [[ "$since" =~ ^[0-9]+$ ]] && return 0
  fi
  tmp="$path.tmp.$$"
  if ! ( umask 077; printf 'since=%s\n' "$(luna_now_epoch)" > "$tmp" 2>/dev/null ); then
    rm -f "$tmp" 2>/dev/null || true
    return 0
  fi
  mv "$tmp" "$path" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
}

# luna_session_defer_clear <profile>
luna_session_defer_clear() {
  rm -f "$(luna_session_defer_state_path "$1")" 2>/dev/null || true
}

# luna_session_defer_aged <profile> <max_secs>
# Returns 0 when a prior live-session defer window has aged past max_secs
# (caller may apply as staleness). Returns 1 while still within the window, or
# when max_secs is 0 (disabled / infinity). Marks the clock on every call with
# a known live-session count so the first defer starts the window.
luna_session_defer_aged() {
  local profile="$1" max_secs="$2" path since now age
  [[ "$max_secs" =~ ^[0-9]+$ ]] || return 1
  (( max_secs > 0 )) || return 1
  luna_session_defer_mark "$profile"
  path="$(luna_session_defer_state_path "$profile")"
  since="$(grep -E '^since=' "$path" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')"
  [[ "$since" =~ ^[0-9]+$ ]] || return 1
  now="$(luna_now_epoch)"
  age=$((now - since))
  (( age < 0 )) && age=0
  (( age >= max_secs ))
}

# Classify `systemctl is-active` output. Empty means the command never reached
# systemd (incus exec died, or systemctl is missing) — verified on this host
# that a *missing unit* still prints "inactive" with rc=4, so non-empty output
# is a sound proof of transport, and only empty output is INCONCLUSIVE.
#
# Every other state, transitional ones included, is an answer that was read
# successfully and says "not serving". Transitional states are precisely the
# shape a crash loop takes: the runtime unit is Type=notify/Restart=always with
# TimeoutStartSec+RestartSec ≈ 65s (scripts/luna-server-install), so a build
# that cannot send READY=1 reports `activating` for almost the whole cycle and
# `failed` only briefly. Classifying those as INCONCLUSIVE would mean a wedged
# server is essentially never counted as a strike. The bounded tolerance a
# legitimate restart needs comes from the caller's K-of-N debounce, not from
# pretending the state is unknowable.
luna_runtime_unit_state_class() {
  case "${1:-}" in
    active) return 0 ;;
    "") return 3 ;;
    *) return 1 ;;
  esac
}

# Prove that the declared runtime is serving the exact checkout HEAD in normal
# mode. This is the shared trust gate for deploy verification and control-plane
# migration: neither may adopt executable code merely because it exists in a
# mutable checkout.
#
# Signature: luna_runtime_matches_checkout <repo> <port> [incus] [service]
#
# Exit codes are TRI-STATE. Callers that only test zero/non-zero keep their old
# behaviour, because every non-zero code still means "not proven":
#   0  HEALTHY      — the server answered and the answer proves this HEAD.
#   1  NEGATIVE     — the server answered and the answer was WRONG (wrong or
#                     unidentifiable build, mode != normal, or the supervisor
#                     unit reported any state other than active).
#   3  INCONCLUSIVE — we got no usable answer (curl timeout, connection refused,
#                     incus exec failure, unreadable repo, empty or unparseable
#                     body). This means "we do not know" and on its own must
#                     never justify a repair.
# The distinction exists because scripts/luna-guardian escalates a NEGATIVE to
# `luna-autodeploy --repair`, which honours the engine's in-primitive session
# guard fail-closed and pages instead of dropping the operator.
#
# Test seam: LUNA_TEST_RUNTIME_MATCHES_CHECKOUT accepts "true" (0),
# "inconclusive"/"unknown" (3), and anything else including "false" (1).
luna_runtime_matches_checkout() {
  local repo="$1" port="$2" incus="${3:-}" service="${4:-luna-chat-server.service}"
  local expected active ready mode build rc=0

  if [[ "${LUNA_TEST_RUNTIME_MATCHES_CHECKOUT+set}" == "set" ]]; then
    case "$LUNA_TEST_RUNTIME_MATCHES_CHECKOUT" in
      true) return 0 ;;
      inconclusive|unknown) return 3 ;;
      *) return 1 ;;
    esac
  fi

  expected="$(git -C "$repo" rev-parse HEAD 2>/dev/null)" || return 3
  [[ -n "$expected" ]] || return 3
  if [[ -n "$incus" ]]; then
    command -v incus >/dev/null 2>&1 || return 3
    active="$(incus exec "$incus" -- systemctl is-active "$service" 2>/dev/null || true)"
    luna_runtime_unit_state_class "$active" || rc=$?
    (( rc == 0 )) || return "$rc"
    incus exec "$incus" -- curl -fsS --max-time 4 \
      "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 || return 3
    ready="$(incus exec "$incus" -- curl -fsS --max-time 4 \
      "http://127.0.0.1:$port/readyz" 2>/dev/null)" || return 3
  else
    active="$(systemctl is-active "$service" 2>/dev/null || true)"
    luna_runtime_unit_state_class "$active" || rc=$?
    (( rc == 0 )) || return "$rc"
    curl -fsS --max-time 4 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 || return 3
    ready="$(curl -fsS --max-time 4 "http://127.0.0.1:$port/readyz" 2>/dev/null)" || return 3
  fi
  [[ -n "$ready" ]] || return 3
  mode="$(printf '%s' "$ready" | sed -n 's/.*"mode":"\([^"]*\)".*/\1/p')"
  build="$(printf '%s' "$ready" | sed -n 's/.*"buildSha":"\([^"]*\)".*/\1/p')"
  # An unparseable body is not an answer; a parseable body that says the wrong
  # thing is. Note the buildSha capture is deliberately NOT restricted to hex:
  # chat-server resolves BUILD_SHA to the literal "unknown" when git metadata is
  # unavailable in the container, and a server that cannot identify its own
  # build is a wrong answer (NEGATIVE, repairable by a redeploy) rather than an
  # absent one — matching only hex here would silently classify it INCONCLUSIVE
  # forever and paralyse the guardian.
  [[ -n "$mode" && -n "$build" ]] || return 3
  [[ "$mode" == "normal" ]] || return 1
  [[ "$build" =~ ^[0-9a-fA-F]+$ ]] || return 1
  [[ "$expected" == "$build"* || "$build" == "$expected"* ]]
}

# Portable lowercase: bash 3.2 (macOS /bin/bash) rejects ${var,,} at expansion
# time with "bad substitution", killing the whole script under set -e. The
# hermetic test suite runs these scripts on dev Macs, so no bash-4isms.
luna_lc() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# luna_atomic_replace <src> <dst> - atomically replace <dst> with <src> via the
# rename(2) syscall (Perl's `rename` builtin is a thin wrapper around it, no
# shell-out). One code path on every host: no GNU-vs-BSD `mv -T` probe, no
# cached capability state. Deliberately NOT bun-based: the guardian's
# engine-pin publish (luna-guardian's install_guardian) must still work when
# the bun runtime is exactly what is broken.
#
# Hard dependency on perl being in PATH: acceptable because perl-base is
# Essential on Debian/Ubuntu (present on every target host with no extra
# install) and /usr/bin/perl ships on macOS; the guard below turns a missing
# perl into a loud, self-describing failure instead of a silent no-op.
#
# rename(2) case table, MEASURED on macOS (BSD rename semantics; POSIX
# mandates cases 1-2 and 3-4 identically, so this holds on Linux too):
#   CASE 1 symlink -> an EXISTING symlink : exit 0, dst repointed atomically.
#     Every RE-flip of an already-installed profile lands here (luna-guardian's
#     engine-pin flip; luna-update-server's current/previous flips).
#   CASE 2 directory -> a VACATED name    : exit 0, plain rename semantics.
#     luna-update-server's staged-swap: the damaged tree is moved aside and
#     the name vacated BEFORE the rebuilt tree is swapped in.
#   CASE 3 directory -> a NON-EMPTY dir   : exit 1, refused loudly, dst intact.
#     The safety property this helper has and `mv -fh` lacks: `mv -fh` exits 0
#     and silently NESTS src inside a surviving dst, turning a loud pre-flip
#     failure into a corrupt release tree that still satisfies
#     release_artifacts_ok.
#   CASE 4 directory -> a symlink-to-dir  : exit 1 (ENOTDIR), loud.
#     Unreachable at every current call site - each one either flips a staged
#     symlink onto an existing symlink (case 1) or moves a directory into a
#     name vacated first (case 2). A future caller that does reach it fails
#     loudly rather than silently, which is the property that matters.
#   CASE 5 symlink -> an ABSENT name      : exit 0, dst created (same plain
#     rename semantics as case 2, just with a symlink src). The FIRST
#     install_guardian for a profile lands here: $PIN_BASE/current-<profile>
#     does not exist until that first flip creates it.
luna_atomic_replace() {
  command -v perl >/dev/null 2>&1 ||
    { luna_warn "luna_atomic_replace: perl not found in PATH"; return 127; }
  perl -e 'rename($ARGV[0], $ARGV[1]) or do { warn "luna_atomic_replace: $ARGV[0] -> $ARGV[1]: $!\n"; exit 1 }' -- "$1" "$2"
}

# luna_chat_server_launcher_rel - the daemon launcher entrypoint, relative to
# REPO_DIR (systemd WorkingDirectory / launchd --cwd). The ONE literal shared
# between the unit renderers (luna-server-install's render_service and
# lib/launchd-plist.sh's render_launchd_plist, both of which ExecStart it) and
# luna-guardian's unit_paths_current (which compares the INSTALLED unit's
# ExecStart against this same value to detect rollback-unsafe drift). A second
# copy anywhere would let the drift detector itself drift out of sync with
# what gets rendered - exactly the failure class this indirection removes.
luna_chat_server_launcher_rel() {
  printf 'scripts/luna-chat-server-entry.ts\n'
}

luna_find_bun() {
  if [[ -n "${LUNA_TEST_BUN_PATH:-}" ]]; then
    printf '%s\n' "$LUNA_TEST_BUN_PATH"
    return 0
  fi
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  if [[ -x "$HOME/.bun/bin/bun" ]]; then
    printf '%s\n' "$HOME/.bun/bin/bun"
    return 0
  fi
  printf '%s\n' "$HOME/.bun/bin/bun"
}
