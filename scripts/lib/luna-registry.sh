#!/usr/bin/env bash
# luna-registry.sh — Data-driven server registry reader for Luna deploy scripts.
#
# Parses a [[server]] stanza from a TOML registry file and exports the same
# variables that profile_config() in luna-autodeploy sets today — making the
# deploy pipeline DATA-DRIVEN while remaining a provable NO-OP for existing
# dev and stable profiles.
#
# ## TOML SUBSET SHAPE
#
# This reader handles a CLOSED SCHEMA SUBSET of TOML, chosen to be reliably
# parseable in plain bash/awk without a full TOML parser:
#
#   - Top-level scalar keys:       kind = "registry"
#   - Array-of-tables:             [[server]] stanzas (the section header is
#                                  the start-of-record sentinel)
#   - Dotted keys within a table:  name = "dev"
#                                  deploy.timer = false
#                                  runtime.target.incus.container = "luna-dev"
#                                  update.params.profile = "dev"
#   - Value types accepted:        quoted strings ("value"), booleans
#                                  (true/false), integers (no quotes)
#   - Comments:                    # ... (stripped)
#   - NOT supported:               inline tables {}, multi-line strings,
#                                  arrays [], sub-section headers [server.*],
#                                  dotted table headers [server.runtime].
#                                  Those forms are rejected or silently ignored.
#
# Why this subset: the design doc (§4) uses dotted flat keys within [[server]]
# stanzas. bash/awk can reliably split on "key = value" lines and track
# "current server" by watching [[server]] boundaries. The full array-of-tables
# + dotted-key shape maps 1-to-1 onto the variables the bash deploy engine
# needs — no deeper nesting is required for Phase 1a.
#
# ## Exported variables (match profile_config() exactly)
#
#   P_REPO           — host-side git repo directory
#   P_BRANCH         — branch to track
#   P_INCUS          — incus container name ("" = bare-host)
#   P_PORT           — WebSocket port
#   P_UPDATE_ARGS    — bash array of flags for luna-update-server
#   P_SERVICE_NAME   — systemd unit name (for F7 --validate)
#   P_TIMER_ALLOWED  — "true"/"false" from deploy.timer
#   P_AUTO_UPDATE    — "true"/"false" from deploy.autoUpdate (ABSENT = "true";
#                      auto-update is ON by default, opt-out is explicit)
#   P_TIMER_INTERVAL — systemd time span from deploy.timerInterval ("" = unset;
#                      install-timer falls back to its own default)
#   P_LAYOUT         — "inplace" (default) or "releases" from deploy.layout.
#                      A TOPOLOGY RAIL like deploy.timer: NO env override, and
#                      any value other than absent/"inplace"/"releases" is a
#                      hard exit 2 (a typo must fail loudly, never silently
#                      leave automation running reset --hard against a tree
#                      the units no longer serve).
#   P_DEPLOY_ROOT    — releases-layout deploy root (holds mirror.git/, releases/,
#                      current, previous). deploy.root when set (must be
#                      absolute), else the PARENT of update.params.hostRepoDir
#                      (the verified /root/luna/<profile>/repo convention).
#   P_RELEASES_KEEP  — retention count for releases/ pruning. deploy.releasesKeep
#                      when set (validated integer >= 2), default 3.
#
# ## Security: fail-closed
#
#   - Refuses a registry file that is group/world-writable (stat mode & 0o022)
#   - Refuses a file whose top-level kind != "registry"
#   - Unknown profile → exit 2
#   - Missing required fields → exit 2
#
# ## Kill-switch
#   Set LUNA_REGISTRY_DISABLE=1 to skip this lib entirely; luna-autodeploy
#   falls back to its hardcoded case statement.
#
# ## Test seams (mirrors luna-deploy.sh pattern)
#   LUNA_SERVERS_CONFIG    — override the registry file path
#   LUNA_TEST_STAT_MODE    — override the octal permission string returned by stat
#                            (lets unit tests simulate world-writable files)
#   LUNA_TEST_STAT_OWNER   — override the owner uid returned by stat
#                            (lets unit tests simulate wrong-owner files)

