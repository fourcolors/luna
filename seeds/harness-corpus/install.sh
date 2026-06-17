#!/usr/bin/env bash
# install.sh — seed the harness regression corpus into ~/.luna and register the
# nightly workflow job. Idempotent: won't clobber an existing live instance, and
# re-running just re-registers the job.
#
#   bash seeds/harness-corpus/install.sh
#
# Env overrides: LUNA_HARNESS_DIR (default ~/.luna/harness-corpus),
#                LUNA_DB (default ~/.luna/luna.db).
set -euo pipefail

SEED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${LUNA_HARNESS_DIR:-$HOME/.luna/harness-corpus}"
LUNA_DB="${LUNA_DB:-$HOME/.luna/luna.db}"

# 1. seed files (never clobber an existing instance's probes/lessons/runs)
if [[ -e "$DEST/run-corpus.sh" ]]; then
  echo "harness-corpus already present at $DEST — leaving it; edit in place."
else
  mkdir -p "$DEST/probes"
  cp "$SEED_DIR"/run-corpus.sh "$SEED_DIR"/nightly.sh "$SEED_DIR"/CONTRACT.md \
     "$SEED_DIR"/README.md "$SEED_DIR"/lessons.md "$SEED_DIR"/DESIGN-P3b-soft-beliefs.md "$DEST/"
  cp "$SEED_DIR"/probes/*.sh "$DEST/probes/"
  chmod +x "$DEST"/*.sh "$DEST"/probes/*.sh
  # Explicit identity so the seed commit works even when git user.name/email are
  # unset on a fresh machine (otherwise `git commit` aborts under `set -e`).
  ( cd "$DEST" && git init -q && git add -A \
      && git -c user.email="luna@localhost" -c user.name="Luna" commit -q -m "seed harness regression corpus" )
  echo "seeded harness-corpus -> $DEST"
fi

# 2. register the nightly workflow job (idempotent). The V2 scheduler (the only
#    scheduler) on the chat-server drains it automatically.
if command -v python3 >/dev/null 2>&1 && [[ -f "$LUNA_DB" ]]; then
  python3 - "$LUNA_DB" "$DEST" <<'PY'
import sqlite3, json, time, datetime, sys, shlex
db, dest = sys.argv[1], sys.argv[2]
now = datetime.datetime.now(datetime.timezone.utc)
nr = now.replace(hour=9, minute=0, second=0, microsecond=0)
if nr <= now:
    nr += datetime.timedelta(days=1)
nrms = int(nr.timestamp() * 1000); nowms = int(time.time() * 1000)
payload = {"steps": [{"kind": "shell", "cmd": "bash " + shlex.quote(dest + "/nightly.sh"), "timeout_ms": 300000}],
           "halt_on_failure": False}
con = sqlite3.connect(db, timeout=15)
try:
    con.execute("DELETE FROM jobs WHERE id='harness-corpus-nightly'")
    con.execute(
        "INSERT INTO jobs(id,kind,spec,next_run,last_run,last_status,payload_json,"
        "created_at,updated_at,schedule,enabled,next_run_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        ("harness-corpus-nightly", "workflow", "0 9 * * *", nrms, None, None,
         json.dumps(payload), nowms, nowms, "0 9 * * *", 1, nrms))
    con.commit()
    print("registered nightly job 'harness-corpus-nightly' (0 9 * * * UTC)")
except sqlite3.OperationalError as e:
    print("skipped job registration (no jobs table?):", e)
finally:
    con.close()
PY
else
  echo "skipped nightly job registration (python3 or luna.db unavailable)"
fi

echo "done. Try: $DEST/run-corpus.sh"
