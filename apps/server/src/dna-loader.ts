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
 * `personalDnaPath` overrides the default `~/.luna/DNA.md` location.
 * Pass `null` to skip the personal override entirely (useful in tests
 * that need to exercise the repo-relative path without interference from
 * the real user install).
 *
 * If neither file exists, throws — a Luna boot without DNA.md is a
 * misconfigured boot.
 */
export function loadDna(
  scriptDir: string,
  personalDnaPath: string | null = resolvePath(homedir(), ".luna", "DNA.md"),
): string {
  if (personalDnaPath !== null && existsSync(personalDnaPath)) {
    return readFileSync(personalDnaPath, "utf-8").trim()
  }
  const repoDna = resolvePath(scriptDir, "../../..", "DNA.md")
  return readFileSync(repoDna, "utf-8").trim()
}

/**
 * Create a resilient DNA loader with a last-good-content cache.
 *
 * Returns a `load()` function that wraps `loadDna`:
 *   - On success: updates the internal cache and returns the content.
 *   - On throw (e.g. files deleted mid-run): logs a one-line console.error
 *     and returns the cached last-good content so thread creation continues.
 *   - First-call failure (no cache yet): rethrows, preserving the loud boot
 *     failure that a misconfigured server should surface.
 *
 * `scriptDir` is passed through to every `loadDna` call.
 * `personalPathOverride` is forwarded as `loadDna`'s second argument
 * (omit or pass `undefined` to use the default `~/.luna/DNA.md`).
 */
export function createDnaLoader(
  scriptDir: string,
  personalPathOverride?: string | null,
): () => string {
  let lastGood: string | undefined
  return function load(): string {
    try {
      const content =
        personalPathOverride !== undefined
          ? loadDna(scriptDir, personalPathOverride)
          : loadDna(scriptDir)
      lastGood = content
      return content
    } catch (err) {
      if (lastGood === undefined) {
        // No cache yet — first call failed. Rethrow for loud boot failure.
        throw err
      }
      console.error(
        "[luna/dna] DNA.md unavailable; using last-good cached content:",
        err instanceof Error ? err.message : String(err),
      )
      return lastGood
    }
  }
}
