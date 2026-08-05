/**
 * luna-chat-server-entry.ts - the ONE path-independent target every rendered
 * supervisor unit (systemd ExecStart, launchd ProgramArguments - see
 * scripts/luna-server-install and scripts/lib/launchd-plist.sh) names,
 * forever. A future move of the daemon's actual source file (e.g. the
 * apps/server relocation) changes only the probe list below, never the unit:
 * host-persistent state (a systemd/launchd unit file) stops encoding a
 * version-dependent path.
 *
 * Deliberately TS, not bash, and deliberately carries NO shebang line (it is
 * only ever invoked as `bun run scripts/luna-chat-server-entry.ts`, never
 * executed directly). Both properties are load-bearing, not style:
 * `bun run <bash-file>` does not run the file as a shell script - Bun parses
 * it with its OWN parser. Measured on this Mac (Bun 1.3.14): a
 * `#!/usr/bin/env bash` + `set -euo pipefail` file with a `.sh` extension
 * prints `bun: command not found: set` and EXITS 0. Under this unit's
 * Type=notify that is a clean exit with no READY=1, so TimeoutStartSec
 * expires and the host restart-spirals with nothing in the exit code to
 * diagnose. (The failure is narrower than "any bash script": an
 * extensionless or subdirectory bash-shebang file instead exits 1 with a TS
 * parse error under the same `bun run` - still wrong, but loud. Only the
 * `.sh`-extension shebang shape exits 0 silently.) A `.ts` launcher with no
 * shebang of its own can never take that shape.
 *
 * The daemon's exported `bootstrap` is awaited DIRECTLY in this process
 * (dynamic `import()` + an explicit call), never spawned as a child: the
 * unit's Type=notify + WatchdogSec=90 (scripts/luna-server-install) require
 * the daemon to run as the unit's MAIN PID, which a spawned child would not
 * guarantee. Measured: `bun run entry.ts` doing
 * `await (await import("./daemon.ts")).bootstrap()` runs bootstrap in the
 * SAME pid and leaves `import.meta.main === false` inside daemon.ts (so its
 * own `if (import.meta.main) void bootstrap()` guard does not double-boot),
 * while `bun run daemon.ts` directly leaves it TRUE and boots exactly once -
 * both invocation paths work and neither double-boots.
 *
 * The daemon path is resolved relative to import.meta.url, NEVER cwd - the
 * unit's WorkingDirectory (REPO_DIR) is for the DAEMON's own path resolution
 * (e.g. LUNA_REPO_ROOT-relative workspace/env lookups), not this launcher's.
 */
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

// TODO(#440): drop this probe once every profile's `previous` release
// resolves to a post-S08 release (apps/server/src/chat-server.ts present in
// BOTH current and previous - checked via `readlink previous` on each host).
// Until then this ONE launcher must boot both the pre-move and post-move tree
// shapes, because a rollback can flip `current` back to a pre-move release
// with no unit re-render (that is the whole reason this launcher exists).
// Fix or remove: delete the apps/ui-web/scripts/chat-server.ts fallback below
// and this comment once the condition holds; S26 carries the removal step.
const daemonCandidates = [
  join(here, "..", "apps", "server", "src", "chat-server.ts"),
  join(here, "..", "apps", "ui-web", "scripts", "chat-server.ts"),
]

const daemonPath = daemonCandidates.find((candidate) => existsSync(candidate))
if (!daemonPath) {
  throw new Error(
    `luna-chat-server-entry: no daemon entrypoint found among: ${daemonCandidates.join(", ")}`,
  )
}

const daemon = (await import(daemonPath)) as { bootstrap?: () => Promise<void> }
if (typeof daemon.bootstrap !== "function") {
  throw new Error(`luna-chat-server-entry: ${daemonPath} does not export a bootstrap()`)
}
await daemon.bootstrap()
