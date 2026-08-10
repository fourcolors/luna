/**
 * The "ENFORCED BY GREP in CI" section of the S22d PR2 spec
 * (docs/next/stack23-s22d-pr2-spec.md:1197-1209), as executable assertions.
 *
 * WHY A TEST AND NOT A CI SHELL STEP. Every rule in that section is a property
 * of the SHAPE of the source tree, not of any behaviour: "nothing under
 * `src/update/` reads the ambient environment", "nothing under `src/update/`
 * terminates the process", "no options record relies on a module default for a
 * seam that performs IO". No behavioural test can observe any of them, because
 * a module that reads `process.env` behaves identically to one that does not
 * right up until the day a test forgets to stub the environment and a real
 * `systemctl stop` runs on a self-hosted runner. Keeping the rules in the
 * default `bun run test` gate rather than in a `.github/workflows` grep step
 * also means a developer sees them go red before pushing, and means the
 * rationale for each one lives beside the assertion.
 *
 * THE VACUITY PROBLEM, WHICH THIS FILE TAKES SERIOUSLY. A grep-shaped
 * invariant has a failure mode no ordinary assertion has: it passes when it
 * matched nothing. A typo in the pattern, a moved directory, a renamed file,
 * or a glob that returns an empty list all produce a green "no violations
 * found" that is indistinguishable from a genuinely clean tree. This slice has
 * already been bitten once by a rule that never fired. So EVERY rule below
 * pairs its violation assertion with a POSITIVE-CONTROL assertion that pins
 * the size and membership of the set it scanned, and, wherever the pattern has
 * a legitimate occurrence somewhere else in the tree, an assertion that the
 * pattern really does match THERE. If the scan set empties out, or the pattern
 * stops matching its own known-good example, this file goes red rather than
 * silently green.
 *
 * PURE AND PORTABLE. Everything except the last suite is `readFileSync` over
 * files that are in the repository: no spawn, no temp dirs, no platform
 * behaviour, nothing that assumes macOS or one developer machine. The one
 * suite that does spawn resolves `git` explicitly through `resolveHostTool`,
 * never through "whatever launched the tests".
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveHostTool } from "./bash-fixtures.js"
import { repoRoot } from "./temp-dirs.js"

const APP_ROOT = new URL("../..", import.meta.url).pathname
const SRC = join(APP_ROOT, "src")

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/**
 * Two views of a TypeScript source file, both produced by one pass.
 *
 * `code` has comments removed and string literals INTACT, and is what the
 * token rules below grep. Removing comments is the whole point of the
 * anchoring hazard the spec calls out at :1201: `numbers.ts:66` contains the
 * literal text "process.exit(" inside the comment that explains why the grep
 * must be anchored, so a rule run over raw bytes reports the documentation as
 * the violation.
 *
 * `skeleton` additionally blanks the CONTENTS of every string and template
 * literal, keeping the quotes. It is what the options-record rule parses,
 * because a brace or a colon inside an operator string must not be mistaken
 * for structure.
 *
 * Both preserve line numbering exactly: every removed character becomes a
 * space and every newline survives, so a reported index maps back to a real
 * `file:line` a reader can open.
 */
interface SourceViews {
  readonly code: string
  readonly skeleton: string
}

const scan = (src: string): SourceViews => {
  let code = ""
  let skeleton = ""
  const blank = (ch: string): void => {
    code += ch === "\n" ? "\n" : " "
    skeleton += ch === "\n" ? "\n" : " "
  }
  const keep = (ch: string): void => {
    code += ch
    skeleton += ch
  }
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i] as string
    const d = src[i + 1]
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") {
        blank(src[i] as string)
        i++
      }
      continue
    }
    if (c === "/" && d === "*") {
      blank(c)
      blank(d as string)
      i += 2
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        blank(src[i] as string)
        i++
      }
      if (i < n) {
        blank("*")
        blank("/")
        i += 2
      }
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      keep(c)
      i++
      while (i < n) {
        const ch = src[i] as string
        if (ch === "\\") {
          code += ch
          skeleton += " "
          i++
          if (i < n) {
            code += src[i] as string
            skeleton += src[i] === "\n" ? "\n" : " "
            i++
          }
          continue
        }
        if (ch === c) {
          keep(ch)
          i++
          break
        }
        code += ch
        skeleton += ch === "\n" ? "\n" : " "
        i++
      }
      continue
    }
    if (c === "/" && regexCanStartHere(code)) {
      // A REGEX LITERAL, not division. lock.ts:183 is why this branch exists:
      // `firstLine.replace(/^.*\) /, "")` carries an UNMATCHED `)` inside the
      // pattern, and a scanner that treated it as code would read the file's
      // bracket depth as one lower from there to the end of the file.
      keep(c)
      i++
      let inClass = false
      while (i < n) {
        const ch = src[i] as string
        if (ch === "\\") {
          code += ch
          skeleton += " "
          i++
          if (i < n) {
            code += src[i] as string
            skeleton += " "
            i++
          }
          continue
        }
        if (ch === "[") inClass = true
        else if (ch === "]") inClass = false
        else if (ch === "/" && !inClass) {
          keep(ch)
          i++
          break
        }
        code += ch
        skeleton += " "
        i++
      }
      while (i < n && /[dgimsuvy]/.test(src[i] as string)) {
        keep(src[i] as string)
        i++
      }
      continue
    }
    keep(c)
    i++
  }
  return { code, skeleton }
}

