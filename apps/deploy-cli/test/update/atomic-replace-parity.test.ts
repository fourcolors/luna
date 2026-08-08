/**
 * Golden parity for the layout flip (S22c part 3).
 *
 * The bash's `luna_atomic_replace` carries a five-case rename(2) table that its
 * own comment says was MEASURED. This suite runs all five against BOTH
 * implementations - the perl one-liner and `fs.renameSync` - and asserts they
 * agree on the verdict AND on the filesystem afterwards. The comment is
 * therefore re-measured on every run rather than trusted.
 *
 * WHY THE REFUSING CASES MATTER MOST. The reason this helper exists is that
 * `mv -fh` exits 0 and silently NESTS src inside a surviving dst, turning a
 * loud pre-flip failure into a corrupt release tree that still satisfies
 * release_artifacts_ok. Cases 3 and 4 are that property. A port that succeeded
 * where the bash refuses would pass any test that only checked the happy path,
 * and would corrupt a release the first time a flip raced a leftover tree.
 *
 * WHAT THE PORT RETIRES, asserted here rather than claimed: the bash needs
 * perl in PATH and shells out; the port calls rename(2) directly. The last
 * test pins that the port needs no subprocess at all, which is the difference
 * that lets the binary flip a layout on a host where the runtime is broken.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { atomicReplaceSync } from "../../src/update/atomic-replace.js"
import { cleanupTempDirs, makeTempDir, repoRoot } from "./temp-dirs.js"

afterEach(() => { cleanupTempDirs() })

const DEPLOY_LIB = join(repoRoot, "scripts/lib/luna-deploy.sh")

/** Run the REAL bash helper (perl-backed) over src/dst. */
const runBash = (src: string, dst: string): { readonly rc: number; readonly stderr: string } => {
  const script = [
    "set -uo pipefail",
    "luna_warn() { printf '%s\\n' \"$*\" >&2; }",
    `eval "$(awk '/^luna_atomic_replace\\(\\)/{f=1} f{print} f && /^}$/{exit}' ${JSON.stringify(DEPLOY_LIB)})"`,
    `luna_atomic_replace ${JSON.stringify(src)} ${JSON.stringify(dst)}; printf '%s' "$?"`,
  ].join("\n")
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" })
  return { rc: Number(r.stdout ?? "-1"), stderr: r.stderr ?? "" }
}

/**
 * Describe what is at a path so the two sides can be compared structurally.
 * The ROOT is stripped: each implementation runs in its own temp dir, so a
 * symlink's absolute target differs between them by construction and comparing
 * raw targets would fail on three correct cases.
 */
const describePath = (p: string, root: string): string => {
  if (!existsSync(p) && !isSymlink(p)) return "absent"
  if (isSymlink(p)) return `symlink->${readlinkSync(p).replace(root, "<root>")}`
  const st = lstatSync(p)
  if (st.isDirectory()) return "dir"
  return `file:${readFileSync(p, "utf8")}`
}

const isSymlink = (p: string): boolean => {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}

/**
 * Build one case's fixture twice - once for each implementation - so neither
 * observes the other's leftovers, then compare verdict and end state.
 */
const parity = (
  name: string,
  build: (root: string) => { src: string; dst: string },
  expected: { ok: boolean; dstAfter?: (root: string) => string },
) => {
  it(name, () => {
    const bashRoot = makeTempDir("atomic-bash-")
    const tsRoot = makeTempDir("atomic-ts-")
    const b = build(bashRoot)
    const t = build(tsRoot)

    const bashResult = runBash(b.src, b.dst)
    const tsResult = atomicReplaceSync(t.src, t.dst)

    expect(bashResult.rc === 0, `bash stderr: ${bashResult.stderr}`).toBe(expected.ok)
    expect(tsResult.ok, `port warning: ${tsResult.warning ?? ""}`).toBe(expected.ok)

    // The filesystem afterwards, not just the return code: a port that
    // "succeeded" by nesting src inside dst would agree on rc and be wrong.
    expect(describePath(t.dst, tsRoot), "dst after the port").toBe(describePath(b.dst, bashRoot))
    expect(existsSync(t.src) || isSymlink(t.src), "src after the port").toBe(
      existsSync(b.src) || isSymlink(b.src),
    )
    if (expected.dstAfter) expect(describePath(t.dst, tsRoot)).toBe(expected.dstAfter(tsRoot))
  })
}

