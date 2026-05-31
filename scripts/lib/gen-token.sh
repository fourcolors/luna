#!/usr/bin/env bash
# gen-token.sh — generate a clean UI WebSocket token.
#
# Sourced by installers to seed a local UI_WS_TOKEN, and runnable directly
# (prints one token) so the generation logic stays unit-testable in isolation.
#
# Why this exists: the old inline `tr -dc 'a-f0-9' < /dev/urandom | head -c 32`
# pattern trips `set -o pipefail` — `head` closes the pipe after 32 bytes, `tr`
# dies with SIGPIPE (exit 141), the pipeline reports non-zero, and any
# `|| <fallback>` then fires on EVERY run, concatenating a constant suffix onto
# the random hex. This helper avoids the infinite-source-into-head pattern.

# Emit a 32-char lowercase-hex token (16 random bytes), newline-terminated.
# Returns non-zero only when no entropy source is available.
gen_ui_ws_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  elif [[ -r /dev/urandom ]]; then
    # `head -c 16 /dev/urandom` is a BOUNDED read of a file (exits 0, no pipe
    # to SIGPIPE), then hex-encode. od emits one line for 16 bytes; strip the
    # spaces/newlines od adds and re-terminate with a single newline.
    printf '%s\n' "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  else
    echo "gen-token: no entropy source (openssl or /dev/urandom required)" >&2
    return 1
  fi
}

# When executed directly (not sourced), print one token. The `:-` defaults keep
# this safe to source into a `set -u` (nounset) script like install-mac.command.
if [[ "${BASH_SOURCE[0]:-}" == "${0:-}" ]]; then
  gen_ui_ws_token
fi