/**
 * Whether a `/` at the current position opens a regex literal rather than a
 * division. The standard heuristic: look back at the last significant
 * character already emitted. Division can only follow a value, so a `/` after
 * an operator, an opening bracket, a comma, a semicolon, a newline or one of
 * the value-introducing keywords is a regex.
 */
const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">"])
const REGEX_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "case", "do", "else", "yield", "await", "new", "delete", "void"])

const regexCanStartHere = (emitted: string): boolean => {
  let j = emitted.length - 1
  while (j >= 0 && /\s/.test(emitted[j] as string)) j--
  if (j < 0) return true
  const prev = emitted[j] as string
  if (REGEX_PRECEDERS.has(prev)) return true
  if (!/[A-Za-z0-9_$]/.test(prev)) return false
  let k = j
  while (k >= 0 && /[A-Za-z0-9_$]/.test(emitted[k] as string)) k--
  return REGEX_KEYWORDS.has(emitted.slice(k + 1, j + 1))
}

/** 1-based line number of a character offset, so a failure names a line a reader can open. */
const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length

interface Hit {
  readonly file: string
  readonly line: number
  readonly text: string
}

const hits = (files: ReadonlyArray<string>, view: (v: SourceViews) => string, pattern: RegExp): ReadonlyArray<Hit> => {
  const found: Hit[] = []
  for (const file of files) {
    const text = view(sources.get(file) as SourceViews)
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)
    let m = re.exec(text)
    while (m !== null) {
      const line = lineOf(text, m.index)
      found.push({ file, line, text: `${file}:${line}` })
      m = re.exec(text)
    }
  }
  return found
}

/** Raw-byte hits, deliberately NOT comment-stripped: the positive controls need to see the comments. */
const rawHits = (files: ReadonlyArray<string>, pattern: RegExp): ReadonlyArray<Hit> => {
  const found: Hit[] = []
  for (const file of files) {
    const text = raw.get(file) as string
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)
    let m = re.exec(text)
    while (m !== null) {
      found.push({ file, line: lineOf(text, m.index), text: `${file}:${lineOf(text, m.index)}` })
      m = re.exec(text)
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// The scan set, loaded once
// ---------------------------------------------------------------------------

const tsFilesUnder = (dir: string, prefix: string): ReadonlyArray<string> => {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...tsFilesUnder(join(dir, entry.name), rel))
    else if (entry.name.endsWith(".ts")) out.push(rel)
  }
  return out.sort()
}

/** Repo-relative-to-`src/` names, e.g. `update/wiring.ts` and `update-command.ts`. */
const SRC_FILES = tsFilesUnder(SRC, "")
const UPDATE_FILES = SRC_FILES.filter((f) => f.startsWith("update/"))

const raw = new Map<string, string>(SRC_FILES.map((f) => [f, readFileSync(join(SRC, f), "utf8")]))
const sources = new Map<string, SourceViews>(SRC_FILES.map((f) => [f, scan(raw.get(f) as string)]))

/**
 * The seventeen PR1 modules plus the six this slice added. Membership is
 * asserted, not just the count: a rule that scanned an empty directory and a
 * rule that scanned the wrong directory both produce zero violations, and the
 * only thing that tells them apart from a clean tree is naming what should
 * have been there.
 */
const EXPECTED_UPDATE_MODULES: ReadonlyArray<string> = [
  "update/apply-inplace.ts",
  "update/atomic-file.ts",
  "update/atomic-replace.ts",
  "update/bash-lib.ts",
  "update/commands.ts",
  "update/config.ts",
  "update/delegate.ts",
  "update/flow-lines.ts",
  "update/fresh-run.ts",
  "update/health-journal.ts",
  "update/journal.ts",
  "update/lock.ts",
  "update/numbers.ts",
  "update/preflight.ts",
  "update/probes.ts",
  "update/readiness.ts",
  "update/restart-only.ts",
  "update/restart.ts",
  "update/rollback.ts",
  "update/run-update.ts",
  "update/session-guard.ts",
  "update/status-file.ts",
  "update/target.ts",
  "update/terminals.ts",
  "update/update-flow.ts",
  "update/wiring.ts",
]

/** The composition root: the ONE file on the process-boundary side of the line (spec:1160-1166). */
const COMPOSITION_ROOT = "update-command.ts"

// ---------------------------------------------------------------------------

