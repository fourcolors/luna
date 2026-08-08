/**
 * The layout flip: a port of `luna_atomic_replace`
 * (scripts/lib/luna-deploy.sh:389-427).
 *
 * WHAT THIS SLICE ACTUALLY RETIRES. The bash reaches rename(2) by shelling out
 * to perl, and says why: it must keep working when the bun runtime is exactly
 * what is broken, so it cannot be bun-based, and a GNU-vs-BSD `mv -T` probe is
 * the thing S01 removed. Inside the binary that constraint is gone - the
 * process IS the runtime - and `fs.renameSync` is rename(2) directly. So this
 * port drops BOTH dependencies the bash carries: no `mv -T` capability probe
 * (already gone) and no perl in PATH (gone here). One syscall, no subprocess.
 *
 * THE SAFETY PROPERTY IS THE WHOLE POINT, and it is a property of rename(2)
 * rather than of either implementation: `mv -fh` exits 0 and silently NESTS
 * src inside a surviving dst, turning a loud pre-flip failure into a corrupt
 * release tree that still satisfies release_artifacts_ok. rename(2) refuses.
 * That refusal is why this helper exists at all, and why the parity suite
 * asserts the REFUSING cases as carefully as the succeeding ones.
 *
 * THE FIVE-CASE TABLE, transcribed from the bash's own MEASURED table. The
 * parity suite runs all five against both implementations rather than trusting
 * this comment:
 *
 *   1 symlink   -> EXISTING symlink : ok, dst repointed atomically.
 *                  Every re-flip of an installed profile lands here.
 *   2 directory -> VACATED name     : ok, plain rename semantics.
 *                  The staged swap: damaged tree moved aside, name vacated
 *                  BEFORE the rebuilt tree is swapped in.
 *   3 directory -> NON-EMPTY dir    : REFUSED loudly, dst intact.
 *                  The property `mv -fh` lacks.
 *   4 directory -> symlink-to-dir   : REFUSED (ENOTDIR), loudly.
 *                  Unreachable at every current call site; a future caller
 *                  that reaches it fails loudly rather than silently.
 *   5 symlink   -> ABSENT name      : ok, dst created.
 *                  The first install for a profile lands here.
 *
 * THE WARNING TEXT IS BYTE-EXACT with the perl one-liner's
 * (`luna_atomic_replace: <src> -> <dst>: <errno>`), because an operator
 * comparing a binary host's output against a bash host's during an incident
 * should see the same sentence. The errno STRING is the platform's, exactly as
 * `$!` is in perl - both render strerror(3), so neither is portable text and
 * neither pretends to be.
 */
import { renameSync } from "node:fs"

export interface AtomicReplaceResult {
  readonly ok: boolean
  /** Byte-exact with the bash warning; absent on success. */
  readonly warning?: string
}

/**
 * `luna_atomic_replace <src> <dst>` (scripts/lib/luna-deploy.sh:423-427).
 *
 * Returns rather than throwing: the bash returns 1 and lets the caller route
 * the failure (pre-flip failures warn and exit 1 with `current` untouched -
 * scripts/luna-update-server:647), and a port that threw would invert that
 * control flow at every call site.
 */
export function atomicReplaceSync(src: string, dst: string): AtomicReplaceResult {
  try {
    renameSync(src, dst)
    return { ok: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? ""
    return { ok: false, warning: `luna_atomic_replace: ${src} -> ${dst}: ${errnoText(code, err)}` }
  }
}

/**
 * perl's `$!` renders strerror(3); Node hands back a `code` (ENOTEMPTY) plus a
 * message that already embeds the same strerror text. This pulls out the
 * human half so the two warnings read alike, and falls back to the raw message
 * rather than inventing wording for an errno it has not seen.
 */
function errnoText(code: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // Node formats as "ENOTEMPTY: directory not empty, rename 'a' -> 'b'".
  const afterCode = code !== "" && message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message
  const beforeSyscall = afterCode.split(", rename")[0] ?? afterCode
  return beforeSyscall
}
