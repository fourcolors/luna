/**
 * A SOURCE-DERIVED ORACLE for the operator lines `restart.ts` emits.
 *
 * WHY THIS EXISTS. A test that compares a hand-typed constant against another
 * hand-typed constant proves only that one person typed the same thing twice
 * (flow-lines.test.ts says exactly this about itself). The dual-drive byte diff
 * is the real proof, but it cannot run until the whole binary is assembled, and
 * three of these eleven lines fire on paths no scenario reached before. So this
 * helper reads the payload OUT OF `scripts/luna-update-server` at test time and
 * substitutes bash's own variable expansions, which makes the expectation a
 * function of the oracle rather than a transcription of it. A wording change in
 * the bash breaks every test that asserts the affected line, which is the point.
 *
 * IT ALSO KEEPS U+2014 OUT OF THIS DIRECTORY'S SOURCE. Several of these lines
 * carry an em dash because the bash does; house style bans the character in new
 * prose. Reading it out of the oracle means no test file has to contain one.
 *
 * PURE AND PORTABLE. One `readFileSync` of a repo file and string work: no
 * spawn, no temp dir, no platform assumption, nothing that depends on the
 * machine running it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { repoRoot } from "./temp-dirs.js"

/** Read once; every extraction below is a lookup into this array. */
const sourceLines = readFileSync(join(repoRoot, "scripts/luna-update-server"), "utf8").split("\n")

export interface BashLineRequest {
  /**
   * The 1-based line the spec and the port's own doc comments cite. It is
   * VERIFIED, not trusted: the line is located by `anchor` and the citation is
   * then asserted against where it actually is, so a shifted file produces
   * "the citation drifted, it is now at N" rather than a silently extracted
   * neighbouring string.
   */
  readonly line: number
  readonly fn: "luna_info" | "luna_warn"
  /**
   * A short fragment that must appear in exactly ONE `fn "..."` line in the
   * whole file. This is the only hand-typed text here, and it is a LOCATOR,
   * never the expectation: the asserted bytes are always the full payload read
   * out of the source.
   */
  readonly anchor: string
  /**
   * Bash variable name to runtime value, e.g. `{ SERVICE_NAME: "luna.service" }`.
   * Both `$NAME` and `${NAME}` spellings are substituted. Every `$` must be
   * consumed or the extraction throws, so a new interpolation added to a bash
   * line can never reach an assertion as a literal `$FOO`.
   */
  readonly vars?: Readonly<Record<string, string>>
}

/**
 * The `luna_info`/`luna_warn` PAYLOAD at a cited line, with bash's variable
 * expansions applied - i.e. exactly the bytes that follow the `-> ` or
 * `warning: ` prefix luna-deploy.sh:4-5 adds.
 *
 * THE EXTRACTION RULE, written out because a silent mis-extraction would be
 * worse than no oracle at all. Strip leading whitespace; require the line to
 * start with `<fn> "` and end with `"`; take what is between them; refuse any
 * remaining backslash, so a future edit that introduces `\"` or `\$` fails
 * loudly here instead of being mis-unescaped; substitute the caller's
 * variables, longest name first so `$READINESS_PORT` cannot be eaten by a
 * shorter key; then refuse any surviving `$`.
 */
export const bashLogLine = (req: BashLineRequest): string => {
  const prefix = `${req.fn} "`
  const matches: Array<{ readonly index: number; readonly text: string }> = []
  for (let index = 0; index < sourceLines.length; index += 1) {
    const text = (sourceLines[index] ?? "").replace(/^\s+/, "")
    if (text.startsWith(prefix) && text.includes(req.anchor)) matches.push({ index, text })
  }
  if (matches.length !== 1) {
    throw new Error(
      `bash oracle: expected exactly ONE ${req.fn} line containing ${JSON.stringify(req.anchor)} in scripts/luna-update-server, found ${matches.length} - has the wording changed?`,
    )
  }
  const [only] = matches
  if (!only) throw new Error("bash oracle: unreachable")
  const actualLine = only.index + 1
  if (actualLine !== req.line) {
    throw new Error(
      `bash oracle: the ${JSON.stringify(req.anchor)} line is cited as :${req.line} but is at :${actualLine} - update the citation in the port and in the spec.`,
    )
  }
  if (!only.text.endsWith(`"`)) {
    throw new Error(`bash oracle: :${actualLine} does not end with a closing quote; it is not a single-literal call.`)
  }
  const payload = only.text.slice(prefix.length, -1)
  if (payload.includes("\\")) {
    throw new Error(
      `bash oracle: :${actualLine} contains a backslash escape this extractor does not implement: ${JSON.stringify(payload)}`,
    )
  }
  const names = Object.keys(req.vars ?? {}).sort((a, b) => b.length - a.length)
  let out = payload
  for (const name of names) {
    const value = (req.vars ?? {})[name] ?? ""
    // split/join rather than String.replace: a replacement VALUE containing
    // `$&` or `$1` would otherwise be reinterpreted as a capture reference.
    out = out.split(`\${${name}}`).join(value).split(`$${name}`).join(value)
  }
  if (out.includes("$")) {
    throw new Error(
      `bash oracle: :${actualLine} still has an unsubstituted expansion after applying ${JSON.stringify(names)}: ${JSON.stringify(out)}`,
    )
  }
  return out
}

/** `luna_info`'s prefix (scripts/lib/luna-deploy.sh:4), for the drive-A assertions that read raw stdout. */
export const INFO_PREFIX = "-> "
/** `luna_warn`'s prefix (scripts/lib/luna-deploy.sh:5), which also puts the line on STDERR. */
export const WARN_PREFIX = "warning: "