describe("the scan set itself (the positive control every rule below leans on)", () => {
  it(
    "found every module the rules are supposed to cover, and read each one",
    () => {
      expect(UPDATE_FILES.length, "src/update/*.ts count").toBeGreaterThanOrEqual(EXPECTED_UPDATE_MODULES.length)
      for (const mod of EXPECTED_UPDATE_MODULES) {
        expect(UPDATE_FILES, `${mod} must be in the scan set`).toContain(mod)
        expect((raw.get(mod) as string).length, `${mod} must be non-empty`).toBeGreaterThan(200)
      }
      expect(SRC_FILES, "the composition root must be scanned too").toContain(COMPOSITION_ROOT)
      expect(SRC_FILES, "main.ts is the other process-boundary file").toContain("main.ts")
    },
    { timeout: 10_000 },
  )

  it(
    "strips comments without eating code, proven on a fixture with every hazard in it",
    () => {
      const fixture = [
        '// process.exit(1) in a line comment',
        '/* process.env in a block comment',
        '   spanning lines */',
        'const a = "process.exit( inside a string"',
        'const b = `process.env inside a template`',
        "const c = 'a \\' escaped quote, then process.exit('",
        "const d = /\\n+$/.test(x) // trailing comment",
        "const real = process.env.PATH",
      ].join("\n")
      const v = scan(fixture)
      // Comments are gone from BOTH views.
      expect(v.code).not.toContain("in a line comment")
      expect(v.code).not.toContain("in a block comment")
      expect(v.code).not.toContain("trailing comment")
      // Code survives intact in `code`, strings and all.
      expect(v.code).toContain('const a = "process.exit( inside a string"')
      expect(v.code).toContain("const real = process.env.PATH")
      // `skeleton` blanks string contents but keeps the quotes and the code.
      expect(v.skeleton).toContain("const a = ")
      expect(v.skeleton).not.toContain("inside a string")
      expect(v.skeleton).not.toContain("inside a template")
      expect(v.skeleton).toContain("const real = process.env.PATH")
      // Line numbering is preserved, which is what makes a reported line usable.
      expect(v.code.split("\n").length).toBe(fixture.split("\n").length)
      expect(v.skeleton.split("\n").length).toBe(fixture.split("\n").length)
    },
    { timeout: 10_000 },
  )

  it(
    "produced a balanced skeleton for every scanned file, which is how a mis-parsed string would announce itself",
    () => {
      const unbalanced: string[] = []
      for (const file of SRC_FILES) {
        const s = (sources.get(file) as SourceViews).skeleton
        let depth = 0
        let min = 0
        for (const ch of s) {
          if (ch === "{" || ch === "(" || ch === "[") depth++
          else if (ch === "}" || ch === ")" || ch === "]") depth--
          if (depth < min) min = depth
        }
        if (depth !== 0 || min < 0) unbalanced.push(`${file} (final depth ${depth}, min ${min})`)
      }
      expect(unbalanced, "a non-zero bracket depth means the scanner mis-read a string or a comment").toEqual([])
    },
    { timeout: 10_000 },
  )
})

// ---------------------------------------------------------------------------
// Rule 1 - no child_process import in the eight leaf modules (spec:1199)
// ---------------------------------------------------------------------------

/** Verbatim from spec:1199. These eight are the pure ones: they compute bytes and decide, they never spawn. */
const NO_CHILD_PROCESS: ReadonlyArray<string> = [
  "update/update-flow.ts",
  "update/terminals.ts",
  "update/flow-lines.ts",
  "update/commands.ts",
  "update/numbers.ts",
  "update/apply-inplace.ts",
  "update/fresh-run.ts",
  "update/restart-only.ts",
]

const CHILD_PROCESS = /child_process/

describe("rule 1: the eight leaf modules import no child_process (spec:1199)", () => {
  it(
    "scanned all eight and found none",
    () => {
      for (const mod of NO_CHILD_PROCESS) {
        expect(UPDATE_FILES, `${mod} must exist to be checked`).toContain(mod)
      }
      expect(hits(NO_CHILD_PROCESS, (v) => v.code, CHILD_PROCESS).map((h) => h.text)).toEqual([])
    },
    { timeout: 10_000 },
  )

  it(
    "positive control: the same pattern DOES match the modules that legitimately spawn",
    () => {
      // If this goes green-and-empty the pattern is broken and rule 1 proves nothing.
      const spawners = hits(SRC_FILES, (v) => v.code, CHILD_PROCESS).map((h) => h.file)
      expect(new Set(spawners).size, "some file in src/ must import child_process").toBeGreaterThanOrEqual(5)
      expect(spawners, "target.ts owns the spawn seam").toContain("update/target.ts")
      expect(spawners, "the composition root spawns the real binaries").toContain(COMPOSITION_ROOT)
    },
    { timeout: 10_000 },
  )
})

// ---------------------------------------------------------------------------
// Rule 2 - no process.exit( under src/update/ (spec:1200-1201)
// ---------------------------------------------------------------------------

/**
 * ANCHORED ON THE OPEN PARENTHESIS, which spec:1201 requires and which the
 * tree makes necessary twice over. Three comments under `src/update/` contain
 * the English words "process exit" or "process exits" (restart.ts:72,
 * lock.ts:208, terminals.ts:6 and :120 - note the spec cites restart.ts:38 for
 * the first of those, which is stale; the prose moved to :72), and one comment
 * contains the anchored token itself (numbers.ts:66). Anchoring handles the
 * first class; comment stripping handles the second.
 */
