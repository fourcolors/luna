/**
 * Standalone SYSTEM.md loader — extracted so tests can import it without
 * pulling in the full chat-server.ts dependency tree.
 *
 * SYSTEM.md is the mechanics counterpart to DNA.md (identity). It
 * describes how Luna's runtime is organized: state on disk, workspaces,
 * memory, observability — the things Luna needs in her own head every
 * thread so she knows where her hands and feet are.
 *
 * Imported and re-exported by chat-server.ts; consumers that only
 * need `loadSystem` should import from this file directly.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve as resolvePath } from "node:path"

/**
 * Load SYSTEM.md for Luna's mechanics system prompt.
 *
 * Resolution order:
 *   1. `~/.luna/SYSTEM.md` — personal install override (takes precedence).
 *      Allows per-user customisation without touching the repo.
 *   2. `<repo-root>/SYSTEM.md` — repo default.
 *
 * `scriptDir` is the directory that contains the calling script (i.e.
 * `dirname(fileURLToPath(import.meta.url))`). The repo SYSTEM.md lives
 * three levels up from `apps/ui-web/scripts/` — pass a fake path in tests.
 *
 * `personalSystemPath` overrides the default `~/.luna/SYSTEM.md` location.
 * Pass `null` to skip the personal override entirely (useful in tests
 * that need to exercise the repo-relative path without interference from
 * the real user install).
 *
 * Unlike `loadDna`, missing SYSTEM.md is NOT a fatal boot error — Luna
 * can still run with identity-only context, just without mechanics
 * awareness. Returns `null` when neither file exists; callers decide how
 * to handle absence (the chat-server omits it from the system prompt).
 */
export function loadSystem(
  scriptDir: string,
  personalSystemPath: string | null = resolvePath(
    homedir(),
    ".luna",
    "SYSTEM.md",
  ),
): string | null {
  if (personalSystemPath !== null && existsSync(personalSystemPath)) {
    return readFileSync(personalSystemPath, "utf-8").trim()
  }
  const repoSystem = resolvePath(scriptDir, "../../..", "SYSTEM.md")
  if (existsSync(repoSystem)) {
    return readFileSync(repoSystem, "utf-8").trim()
  }
  return null
}
