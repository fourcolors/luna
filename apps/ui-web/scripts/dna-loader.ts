/**
 * Standalone DNA.md loader — extracted so tests can import it without
 * pulling in the full dev-server-chat.ts dependency tree.
 *
 * Imported and re-exported by dev-server-chat.ts; consumers that only
 * need `loadDna` should import from this file directly.
 */
import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"

/**
 * Load DNA.md from the repo root relative to `scriptDir`.
 *
 * `scriptDir` is the directory that contains the calling script (i.e.
 * `dirname(fileURLToPath(import.meta.url))`). DNA.md lives three levels up
 * from `apps/ui-web/scripts/` — pass a fake path in tests.
 *
 * If the file is missing, `readFileSync` throws — that is intentional.
 * A Luna boot without DNA.md is a misconfigured boot.
 */
export function loadDna(scriptDir: string): string {
  const dnaPath = resolvePath(scriptDir, "../../..", "DNA.md")
  return readFileSync(dnaPath, "utf-8").trim()
}
