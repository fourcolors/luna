#!/usr/bin/env bash
# nightly.sh — run the corpus and record a red agent_note on any FAIL (Epic #9 P2)
#
# Invoked by the `harness-corpus-nightly` workflow job (luna.db jobs table). Runs
# the full corpus, archives the JSON result under runs/, and on any FAIL writes a
# red row into luna.db agent_notes (kind=harness_regression) so the failure
# surfaces in the behavioral ledger / obs tools. Exit code mirrors the corpus:
# non-zero if any probe failed (so the job_run is also marked red).
set -uo pipefail

CORPUS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LUNA_DB="${LUNA_DB:-$HOME/.luna/luna.db}"
RUNS_DIR="$CORPUS_DIR/runs"
mkdir -p "$RUNS_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

command -v python3 >/dev/null 2>&1 || { echo "nightly: python3 absent" >&2; exit 2; }

json="$("$CORPUS_DIR/run-corpus.sh" --json)"; rc=$?
printf '%s\n' "$json" > "$RUNS_DIR/run-$STAMP.json"

# Parse + (on any FAIL) insert a red agent_note via python's sqlite3 binding —
# parameterized, so probe summaries with quotes/newlines can't break the SQL.
python3 - "$LUNA_DB" "$RUNS_DIR/run-$STAMP.json" <<'PY'
import json, sys, sqlite3, uuid, time
db, run_file = sys.argv[1], sys.argv[2]
with open(run_file) as f:
    d = json.load(f)
fails = [p for p in d.get("probes", []) if p.get("status") == "FAIL"]
print("nightly: total=%d pass=%d fail=%d skip=%d" % (d["total"], d["pass"], d["fail"], d["skip"]))
if not fails:
    sys.exit(0)
lines = ["Harness regression corpus nightly: %d of %d probes RED (pass=%d skip=%d)."
         % (d["fail"], d["total"], d["pass"], d["skip"])]
for p in fails:
    lines.append("- %s: %s" % (p["name"], p.get("summary", "")))
summary = "\n".join(lines)
con = sqlite3.connect(db, timeout=15)
con.execute(
    "INSERT INTO agent_notes(id,session_id,parent_id,kind,summary,payload_json,ts) "
    "VALUES(?,?,?,?,?,?,?)",
    (str(uuid.uuid4()), "harness-nightly", None, "harness_regression",
     summary, json.dumps(d), int(time.time() * 1000)),
)
con.commit()
con.close()
print("nightly: wrote red agent_note for %d failing probe(s)" % len(fails))
PY

exit "$rc"