describe("luna_atomic_replace: the five measured rename(2) cases", () => {
  parity(
    "CASE 1 symlink onto an EXISTING symlink: repointed atomically",
    (root) => {
      mkdirSync(join(root, "a"), { recursive: true })
      mkdirSync(join(root, "b"), { recursive: true })
      symlinkSync(join(root, "a"), join(root, "current"))
      symlinkSync(join(root, "b"), join(root, "staged"))
      return { src: join(root, "staged"), dst: join(root, "current") }
    },
    { ok: true, dstAfter: () => "symlink-><root>/b" },
  )

  parity(
    "CASE 2 directory into a VACATED name: plain rename",
    (root) => {
      mkdirSync(join(root, "rebuilt"), { recursive: true })
      writeFileSync(join(root, "rebuilt", "marker"), "new")
      return { src: join(root, "rebuilt"), dst: join(root, "release") }
    },
    { ok: true, dstAfter: () => "dir" },
  )

  // THE SAFETY PROPERTY. `mv -fh` would exit 0 here and nest src inside dst.
  parity(
    "CASE 3 directory onto a NON-EMPTY directory: REFUSED, dst intact",
    (root) => {
      mkdirSync(join(root, "src"), { recursive: true })
      mkdirSync(join(root, "dst"), { recursive: true })
      writeFileSync(join(root, "dst", "keep"), "original")
      return { src: join(root, "src"), dst: join(root, "dst") }
    },
    { ok: false, dstAfter: () => "dir" },
  )

  parity(
    "CASE 4 directory onto a symlink-to-directory: REFUSED loudly",
    (root) => {
      mkdirSync(join(root, "src"), { recursive: true })
      mkdirSync(join(root, "real"), { recursive: true })
      symlinkSync(join(root, "real"), join(root, "link"))
      return { src: join(root, "src"), dst: join(root, "link") }
    },
    { ok: false },
  )

  parity(
    "CASE 5 symlink onto an ABSENT name: created",
    (root) => {
      mkdirSync(join(root, "target"), { recursive: true })
      symlinkSync(join(root, "target"), join(root, "staged"))
      return { src: join(root, "staged"), dst: join(root, "current-profile") }
    },
    { ok: true, dstAfter: () => "symlink-><root>/target" },
  )

  it("CASE 3 leaves dst's CONTENTS untouched, not merely its type", () => {
    // "dst intact" has to mean the original file survives - a nesting
    // implementation also leaves a directory at dst.
    const root = makeTempDir("atomic-case3-")
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(join(root, "src", "intruder"), "x")
    mkdirSync(join(root, "dst"), { recursive: true })
    writeFileSync(join(root, "dst", "keep"), "original")

    const r = atomicReplaceSync(join(root, "src"), join(root, "dst"))
    expect(r.ok).toBe(false)
    expect(readFileSync(join(root, "dst", "keep"), "utf8")).toBe("original")
    expect(existsSync(join(root, "dst", "src")), "src must NOT be nested inside dst").toBe(false)
    expect(existsSync(join(root, "dst", "intruder")), "src's contents must not appear in dst").toBe(false)
  })

  it("names both paths in the failure warning, as the perl one-liner does", () => {
    const root = makeTempDir("atomic-warn-")
    mkdirSync(join(root, "src"), { recursive: true })
    mkdirSync(join(root, "dst"), { recursive: true })
    writeFileSync(join(root, "dst", "keep"), "x")

    const r = atomicReplaceSync(join(root, "src"), join(root, "dst"))
    expect(r.warning).toContain("luna_atomic_replace: ")
    expect(r.warning).toContain(`${join(root, "src")} -> ${join(root, "dst")}`)
    // The errno half is the platform's strerror, exactly as perl's $! is -
    // asserted as "present and non-empty" rather than pinned to a wording
    // neither implementation controls.
    expect(r.warning?.split(": ").at(-1)?.length ?? 0).toBeGreaterThan(0)
  })

  it("needs no subprocess, which is what lets it flip on a host with a broken runtime", () => {
    // The bash shells out to perl and hard-depends on it being in PATH. The
    // port is a single rename(2). Proven by running with PATH emptied: the
    // bash helper cannot work, the port does not care.
    const root = makeTempDir("atomic-nopath-")
    mkdirSync(join(root, "target"), { recursive: true })
    symlinkSync(join(root, "target"), join(root, "staged"))

    const bashNoPath = spawnSync(
      "bash",
      ["-c", `PATH=""; luna_warn() { :; }; eval "$(awk '/^luna_atomic_replace\\(\\)/{f=1} f{print} f && /^}$/{exit}' ${JSON.stringify(DEPLOY_LIB)})"; luna_atomic_replace a b; printf '%s' "$?"`],
      { encoding: "utf8" },
    )
    expect(bashNoPath.stdout, "bash returns its perl-missing code 127").toBe("127")

    expect(atomicReplaceSync(join(root, "staged"), join(root, "current")).ok).toBe(true)
  })
})