const PROCESS_EXIT_ANCHORED = /\bprocess\s*\.\s*exit\s*\(/
const PROCESS_EXIT_LOOSE = /process exit/

describe("rule 2: nothing under src/update/ terminates the process (spec:1200-1201)", () => {
  it(
    "no anchored process.exit( in any of the twenty-six modules",
    () => {
      expect(UPDATE_FILES.length).toBeGreaterThanOrEqual(EXPECTED_UPDATE_MODULES.length)
      expect(hits(UPDATE_FILES, (v) => v.code, PROCESS_EXIT_ANCHORED).map((h) => h.text)).toEqual([])
    },
    { timeout: 10_000 },
  )

  it(
    "positive control: the pattern matches the single real exit, which lives at the process boundary",
    () => {
      const boundary = hits([COMPOSITION_ROOT], (v) => v.code, PROCESS_EXIT_ANCHORED)
      expect(boundary.length, "update-command.ts owns the one exit for this subcommand").toBe(1)
      // main.ts is the other boundary file and has its own; both are outside src/update/.
      expect(hits(["main.ts"], (v) => v.code, PROCESS_EXIT_ANCHORED).length).toBeGreaterThanOrEqual(1)
    },
    { timeout: 10_000 },
  )

  it(
    "positive control: comment stripping is load-bearing, because a raw grep reports the documentation",
    () => {
      // spec:1201's hazard, made an assertion rather than a footnote: numbers.ts
      // documents the anchoring rule using the banned token, so a rule that ran
      // over raw bytes would be red today for a comment.
      const rawAnchored = rawHits(UPDATE_FILES, PROCESS_EXIT_ANCHORED)
      expect(rawAnchored.map((h) => h.text)).toContain("update/numbers.ts:66")
      // And the loose pattern the spec warns against would report prose in at least two files.
      const loose = rawHits(UPDATE_FILES, PROCESS_EXIT_LOOSE)
      expect(new Set(loose.map((h) => h.file)).size, "a loose grep would report English prose").toBeGreaterThanOrEqual(2)
      expect(loose.map((h) => h.file)).toContain("update/lock.ts")
    },
    { timeout: 10_000 },
  )
})

// ---------------------------------------------------------------------------
// Rule 3 - no NEW process.env read under src/update/ (spec:1202-1204)
// ---------------------------------------------------------------------------

const PROCESS_ENV = /\bprocess\s*\.\s*env\b/
const SPAWN_BASH_SYNC = /\bspawnBashSync\b/

describe("rule 3: src/update/ reads the ambient environment in exactly one pre-existing place (spec:1202-1204)", () => {
  it(
    "the only non-comment process.env under src/update/ is spawnBashSync's",
    () => {
      const found = hits(UPDATE_FILES, (v) => v.code, PROCESS_ENV)
      expect(found.map((h) => h.text)).toEqual(["update/bash-lib.ts:151"])
      // Not just the location: the line must still be the convenience wrapper,
      // so a future edit that keeps the line number but changes the meaning fails.
      const line = (raw.get("update/bash-lib.ts") as string).split("\n")[150]
      expect(line).toContain("export const spawnBashSync")
      expect(line).toContain("process.env")
    },
    { timeout: 10_000 },
  )

  it(
    "spawnBashSync has zero callers under src/, so that one read is dead in production",
    () => {
      const refs = hits(SRC_FILES, (v) => v.code, SPAWN_BASH_SYNC)
      // Exactly one occurrence in the whole of src/: the definition itself.
      expect(refs.map((h) => h.text)).toEqual(["update/bash-lib.ts:151"])
    },
    { timeout: 10_000 },
  )

  it(
    "positive control: comment stripping is load-bearing here too, and the boundary file does read process.env",
    () => {
      // Many comments under src/update/ discuss process.env; a raw grep is noisy
      // by a wide margin, which is exactly why the rule is not a shell grep.
      const noisy = rawHits(UPDATE_FILES, PROCESS_ENV)
      expect(noisy.length, "raw process.env mentions under src/update/").toBeGreaterThanOrEqual(8)
      expect(new Set(noisy.map((h) => h.file)).size).toBeGreaterThanOrEqual(3)
      // And the permitted boundary really does read it, so the pattern is not broken.
      expect(hits([COMPOSITION_ROOT], (v) => v.code, PROCESS_ENV).length).toBeGreaterThanOrEqual(1)
    },
    { timeout: 10_000 },
  )

  it(
    "realSeams and realUpdateIo live OUTSIDE src/update/, which is what makes rule 3 satisfiable (spec:1160-1166)",
    () => {
      const defRealSeams = /export const realSeams\b/
      const defRealUpdateIo = /export const realUpdateIo\b/
      expect(hits(UPDATE_FILES, (v) => v.code, defRealSeams).map((h) => h.text)).toEqual([])
      expect(hits(UPDATE_FILES, (v) => v.code, defRealUpdateIo).map((h) => h.text)).toEqual([])
      expect(hits([COMPOSITION_ROOT], (v) => v.code, defRealSeams).length).toBe(1)
      expect(hits([COMPOSITION_ROOT], (v) => v.code, defRealUpdateIo).length).toBe(1)
    },
    { timeout: 10_000 },
  )
})

// ---------------------------------------------------------------------------
// Rule 4 - no options record relies on a module default for an IO seam
//          (spec:1176-1180, restated at :1205-1207)
// ---------------------------------------------------------------------------

/**
 * Top-level keys of the object literal that starts at `openBrace`.
 *
 * Runs over the SKELETON, so a colon or a brace inside an operator string
 * cannot be read as structure. Tracks key position explicitly rather than
 * matching `identifier:` with a regex, because a regex cannot tell the `guard`
 * in `...opts.guard,` (a spread of somebody else's field) from the `guard` in
 * `guard: { ... }` (a key), and this port has both.
 */
const literalKeysAt = (skeleton: string, openBrace: number): ReadonlyArray<string> => {
  const keys: string[] = []
  let depth = 0
  let expectKey = true
  const isWordStart = (ch: string): boolean => /[A-Za-z_$]/.test(ch)
  const isWord = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch)
  for (let i = openBrace; i < skeleton.length; i++) {
    const c = skeleton[i] as string
    if (c === "{" || c === "(" || c === "[") {
      depth++
      if (depth === 1) expectKey = true
      continue
    }
    if (c === "}" || c === ")" || c === "]") {
      depth--
      if (depth === 0) return keys
      continue
    }
    if (depth !== 1) continue
    if (c === ",") {
      expectKey = true
      continue
    }
    if (/\s/.test(c) || c === ".") continue
    if (!expectKey) continue
    if (isWordStart(c)) {
      let j = i
      while (j < skeleton.length && isWord(skeleton[j] as string)) j++
      const word = skeleton.slice(i, j)
      let k = j
      while (k < skeleton.length && /\s/.test(skeleton[k] as string)) k++
      const next = skeleton[k]
      if (next === ":" || next === "," || next === "}") keys.push(word)
      expectKey = false
      i = j - 1
      continue
    }
    expectKey = false
  }
  throw new Error(`unterminated object literal starting at offset ${openBrace}`)
}