# ── internal: parse a quoted or unquoted TOML scalar value ───────────────────
# Strips surrounding double-quotes; trims inline comments; trims whitespace.
_luna_registry_parse_value() {
  local raw="$1"
  # Strip inline comment (# not inside quotes — simple heuristic sufficient
  # for the closed schema: no # in our expected values)
  raw="${raw%%#*}"
  # Trim leading/trailing whitespace
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  # Strip surrounding double-quotes if present
  if [[ "$raw" == '"'*'"' ]]; then
    raw="${raw#\"}"
    raw="${raw%\"}"
  fi
  printf '%s' "$raw"
}

# ── luna_load_server <profile> ────────────────────────────────────────────────
# Reads the registry file, finds the [[server]] stanza with name=<profile>,
# and sets P_REPO, P_BRANCH, P_INCUS, P_PORT, P_UPDATE_ARGS, P_SERVICE_NAME,
# P_TIMER_ALLOWED to byte-match what profile_config() produces today.
luna_load_server() {
  local profile="$1"
  local registry_file="${LUNA_SERVERS_CONFIG:-/etc/luna/servers.toml}"

  # ── existence check ──────────────────────────────────────────────────────
  if [[ ! -f "$registry_file" ]]; then
    printf 'luna-registry: registry file not found: %s\n' "$registry_file" >&2
    exit 2
  fi

  # ── permission check (fail-closed) ──────────────────────────────────────
  # Refuse if group or world can write (mode & 0022 != 0).
  # Test seam: LUNA_TEST_STAT_MODE overrides the real stat call.
  local mode_str
  if [[ "${LUNA_TEST_STAT_MODE+set}" == "set" ]]; then
    mode_str="$LUNA_TEST_STAT_MODE"
  else
    # stat -c on Linux; stat -f on macOS — use %A (symbolic) which is portable.
    # We check the numeric form for precision.
    if stat --version >/dev/null 2>&1; then
      # GNU stat (Linux)
      mode_str="$(stat -c '%a' "$registry_file" 2>/dev/null || echo "000")"
    else
      # BSD stat (macOS)
      mode_str="$(stat -f '%OLp' "$registry_file" 2>/dev/null || echo "000")"
    fi
  fi
  # mode_str is 3-digit octal (e.g. "600", "644", "022")
  # Check if group-write (bit 010) or world-write (bit 002) are set.
  # Use arithmetic: convert last two digits.
  local mode_int
  mode_int=$((8#${mode_str:-000}))
  if (( (mode_int & 022) != 0 )); then
    printf 'luna-registry: REFUSING %s — file is group/world-writable (mode %s).\n' \
      "$registry_file" "$mode_str" >&2
    printf 'luna-registry: chmod 600 %s to fix.\n' "$registry_file" >&2
    exit 2
  fi

  # ── ownership check (FIX 2: design §8 — refuse if not owned by executing uid) ──
  # Test seam: LUNA_TEST_STAT_OWNER overrides the real stat call.
  local owner_uid
  if [[ "${LUNA_TEST_STAT_OWNER+set}" == "set" ]]; then
    owner_uid="$LUNA_TEST_STAT_OWNER"
  else
    # GNU stat (Linux — the target box is Linux per design §4)
    if stat --version >/dev/null 2>&1; then
      owner_uid="$(stat -c '%u' "$registry_file" 2>/dev/null || echo "-1")"
    else
      # BSD stat (macOS — fallback for dev/test)
      owner_uid="$(stat -f '%u' "$registry_file" 2>/dev/null || echo "-1")"
    fi
  fi
  if [[ "$owner_uid" != "${EUID}" ]]; then
    printf 'luna-registry: REFUSING %s — file owner uid %s != executing uid %s.\n' \
      "$registry_file" "$owner_uid" "${EUID}" >&2
    printf 'luna-registry: registry must be owned by the user running this script.\n' >&2
    exit 2
  fi

  # ── parse: extract the [[server]] stanza for <profile> ──────────────────
  # We use awk to scan the file once:
  #   - track which [[server]] block we are in
  #   - collect key=value lines within the matching block
  #   - stop collecting when the next [[server]] starts
  #
  # Output format: one "key=value" per line, keys are the dotted TOML paths
  # flattened (e.g. "deploy.timer=false", "runtime.target.incus.container=luna-dev").
  # Top-level keys (kind, host, schemaVersion) are also emitted if needed.

  local parsed _awk_exit
  parsed="$(awk -v target="$profile" '
    BEGIN {
      in_target = 0
      found     = 0
      top_kind  = ""
      # seen_keys tracks keys within the current [[server]] stanza for FIX 1
    }

    # Strip inline comments and trim whitespace.
    {
      line = $0
      # Remove inline comment (after #, not inside quotes — safe for our schema)
      sub(/#[^"]*$/, "", line)
      # Trim leading/trailing whitespace
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      if (line == "") next
    }

    # Top-level kind discriminator (before any [[server]] block)
    !in_target && !found && /^kind[[:space:]]*=/ {
      split(line, kv, /[[:space:]]*=[[:space:]]*/); v = kv[2]
      gsub(/^"|"$/, "", v)
      top_kind = v
    }

    # Array-of-tables header [[server]]
    /^\[\[server\]\]/ {
      if (in_target && found) {
        # We were in the target block and a new [[server]] starts → stop.
        in_target = 0
        next
      }
      in_target = 0   # reset; will check name key next
      # Mark that we need to check the name of this new stanza
      waiting_for_name = 1
      delete current
      delete seen_keys  # reset duplicate-key tracker for new stanza (FIX 1)
      next
    }

    # Within a [[server]] stanza: collect dotted key=value pairs.
    # FIX 3: match lines that START with a letter after optional leading whitespace
    # (legal TOML indents dotted keys under [[server]]).
    /^[[:space:]]*[A-Za-z]/ && (in_target || waiting_for_name) {
      # Split on first "=" only
      eq = index(line, "=")
      if (eq == 0) next
      key = substr(line, 1, eq-1)
      val = substr(line, eq+1)
      # Trim key (removes leading whitespace from indented keys)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      # Trim value and strip quotes
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
      gsub(/^"|"$/, "", val)

      if (waiting_for_name && key == "name") {
        if (val == target) {
          in_target = 1
          found     = 1
        }
        waiting_for_name = 0
        if (in_target) next
        # Not our target; skip
        next
      }

      if (in_target) {
        # FIX 1: detect duplicate key within a stanza — fail-closed.
        # Print sentinel to stdout (captured by the caller) AND a message to stderr.
        # The caller checks for __dup_key= and exits 2.
        if (key in seen_keys) {
          print "__dup_key=" key
          printf "luna-registry: duplicate key \"%s\" in [[server]] stanza \"%s\" — config error.\n", key, target > "/dev/stderr"
          exit 0
        }
        seen_keys[key] = 1
        print key "=" val
      }
    }

    END {
      # Emit top-level kind so caller can validate it
      print "__top_kind=" top_kind
      if (!found) print "__not_found=1"
    }
  ' "$registry_file")"
  _awk_exit=$?
  if (( _awk_exit != 0 )); then
    # awk itself failed (e.g. file read error); stderr already has a message.
    exit 2
  fi

  # ── FIX 1: check for duplicate-key sentinel ──────────────────────────────
  if printf '%s\n' "$parsed" | grep -q '^__dup_key='; then
    # stderr message was already emitted by awk
    exit 2
  fi

  # ── validate top-level kind ──────────────────────────────────────────────
  local top_kind
  top_kind="$(printf '%s\n' "$parsed" | awk -F= '/^__top_kind=/{print substr($0,length("__top_kind=")+1)}')"
  if [[ "$top_kind" != "registry" ]]; then
    printf 'luna-registry: %s has kind="%s", expected "registry".\n' \
      "$registry_file" "$top_kind" >&2
    exit 2
  fi

  # ── check profile was found ──────────────────────────────────────────────
  if printf '%s\n' "$parsed" | grep -q '^__not_found=1'; then
    printf 'luna-registry: unknown profile "%s" in %s\n' "$profile" "$registry_file" >&2
    exit 2
  fi

  # ── helper: extract a dotted key from parsed output ──────────────────────
  _get() {
    local key="$1"
    printf '%s\n' "$parsed" | awk -F= -v k="$key" '$1 == k { print substr($0, length(k)+2); found=1 } END { exit found ? 0 : 1 }' 2>/dev/null || true
  }

  # ── extract fields ───────────────────────────────────────────────────────
  # Map dotted registry keys to the exact variable names profile_config() sets.

  # repo dir: update.params.hostRepoDir or fallback env override
  local _repo_dir
  _repo_dir="$(_get "update.params.hostRepoDir")"

  # branch: update.params.ref → strip "origin/" prefix to get branch
  local _ref
  _ref="$(_get "update.params.ref")"
  local _branch="${_ref#origin/}"

  # incus container (empty string = bare-host)
  local _incus
  _incus="$(_get "runtime.target.incus.container")" || _incus=""

  # port (deploy.healthPort or server.ports.proxy)
  local _port
  _port="$(_get "deploy.healthPort")" || _port=""
  if [[ -z "$_port" ]]; then
    _port="$(_get "ports.proxy")" || _port="4753"
  fi
  [[ -n "$_port" ]] || _port="4753"

  # timer_allowed: deploy.timer (boolean true/false)
  local _timer
  _timer="$(_get "deploy.timer")" || _timer="false"

  # auto_update: deploy.autoUpdate (boolean). DEFAULT-ON: an absent key means
  # "true" — the operator opts OUT by writing deploy.autoUpdate = false. Any
  # value other than the literal "true"/absent disables (fail toward "no
  # unexpected restart", never toward one).
  local _auto_update
  _auto_update="$(_get "deploy.autoUpdate")" || _auto_update=""
  if [[ -z "$_auto_update" ]]; then
    _auto_update="true"
  elif [[ "$_auto_update" != "true" ]]; then
    _auto_update="false"
  fi

  # timer interval: deploy.timerInterval (systemd time span, e.g. "15min")
  local _timer_interval
  _timer_interval="$(_get "deploy.timerInterval")" || _timer_interval=""

  # deploy layout: absent/"inplace" → inplace; "releases" → releases; anything
  # else is a hard exit 2 (the loader's fail-closed posture — a typo must not
  # silently degrade to inplace while the operator believes releases is live).
  local _layout
  _layout="$(_get "deploy.layout")" || _layout=""
  if [[ -z "$_layout" || "$_layout" == "inplace" ]]; then
    _layout="inplace"
  elif [[ "$_layout" != "releases" ]]; then
    printf 'luna-registry: profile "%s" — deploy.layout "%s" is invalid (expected "inplace" or "releases").\n' \
      "$profile" "$_layout" >&2
    exit 2
  fi

  # deploy root (releases layout): deploy.root when set, else the parent of
  # update.params.hostRepoDir (/root/luna/<profile>/repo → /root/luna/<profile>).
  local _deploy_root _deploy_root_explicit=false
  _deploy_root="$(_get "deploy.root")" || _deploy_root=""
  if [[ -n "$_deploy_root" ]]; then
    _deploy_root_explicit=true
  fi

  # releases retention: deploy.releasesKeep, optional integer >= 2, default 3.
  local _releases_keep _releases_keep_explicit=false
  _releases_keep="$(_get "deploy.releasesKeep")" || _releases_keep=""
  if [[ -n "$_releases_keep" ]]; then
    _releases_keep_explicit=true
    if [[ ! "$_releases_keep" =~ ^[0-9]+$ ]] || (( _releases_keep < 2 )); then
      printf 'luna-registry: profile "%s" — deploy.releasesKeep "%s" is invalid (integer >= 2 required).\n' \
        "$profile" "$_releases_keep" >&2
      exit 2
    fi
  else
    _releases_keep=3
  fi

  # ── validate required fields ─────────────────────────────────────────────
  if [[ -z "$_repo_dir" ]]; then
    printf 'luna-registry: profile "%s" missing required field update.params.hostRepoDir\n' "$profile" >&2
    exit 2
  fi
  if [[ -z "$_ref" ]]; then
    printf 'luna-registry: profile "%s" missing required field update.params.ref\n' "$profile" >&2
    exit 2
  fi

  # ── FIX 4: charset / format validation (design §8, defense-in-depth) ──────
  # argv-array passing already prevents injection; this is belt-and-suspenders +
  # catches typos early before values reach exec boundaries.
  #
  # Container name and service/unit name: only [a-zA-Z0-9_.-] allowed.
  local _service_name_check
  if [[ "$profile" == "stable" ]]; then
    _service_name_check="luna-chat-server.service"
  else
    _service_name_check="luna-${profile}-chat-server.service"
  fi
  if [[ -n "$_incus" ]] && [[ ! "$_incus" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
    printf 'luna-registry: profile "%s" — container name "%s" contains invalid characters (allowed: [a-zA-Z0-9_.-]).\n' \
      "$profile" "$_incus" >&2
    exit 2
  fi
  if [[ ! "$_service_name_check" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
    printf 'luna-registry: profile "%s" — derived service name "%s" contains invalid characters.\n' \
      "$profile" "$_service_name_check" >&2
    exit 2
  fi
  # Repo dir must be an absolute path (starts with /).
  if [[ "$_repo_dir" != /* ]]; then
    printf 'luna-registry: profile "%s" — hostRepoDir "%s" is not an absolute path.\n' \
      "$profile" "$_repo_dir" >&2
    exit 2
  fi
  # deploy.root, when set, must also be absolute; when unset it defaults to the
  # parent of hostRepoDir (which the check above already proved absolute).
  if [[ "$_deploy_root_explicit" == true && "$_deploy_root" != /* ]]; then
    printf 'luna-registry: profile "%s" — deploy.root "%s" is not an absolute path.\n' \
      "$profile" "$_deploy_root" >&2
    exit 2
  fi
  if [[ -z "$_deploy_root" ]]; then
    _deploy_root="${_repo_dir%/*}"
  fi
  # Timer interval is interpolated into a systemd unit file — restrict it to a
  # plain systemd time span (digits + unit words + spaces, e.g. "15min",
  # "1h 30min") so a registry typo can never smuggle unit-file directives.
  local _interval_re='^[0-9A-Za-z ]+$'
  if [[ -n "$_timer_interval" ]] && [[ ! "$_timer_interval" =~ $_interval_re ]]; then
    printf 'luna-registry: profile "%s" — deploy.timerInterval "%s" is not a plain systemd time span.\n' \
      "$profile" "$_timer_interval" >&2
    exit 2
  fi

  # ── apply env overrides (same as profile_config() today) ─────────────────
  # luna-autodeploy lets operators override repo/branch/incus/port via env vars.
  # We replicate that: registry is the default, env wins if set.
  local profile_upper
  profile_upper="$(printf '%s' "$profile" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]/_/g')"

  # Repo dir override
  local repo_env_var="LUNA_${profile_upper}_REPO_DIR"
  P_REPO="${!repo_env_var:-$_repo_dir}"

  # Branch override
  local branch_env_var="LUNA_${profile_upper}_BRANCH"
  P_BRANCH="${!branch_env_var:-$_branch}"

  # Incus override
  local incus_env_var="LUNA_${profile_upper}_INCUS"
  P_INCUS="${!incus_env_var:-$_incus}"

  # Port override
  local port_env_var="LUNA_${profile_upper}_WS_PORT"
  # shellcheck disable=SC2034  # P_PORT is an output variable consumed by the caller
  P_PORT="${!port_env_var:-$_port}"

  # Timer flag (no env override — this is a security rail, not a convenience)
  # shellcheck disable=SC2034  # P_TIMER_ALLOWED is an output variable consumed by the caller
  P_TIMER_ALLOWED="$_timer"

  # Auto-update knob and timer cadence (no env override — the registry is the
  # single source of truth for whether the machine may restart this channel)
  # shellcheck disable=SC2034  # P_AUTO_UPDATE is an output variable consumed by the caller
  P_AUTO_UPDATE="$_auto_update"
  # shellcheck disable=SC2034  # P_TIMER_INTERVAL is an output variable consumed by the caller
  P_TIMER_INTERVAL="$_timer_interval"

  # Deploy layout (no env override — a topology rail, same rationale as
  # deploy.timer: what tree the units serve is never a per-shell convenience).
  # shellcheck disable=SC2034  # P_LAYOUT is an output variable consumed by the caller
  P_LAYOUT="$_layout"
  # shellcheck disable=SC2034  # P_DEPLOY_ROOT is an output variable consumed by the caller
  P_DEPLOY_ROOT="$_deploy_root"
  # shellcheck disable=SC2034  # P_RELEASES_KEEP is an output variable consumed by the caller
  P_RELEASES_KEEP="$_releases_keep"

  # Under the releases layout the operator-facing repo path IS the current
  # release: every consumer (rev-parse, unit ExecStart, guardian probes) reads
  # through the atomically-flipped symlink. This deliberately overrides the
  # LUNA_<PROFILE>_REPO_DIR env override — layout is a rail, and pointing
  # consumers at a non-current tree would reintroduce the split-brain this
  # layout exists to remove.
  if [[ "$P_LAYOUT" == "releases" ]]; then
    P_REPO="$P_DEPLOY_ROOT/current"
  fi

  # ── assemble P_UPDATE_ARGS (byte-identical to profile_config()) ───────────
  # Rule (from luna-autodeploy today):
  #   dev:    --profile dev --incus luna-dev --ref origin/<branch>
  #   stable: --profile stable --repo-dir <repo> --ref origin/<branch>
  # General rule: incus non-empty → use --incus; empty → use --repo-dir.
  P_UPDATE_ARGS=()
  P_UPDATE_ARGS+=(--profile "$profile")
  if [[ -n "$P_INCUS" ]]; then
    P_UPDATE_ARGS+=(--incus "$P_INCUS")
  else
    P_UPDATE_ARGS+=(--repo-dir "$P_REPO")
  fi
  P_UPDATE_ARGS+=(--ref "origin/$P_BRANCH")
  # Releases layout: the engine needs the layout and the deploy root. Inplace
  # profiles get BYTE-IDENTICAL args to today (nothing appended). The retention
  # knob rides along only when the registry set it explicitly — the engine's
  # own default (3) matches P_RELEASES_KEEP's default, so an absent key keeps
  # the argv minimal.
  if [[ "$P_LAYOUT" == "releases" ]]; then
    P_UPDATE_ARGS+=(--layout releases --deploy-root "$P_DEPLOY_ROOT")
    if [[ "$_releases_keep_explicit" == true ]]; then
      P_UPDATE_ARGS+=(--releases-keep "$P_RELEASES_KEEP")
    fi
  fi

  # ── service name (for F7 --validate) ─────────────────────────────────────
  # Mirrors luna_service_name() in luna-deploy.sh exactly.
  # shellcheck disable=SC2034  # P_SERVICE_NAME is an output variable consumed by the caller
  if [[ "$profile" == "stable" ]]; then
    P_SERVICE_NAME="luna-chat-server.service"
  else
    P_SERVICE_NAME="luna-${profile}-chat-server.service"
  fi
}
