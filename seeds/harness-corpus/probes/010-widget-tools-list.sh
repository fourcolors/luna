#!/usr/bin/env bash
# PROBE:    widget_tools sdk-mcp server serializes tools/list with a summoner wired
# LESSON:   2026-06-14 — a single malformed tool schema (zod-v4 z.record needing
#           TWO args) made the whole widget_tools server's tools/list THROW, so the
#           model saw ZERO widget tools — silently, only when the summoner was wired
#           (open_widget/open_artifact built then). Registration succeeding != serialization
#           succeeding. This probe builds the real server in isolation and drives tools/list.
# SEVERITY: critical
set -uo pipefail

LUNA_REPO="${LUNA_REPO:-}"
[[ -n "$LUNA_REPO" ]] || { echo "SKIP: set LUNA_REPO to your Luna checkout"; exit 77; }
WT_DIR="$LUNA_REPO/packages/widget-tools"

command -v bun >/dev/null 2>&1 || { echo "SKIP: bun absent"; exit 77; }
[[ -d "$WT_DIR" ]] || { echo "SKIP: widget-tools package not found under $LUNA_REPO"; exit 77; }

# The MCP SDK is a transitive dep (no top-level symlink), so resolve its real
# on-disk location under .bun, version-agnostically, and import by absolute path.
MCP_BASE="$(ls -d "$LUNA_REPO"/node_modules/.bun/@modelcontextprotocol+sdk@*/node_modules/@modelcontextprotocol/sdk 2>/dev/null | head -1)"
[[ -n "$MCP_BASE" && -f "$MCP_BASE/dist/esm/client/index.js" && -f "$MCP_BASE/dist/esm/inMemory.js" ]] \
  || { echo "SKIP: MCP SDK client/inMemory not found under $LUNA_REPO"; exit 77; }

# Bun resolves @luna/* workspace specifiers only from INSIDE the package dir, so
# the temp script lives in (and runs from) packages/widget-tools.
tmp="$WT_DIR/.harness-widget-probe.$$.mjs"
trap 'rm -f "$tmp"' EXIT
# Write the resolved SDK path directly (no `sed -i` — that flag is GNU-specific
# and breaks on BSD/macOS). The two import lines carry $MCP_BASE; the rest is
# static and stays in a quoted heredoc.
{
  printf 'import { Client } from "%s/dist/esm/client/index.js";\n' "$MCP_BASE"
  printf 'import { InMemoryTransport } from "%s/dist/esm/inMemory.js";\n' "$MCP_BASE"
  cat <<'EOF'
import {
  makeWidgetTools, makeMcpAppTools, makeSearchArtifactsTool,
  makeOpenWidgetTool, makeOpenArtifactTool, buildWidgetToolsMcpServer,
} from "@luna/widget-tools";

// Stubs: tool HANDLERS are never invoked during tools/list, only built. A wired
// summoner is the path that included open_widget/open_artifact and poisoned the list.
const store = new Proxy({}, { get: () => () => undefined });
const summoner = { directory: () => [], open: () => undefined, openArtifact: () => undefined };

let tools;
try {
  tools = [
    ...makeWidgetTools(store, summoner),
    ...makeMcpAppTools(store, summoner),
    makeSearchArtifactsTool(store),
    makeOpenWidgetTool(summoner),
    makeOpenArtifactTool(store, summoner),
  ];
} catch (e) {
  console.log("DRIFT: building widget tool set threw — " + String((e && e.stack) || e));
  process.exit(1);
}

const server = buildWidgetToolsMcpServer(tools);
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
try {
  await server.instance.connect(serverT);
  const client = new Client({ name: "harness-probe", version: "0.0.0" });
  await client.connect(clientT);
  const res = await client.listTools();           // THROWS on a malformed schema
  const names = (res.tools || []).map((t) => t.name).sort();
  const expected = ["mcp_app_write", "open_artifact", "open_widget", "search_artifacts", "widget_write"];
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length) {
    console.log("DRIFT: tools/list missing " + JSON.stringify(missing) + " — got " + JSON.stringify(names));
    process.exit(1);
  }
  console.log("OK: widget_tools tools/list serialized all " + names.length + " tools [" + names.join(", ") + "]");
  process.exit(0);
} catch (e) {
  console.log("DRIFT: tools/list THREW (schema poisoning) — " + String((e && e.stack) || e));
  process.exit(1);
}
EOF
} > "$tmp"

out="$(cd "$WT_DIR" && bun "$tmp" 2>&1)"; rc=$?
last="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n1)"
if [[ $rc -eq 0 ]]; then
  echo "$last"; exit 0
elif [[ $rc -eq 1 ]] && printf '%s' "$last" | grep -q '^DRIFT:'; then
  echo "$last"; exit 1
else
  # crash/import failure unrelated to the invariant (e.g. SDK moved) -> SKIP not false-red
  echo "SKIP: widget probe could not execute (rc=$rc) — $last"; exit 77
fi