/** Offset of the `}` closing the `{` at `open`, over the skeleton where brackets are structure. */
const matchingBrace = (skeleton: string, open: number): number => {
  let depth = 0
  for (let i = open; i < skeleton.length; i++) {
    const c = skeleton[i]
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error(`unterminated brace at offset ${open}`)
}

/** Offsets of every call to `fn(` in a file, ignoring its own declaration (`const fn = (`) and its import. */
const callSitesOf = (skeleton: string, fn: string): ReadonlyArray<number> => {
  const re = new RegExp(`(^|[^A-Za-z0-9_$.])${fn}\\s*\\(`, "g")
  const out: number[] = []
  let m = re.exec(skeleton)
  while (m !== null) {
    out.push(m.index + m[0].length - 1)
    m = re.exec(skeleton)
  }
  return out
}

/** From the `(` of a call, the offset of the `{` that opens its first object-literal argument, or null. */
const literalArgAfter = (skeleton: string, openParen: number): number | null => {
  let i = openParen + 1
  while (i < skeleton.length && /\s/.test(skeleton[i] as string)) i++
  return skeleton[i] === "{" ? i : null
}

interface OptionsRule {
  /** The PR1 entry point whose options record is at stake. */
  readonly fn: string
  /** The module that owns the `?? default` fallbacks, and the marker text proving each one is still live. */
  readonly owner: string
  /** Seam name -> the exact `??` fallback in the owner that a missing key would silently take. */
  readonly seams: ReadonlyArray<readonly [string, string]>
  /**
   * Files whose call sites must name EVERY seam. spec:1207's reviewable form is
   * that `wiring.ts` and `run-update.ts` are the only two files that build such
   * records, and this is the assertion behind that sentence.
   */
  readonly constructedIn: ReadonlyArray<string>
  /**
   * Owner-internal forwarders: a PR1 module handing its own already-complete
   * options record down to a helper. Allowed, and enumerated so a NEW call site
   * anywhere else in the tree fails this suite rather than quietly defaulting.
   */
  readonly forwardedIn: ReadonlyArray<string>
}

const OPTIONS_RULES: ReadonlyArray<OptionsRule> = [
  {
    fn: "runPreflightSync",
    owner: "update/preflight.ts",
    seams: [
      ["dirExists", "opts.dirExists ?? realDirExists"],
      ["fileExists", "opts.fileExists ?? realFileExists"],
      ["containerFileExists", "opts.containerFileExists ?? realContainerFileExists"],
      ["gitCurrentBranch", "opts.gitCurrentBranch ?? realGitCurrentBranch"],
    ],
    constructedIn: ["update/run-update.ts"],
    forwardedIn: [],
  },
  {
    fn: "acquireUpdateLockSync",
    owner: "update/lock.ts",
    seams: [
      ["processAlive", "probes.processAlive ?? processAliveSync"],
      ["processFingerprint", "opts.processFingerprint ?? processFingerprintSync"],
    ],
    constructedIn: ["update/run-update.ts"],
    forwardedIn: [],
  },
  {
    fn: "delegateToBashSync",
    owner: "update/delegate.ts",
    seams: [
      ["runEngine", "options.runEngine ?? defaultRunEngine"],
      ["isExecutableFile", "options.isExecutableFile ?? defaultIsExecutableFile"],
    ],
    constructedIn: ["update/run-update.ts"],
    forwardedIn: [],
  },
  {
    fn: "restartSessionGuardSync",
    owner: "update/session-guard.ts",
    seams: [
      ["queryActiveWsCount", "opts.queryActiveWsCount ?? queryActiveWsCountSync"],
      ["readUnitState", "opts.readUnitState ?? queryUnitStateSync"],
    ],
    // restart.ts:256 forwards `...opts.guard` and supplies its own target-routed
    // `readUnitState`; that record was itself built completely at wiring.ts:449.
    constructedIn: ["update/wiring.ts"],
    forwardedIn: ["update/restart.ts"],
  },
  {
    fn: "restartServiceSync",
    owner: "update/restart.ts",
    seams: [["sleepSync", "opts.sleepSync ?? defaultSleepSync"]],
    constructedIn: ["update/wiring.ts"],
    forwardedIn: [],
  },
  {
    fn: "settleAfterStopSync",
    owner: "update/restart.ts",
    seams: [["sleepSync", "opts.sleepSync ?? defaultSleepSync"]],
    // No outer constructor: restartServiceSync forwards its own `sleepSync`
    // conditionally (restart.ts:301-305), and that field came from wiring.ts:455.
    constructedIn: [],
    forwardedIn: ["update/restart.ts"],
  },
]

describe("rule 4: no options record under src/ relies on a module default for an IO seam (spec:1176-1180, :1205-1207)", () => {
  it(
    "every seam in the table still HAS the module default it is protecting against",
    () => {
      // The anti-vacuity assertion for this whole rule. If a `??` fallback is
      // deleted or renamed the rule below still passes trivially, so the table
      // is checked against the source it describes before it is used.
      expect(OPTIONS_RULES.length, "entry points covered").toBe(6)
      const seamCount = OPTIONS_RULES.reduce((acc, r) => acc + r.seams.length, 0)
      expect(seamCount, "IO seams covered").toBe(12)
      for (const rule of OPTIONS_RULES) {
        const owner = (sources.get(rule.owner) as SourceViews).code
        for (const [seam, fallback] of rule.seams) {
          expect(owner, `${rule.owner} must still contain the default \`${fallback}\` that ${seam} guards`).toContain(
            fallback,
          )
        }
      }
    },
    { timeout: 10_000 },
  )

  it(
    "the only files that call these entry points are the two composition files plus the owners' own forwarders",
    () => {
      for (const rule of OPTIONS_RULES) {
        const callers = SRC_FILES.filter(
          (f) => f !== rule.owner && callSitesOf((sources.get(f) as SourceViews).skeleton, rule.fn).length > 0,
        )
        const allowed = [...rule.constructedIn, ...rule.forwardedIn].filter((f) => f !== rule.owner).sort()
        expect([...callers].sort(), `callers of ${rule.fn} outside its own module`).toEqual(allowed)
        if (rule.forwardedIn.length > 0) {
          for (const fwd of rule.forwardedIn) {
            expect(
              callSitesOf((sources.get(fwd) as SourceViews).skeleton, rule.fn).length,
              `${fwd} must still forward to ${rule.fn}`,
            ).toBeGreaterThanOrEqual(1)
          }
        }
      }
    },
    { timeout: 10_000 },
  )

  it(
    "every outer construction site names every IO seam explicitly",
    () => {
      let sitesChecked = 0
      for (const rule of OPTIONS_RULES) {
        for (const file of rule.constructedIn) {
          const skeleton = (sources.get(file) as SourceViews).skeleton
          const calls = callSitesOf(skeleton, rule.fn)
          expect(calls.length, `${file} must call ${rule.fn}`).toBeGreaterThanOrEqual(1)
          for (const paren of calls) {
            const brace = literalArgAfter(skeleton, paren)
            expect(brace, `${file}:${lineOf(skeleton, paren)} must pass ${rule.fn} an object literal`).not.toBeNull()
            const keys = literalKeysAt(skeleton, brace as number)
            for (const [seam] of rule.seams) {
              expect(keys, `${file}:${lineOf(skeleton, paren)} ${rule.fn}({...}) must bind ${seam}`).toContain(seam)
            }
            sitesChecked++
          }
        }
      }
      // Assert the SCAN, not only the result: five construction sites exist and
      // were parsed. A key extractor that silently returned [] for all of them
      // would fail every membership check above, and a call-site finder that
      // matched nothing would fail here.
      expect(sitesChecked, "outer construction sites parsed").toBe(5)
    },
    { timeout: 10_000 },
  )

  it(
    "the nested guard record inside restartServiceSync binds its own IO seam (spec:1178)",
    () => {
      const skeleton = (sources.get("update/wiring.ts") as SourceViews).skeleton
      const calls = callSitesOf(skeleton, "restartServiceSync")
      expect(calls.length).toBe(1)
      const brace = literalArgAfter(skeleton, calls[0] as number) as number
      expect(literalKeysAt(skeleton, brace)).toContain("guard")
      const guardAt = skeleton.indexOf("guard:", brace)
      expect(guardAt).toBeGreaterThan(brace)
      const guardBrace = skeleton.indexOf("{", guardAt)
      const guardKeys = literalKeysAt(skeleton, guardBrace)
      expect(guardKeys, "the nested guard options carry the ws-count seam").toContain("queryActiveWsCount")
      // `readUnitState` is deliberately NOT here: restart.ts:274 derives it from
      // the SAME `runSystemctl` transport it restarts through, which is the
      // property that keeps the guard and the restart pointed at one target
      // (spec:1177). Pinned so a future edit that "helpfully" adds it here,
      // re-decoupling the two, fails.
      expect(guardKeys, "readUnitState must stay derived from the restart transport").not.toContain("readUnitState")
    },
    { timeout: 10_000 },
  )

  it(
    "buildTargetContext fills spawn and writeStdout rather than taking target.ts's real-IO defaults",
    () => {
      const skeleton = (sources.get("update/wiring.ts") as SourceViews).skeleton
      const target = (sources.get("update/target.ts") as SourceViews).code
      // Both defaults are live in target.ts, so both are worth filling.
      expect(target).toContain("ctx.spawn ?? defaultSpawnTarget")
      expect(target).toContain("ctx.writeStdout ??")
      const decl = skeleton.indexOf("export const buildTargetContext")
      expect(decl, "buildTargetContext must live in wiring.ts").toBeGreaterThanOrEqual(0)
      const arrow = skeleton.indexOf("=>", decl)
      const brace = skeleton.indexOf("{", arrow)
      const keys = literalKeysAt(skeleton, brace)
      expect(keys).toContain("spawn")
      expect(keys).toContain("writeStdout")
      expect(keys.length, "the TargetContext this builds").toBeGreaterThanOrEqual(7)
    },
    { timeout: 10_000 },
  )

  it(
    "every UpdateIo field is consumed by the two composition files, so no declared seam is silently unwired",
    () => {
      const wiring = sources.get("update/wiring.ts") as SourceViews
      const decl = wiring.code.indexOf("interface UpdateIo")
      expect(decl, "UpdateIo must be declared in wiring.ts").toBeGreaterThanOrEqual(0)
      // Bounded by brace matching on the skeleton, never by "to end of file":
      // the two views are the same length as the original, so a skeleton offset
      // indexes the comment-free code directly.
      const open = wiring.skeleton.indexOf("{", decl)
      const close = matchingBrace(wiring.skeleton, open)
      const body = wiring.code.slice(open, close)
      const names = body
        .split("\n")
        .map((l) => /^\s*readonly ([A-Za-z0-9_$]+)\s*:/.exec(l)?.[1])
        .filter((x): x is string => x !== undefined)
      expect(names.length, "UpdateIo seams declared").toBe(18)
      const consumers = [
        (sources.get("update/wiring.ts") as SourceViews).code,
        (sources.get("update/run-update.ts") as SourceViews).code,
      ].join("\n")
      const unwired = names.filter((n) => !new RegExp(`\\bio\\.${n}\\b`).test(consumers))
      expect(unwired, "an UpdateIo field nobody reads means some record is still taking a module default").toEqual([])
    },
    { timeout: 10_000 },
  )
})

// ---------------------------------------------------------------------------
// Rules 5 and 6 - the two single-site strings (spec:1208)
// ---------------------------------------------------------------------------

describe("rule 5: the destructive git reset is built in exactly one file (spec:1208)", () => {
  it(
    "only commands.ts constructs the --hard argv",
    () => {
      // NOTE ON MECHANIZATION. The spec writes this rule as "`reset --hard` in
      // exactly one file", but no source file contains that string outside a
      // comment: the port builds argv as an ARRAY, `["reset", "--hard", target]`
      // (commands.ts:83), so the two words are never adjacent in the bytes. The
      // property the rule protects is "one construction site for the command
      // that destroys a working tree", so the token that is actually asserted is
      // `--hard`.
      const found = hits(SRC_FILES, (v) => v.code, /"--hard"/)
      expect(found.map((h) => h.file), "files constructing a --hard argv").toEqual(["update/commands.ts"])
      expect(found.length, "and exactly one site inside it").toBe(1)
      // The builder is exported once and its shape is pinned, so the rule cannot
      // be satisfied by deleting the only caller.
      const commands = (sources.get("update/commands.ts") as SourceViews).code
      expect(commands).toContain('export const gitResetHardArgs')
      expect(commands).toContain('["reset", "--hard", target]')
      // Positive control on the raw bytes: the prose form the spec's grep was
      // written against really does appear, in comments, in several files.
      const prose = rawHits(SRC_FILES, /reset --hard/)
      expect(new Set(prose.map((h) => h.file)).size, "comment mentions of the bash command").toBeGreaterThanOrEqual(4)
    },
    { timeout: 10_000 },
  )
})

describe("rule 6: the ROLLED BACK marker is present, in rollback.ts, and nowhere else (spec:1208)", () => {
  it(
    "rollback.ts owns the marker other programs parse",
    () => {
      const found = hits(SRC_FILES, (v) => v.code, /ROLLED BACK to/)
      expect(found.map((h) => h.file), "files emitting the marker").toEqual(["update/rollback.ts"])
      expect(found.length).toBe(1)
      // Byte-exact against the bash oracle, which is what makes it a contract:
      // scripts/luna-update-server:1839 emits the same sentence.
      const bash = readFileSync(join(repoRoot, "scripts/luna-update-server"), "utf8").split("\n")
      const oracle = bash[1838]
      expect(oracle, "scripts/luna-update-server:1839").toContain("ROLLED BACK to")
      expect(oracle).toContain("($SERVICE_NAME healthy)")
      const at = found[0] as Hit
      const line = (raw.get("update/rollback.ts") as string).split("\n")[at.line - 1]
      expect(line, `rollback.ts:${at.line}`).toContain("ROLLED BACK to")
      expect(line, `rollback.ts:${at.line}`).toContain("(${serviceName} healthy)")
    },
    { timeout: 10_000 },
  )
})

// ---------------------------------------------------------------------------
// Rule 7 - the oracle is not edited by this PR (spec:1209)
// ---------------------------------------------------------------------------

/**
 * `git diff --stat` clean for `scripts/luna-update-server` and
 * `test/helpers/update-server-fixtures.ts`.
 *
 * These two ARE the oracle: every parity suite in this slice proves the port
 * matches them, so a diff against either turns a proof into a tautology. The
 * check has to run against the real working tree, which means one spawn - and
 * that spawn resolves `git` explicitly through `resolveHostTool`, never
 * through argv[0] or a fixture PATH.
 */
const ORACLE_PATHS: ReadonlyArray<string> = [
  "scripts/luna-update-server",
  // REPO-ROOT relative, which is where this file actually lives; the spec
  // writes it as `test/helpers/update-server-fixtures.ts` and there is no such
  // path under apps/deploy-cli.
  "test/helpers/update-server-fixtures.ts",
]

describe("rule 7: the bash oracle and its fixtures are untouched (spec:1209)", () => {
  it(
    "both oracle files exist and are tracked",
    () => {
      for (const p of ORACLE_PATHS) {
        expect(existsSync(join(repoRoot, p)), `${p} must exist for the parity suites to have an oracle`).toBe(true)
      }
    },
    { timeout: 30_000 },
  )

  it(
    "git reports no change to either, staged or unstaged",
    () => {
      const git = resolveHostTool("git")
      // A checkout without version-control metadata cannot answer the question,
      // and a silent skip here is exactly the vacuous pass this file exists to
      // avoid, so the precondition is asserted rather than branched on.
      expect(existsSync(join(repoRoot, ".git")), "this rule needs a git checkout").toBe(true)
      const r = spawnSync(git, ["diff", "--stat", "HEAD", "--", ...ORACLE_PATHS], {
        cwd: repoRoot,
        encoding: "utf8",
      })
      expect(r.error, "git must run").toBeUndefined()
      expect(r.status, `git diff exited ${r.status}: ${r.stderr}`).toBe(0)
      expect((r.stdout ?? "").trim(), "the oracle must not be edited by this PR").toBe("")
    },
    { timeout: 30_000 },
  )
})

/**
 * RULE 7: no 40-character hex literal anywhere in this app.
 *
 * WHY THIS IS A LOCAL RULE AND NOT JUST A CI ONE. The repo runs a secret-scan
 * hard gate that rejects any 40+ character hex run in a tracked file, because
 * that is the shape of a leaked token. A scanner cannot distinguish a fake git
 * sha in a fixture from a real credential, and it should not try - that is the
 * correct trade for a security gate.
 *
 * The cost is that the rule was invisible locally. It has now been rediscovered
 * three separate times, each by a different author writing perfectly reasonable
 * test fixtures, and each time the feedback arrived minutes later from CI with
 * the whole pipeline red and every later stage unrun. A constraint that is only
 * enforced remotely gets relearned by everyone who touches the code.
 *
 * The fix is to CONSTRUCT the value instead of writing it out, which keeps the
 * bytes identical and keeps the literal out of the source:
 *
 *   "1".repeat(40)                              instead of "1111...1111"
 *   ["0123456789abcdef0123", "456789abcdef01234567"].join("")
 *
 * This rule fails loudly on an empty scan set for the same reason every other
 * rule in this file does: a grep-based invariant that passes because it matched
 * nothing is not an invariant.
 */
describe("RULE 7: no 40-hex literal, which the secret-scan gate rejects", () => {
  it("finds no 40-character hex literal in any tracked file under apps/deploy-cli", () => {
    const git = resolveHostTool("git")
    const listed = spawnSync(git, ["ls-files", "apps/deploy-cli"], { cwd: repoRoot, encoding: "utf8" })
    expect(listed.error, "git must run").toBeUndefined()
    const files = (listed.stdout ?? "").split("\n").filter((f) => f.endsWith(".ts"))

    // The scan set itself is asserted: if this ever reads zero files the rule
    // is vacuous, and a vacuous rule is worse than an absent one because it
    // reports success.
    expect(files.length, "the scan set must not be empty or this rule proves nothing").toBeGreaterThan(20)

    const hex = /["'`][0-9a-fA-F]{40,}["'`]/
    const offenders = files.flatMap((f) => {
      const text = readFileSync(join(repoRoot, f), "utf8")
      return text
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => hex.test(line))
        .map(({ n, line }) => `${f}:${n}: ${line.trim().slice(0, 90)}`)
    })

    expect(
      offenders,
      "construct these instead, e.g. \"1\".repeat(40) - the secret-scan CI gate rejects a 40-hex run before any test runs",
    ).toEqual([])
  })
})
