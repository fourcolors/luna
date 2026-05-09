/**
 * Standalone DNA.md loader — extracted so tests can import it without
 * pulling in the full chat-server.ts dependency tree.
 *
 * Imported and re-exported by chat-server.ts; consumers that only
 * need `loadDna` should import from this file directly.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve as resolvePath } from "node:path"

/**
 * Load DNA.md for Luna's identity system prompt.
 *
 * Resolution order:
 *   1. `~/.luna/DNA.md` — personal install override (takes precedence).
 *      Allows per-user identity customisation without touching the repo.
 *   2. `<repo-root>/DNA.md` — repo default (public, generic version).
 *
 * `scriptDir` is the directory that contains the calling script (i.e.
 * `dirname(fileURLToPath(import.meta.url))`). The repo DNA.md lives three
 * levels up from `apps/ui-web/scripts/` — pass a fake path in tests.
 *
 * If neither file exists, throws — a Luna boot without DNA.md is a
 * misconfigured boot.
 */
export function loadDna(scriptDir: string): string {
  const personalDna = resolvePath(homedir(), ".luna", "DNA.md")
  if (existsSync(personalDna)) {
    return readFileSync(personalDna, "utf-8").trim()
  }
  const repoDna = resolvePath(scriptDir, "../../..", "DNA.md")
  return readFileSync(repoDna, "utf-8").trim()
}
