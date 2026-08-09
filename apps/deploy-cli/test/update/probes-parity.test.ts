/**
 * Golden parity for probes.ts (S22d PR1): every scenario runs the REAL bash
 * function out of scripts/luna-update-server - `sup_is_active`,
 * `sup_restart_count`, `_systemctl_user_flag`, `sup_reload`, `sup_stop`,
 * `sup_start` and `readiness_ok` itself - with its collaborators stubbed, runs
 * the TypeScript probes over identical inputs, and compares the two on the
 * things an operator or another program can actually observe.
 *
 * TWO ARTIFACTS ARE DIFFED, NOT ONE.
 *
 *   (1) THE ARGV, argument by argument. A probe is a command; its bytes are its
 *       contract. `--user` in the wrong position, a real newline where curl
 *       wants a literal backslash-n, a missing `-o /dev/null`, an empty string
 *       argument where bash's unquoted `$(_systemctl_user_flag)` emits nothing
 *       at all - none of those change any return value in a green-path test,
 *       and every one of them changes what runs on a live host. So the bash
 *       stubs log each argument on its own line with an `--END--` record
 *       separator, the TS runner logs the same way, and the two lists are
 *       compared element for element.
 *
 *   (2) THE CAPTURED VALUE, byte for byte, including embedded newlines. This is
 *       where the port is easiest to get subtly wrong: bash's
 *       `x="$(cmd 2>/dev/null || printf 'unknown')"` captures the FAILED
 *       command's stdout CONCATENATED with the fallback. The scenarios below
 *       drive exactly that shape on both probes, because it is not an edge
 *       case - `systemctl is-active` on a stopped unit prints `inactive` and
 *       exits 3, so the real captured value is the two-line string
 *       `inactive\nunknown`, and READINESS_DETAIL renders it verbatim.
 *
 * WHY readiness_ok IS DRIVEN WHOLE RATHER THAN THE CURLS IN ISOLATION. The two
 * curl invocations are not standalone bash functions - they live inline inside
 * `readiness_ok` (scripts/luna-update-server:1084-1091), and extracting a
 * fragment of a function would be diffing a transcription rather than the
 * oracle. Running the whole gate through a logging `run_target_capture` gets
 * both curls' argv, both fallbacks, and the resulting READINESS_DETAIL out of
 * the REAL bash in one pass - and asserts, in situ, that probes.ts's four
 * capture probes drop into readiness.ts's seams without changing the gate's
 * verdict or its diagnosis.
 *
 * NO STDOUT IS SMUGGLED THROUGH A DOUBLE-QUOTED SHELL STRING. Every stubbed
 * answer is written to a FILE from Node and `cat`ed by the stub. Interpolating
 * it as a bash string would make `\n` a literal backslash-n (the trap
 * readiness-parity.test.ts documents), which is precisely the byte this suite
 * exists to tell apart from a real newline.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  healthzArgv,
  makeMonotonicSeconds,
  makeReadinessProbes,
  makeRunSystemctl,
  probeHealthzSync,
  probeReadyzSync,
  readinessResultOk,
  readyzArgv,
  restartOutcomeRc,
  sleepSecondsSync,
  supIsActiveSync,
  supRestartCountSync,
  systemctlArgv,
  type CaptureResult,
  type RunTargetCapture,
} from "../../src/update/probes.js"
import { readinessOkSync } from "../../src/update/readiness.js"
import { cleanupTempDirs, makeTempDir, repoRoot } from "./temp-dirs.js"

afterAll(cleanupTempDirs)

const UPDATE_SERVER = join(repoRoot, "scripts/luna-update-server")

const SERVICE = "luna-chat-server.service"
const PORT = 4753
const CURL_MAX_TIME = "5"

const scratch = (): string => makeTempDir("deploy-cli-probes-parity-")

/**
 * `eval "$(awk ...)"` for one bash function, the same extraction
 * readiness-parity.test.ts and test/engine-pin.test.ts use. The terminator is a
 * `}` in COLUMN ONE, which is why a nested `    }` inside `sup_stop`'s
 * `|| { ... }` block does not truncate it.
 */
const evalFn = (name: string): string =>
  `eval "$(awk '/^${name}\\(\\)/{f=1} f{print} f && /^}$/{exit}' ${JSON.stringify(UPDATE_SERVER)})"`

/** The argv-logging preamble every bash stub shares: one argument per line, `--END--` between invocations. */
const LOG_ARGV = `log_argv() { { for a in "$@"; do printf '%s\\n' "$a"; done; printf -- '--END--\\n'; } >> "$ARGV_LOG"; }`

const runBash = (lines: ReadonlyArray<string>): { readonly stdout: string; readonly stderr: string; readonly status: number | null } => {
  const r = spawnSync("bash", ["-c", lines.join("\n")], { encoding: "utf8" })
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status }
}

/** Split an argv log file back into one string[] per invocation. */
const readArgvLog = (path: string): ReadonlyArray<ReadonlyArray<string>> => {
  const raw = readFileSync(path, "utf8")
  return raw
    .split("--END--\n")
    .filter((chunk) => chunk !== "")
    .map((chunk) => chunk.replace(/\n$/, "").split("\n"))
}

/** A TS `RunTargetCapture` that records argv the same way the bash stubs do. */
const recordingRunner = (
  answer: (argv: ReadonlyArray<string>) => CaptureResult,
): { readonly run: RunTargetCapture; readonly argv: Array<ReadonlyArray<string>> } => {
  const argv: Array<ReadonlyArray<string>> = []
  return {
    argv,
    run: (a) => {
      argv.push([...a])
      return answer(a)
    },
  }
}

// --- sup_is_active / sup_restart_count ---------------------------------------

interface CaptureScenario {
  readonly systemdUser: boolean
  /** Exactly what the stubbed `run_target_capture` writes to stdout, bytes included. */
  readonly stdout: string
  /** Its exit status; anything non-zero takes bash's `|| printf '<fallback>'` arm. */
  readonly rc: number
}

/** Drive the REAL `sup_is_active` / `sup_restart_count` and report what its CALLER captures (`"$(sup_is_active)"`, scripts/luna-update-server:1075) plus the argv it emitted. */
const runBashCaptureProbe = (
  fn: "sup_is_active" | "sup_restart_count",
  s: CaptureScenario,
): { readonly value: string; readonly argv: ReadonlyArray<ReadonlyArray<string>> } => {
  const dir = scratch()
  const outFile = join(dir, "stdout")
  const argvLog = join(dir, "argv.log")
  writeFileSync(outFile, s.stdout)
  writeFileSync(argvLog, "")
  const r = runBash([
    "set -uo pipefail",
    `ARGV_LOG=${JSON.stringify(argvLog)}`,
    LOG_ARGV,
    'SUPERVISOR="systemd"',
    `SYSTEMD_USER=${s.systemdUser}`,
    `SERVICE_NAME=${JSON.stringify(SERVICE)}`,
    `run_target_capture() { log_argv "$@"; cat ${JSON.stringify(outFile)}; return ${s.rc}; }`,
    evalFn("_systemctl_user_flag"),
    evalFn(fn),
    `value="$(${fn})"`,
    'printf "%s" "$value"',
  ])
  expect(r.status, `bash oracle for ${fn} failed: ${r.stderr}`).toBe(0)
  return { value: r.stdout, argv: readArgvLog(argvLog) }
}

const runTsCaptureProbe = (
  fn: "sup_is_active" | "sup_restart_count",
  s: CaptureScenario,
): { readonly value: string; readonly argv: ReadonlyArray<ReadonlyArray<string>> } => {
  const { run, argv } = recordingRunner(() => ({ status: s.rc, stdout: s.stdout }))
  const options = { serviceName: SERVICE, systemdUser: s.systemdUser, runTargetCapture: run }
  const value = fn === "sup_is_active" ? supIsActiveSync(options) : supRestartCountSync(options)
  return { value, argv }
}

const captureParity = (
  fn: "sup_is_active" | "sup_restart_count",
  name: string,
  s: CaptureScenario,
  expected: { readonly value: string; readonly argv: ReadonlyArray<string> },
) => {
  it(name, () => {
    const bash = runBashCaptureProbe(fn, s)
    const ts = runTsCaptureProbe(fn, s)
    expect(ts.value).toBe(bash.value)
    expect(ts.argv).toEqual(bash.argv)
    // Pinned literals so a shared drift in BOTH implementations still fails.
    expect(bash.value).toBe(expected.value)
    expect(bash.argv).toEqual([expected.argv])
  })
}

describe("probes: sup_is_active golden parity", () => {
  const IS_ACTIVE = ["is-active", SERVICE]

  captureParity(
    "sup_is_active",
    "a running unit captures 'active', with the trailing newline stripped by the caller's $()",
    { systemdUser: false, stdout: "active\n", rc: 0 },
    { value: "active", argv: ["systemctl", ...IS_ACTIVE] },
  )

  // THE ONE THIS SUITE EXISTS FOR (first of two). systemctl is-active on a
  // stopped unit PRINTS "inactive" and EXITS 3, so bash's
  // `... || printf 'unknown'` concatenates rather than replaces. A port that
  // returned a bare "unknown" agrees on the verdict and lies in
  // READINESS_DETAIL, which is the whole diagnosis a rolled-back deploy leaves.
  captureParity(
    "sup_is_active",
    "a stopped unit captures the state AND the fallback, not the fallback alone",
    { systemdUser: false, stdout: "inactive\n", rc: 3 },
    { value: "inactive\nunknown", argv: ["systemctl", ...IS_ACTIVE] },
  )

  captureParity(
    "sup_is_active",
    "a transport failure with no output captures the bare fallback",
    { systemdUser: false, stdout: "", rc: 1 },
    { value: "unknown", argv: ["systemctl", ...IS_ACTIVE] },
  )

  captureParity(
    "sup_is_active",
    "--user is inserted between systemctl and the subcommand",
    { systemdUser: true, stdout: "active\n", rc: 0 },
    { value: "active", argv: ["systemctl", "--user", ...IS_ACTIVE] },
  )

  // stripTrailingNewlines is documented (see its own doc, session-guard.ts) to
  // strip ALL trailing newlines, the way `$()` does - never just the last one.
  // A single systemctl line never carries more than one, so this needs its
  // own scenario: multiple trailing newlines, on the SUCCESS arm so no
  // fallback concatenation masks a partial strip.
  captureParity(
    "sup_is_active",
    "every trailing newline is stripped, not just the last one, matching $()",
    { systemdUser: false, stdout: "active\n\n\n", rc: 0 },
    { value: "active", argv: ["systemctl", ...IS_ACTIVE] },
  )
})

describe("probes: sup_restart_count golden parity", () => {
  const NRESTARTS = ["show", SERVICE, "--property=NRestarts", "--value"]

  captureParity(
    "sup_restart_count",
    "a numeric count passes through as written",
    { systemdUser: false, stdout: "4\n", rc: 0 },
    { value: "4", argv: ["systemctl", ...NRESTARTS] },
  )

  captureParity(
    "sup_restart_count",
    "a non-numeric answer normalises to 0",
    { systemdUser: false, stdout: "[not-set]\n", rc: 0 },
    { value: "0", argv: ["systemctl", ...NRESTARTS] },
  )

  // `[[ "$n" =~ ^[0-9]+$ ]]` requires ONE OR MORE digits; a successful
  // (rc=0, so no fallback concatenation) but EMPTY property read - a unit
  // type without restart accounting, or a freshly-loaded unit - must also
  // fail that guard and collapse to 0, exactly like the non-numeric case
  // above. An unanchored-at-`+`-vs-`*` regression would let "" through
  // unchanged instead.
  captureParity(
    "sup_restart_count",
    "a successful but empty answer normalises to 0, not left blank",
    { systemdUser: false, stdout: "", rc: 0 },
    { value: "0", argv: ["systemctl", ...NRESTARTS] },
  )

  captureParity(
    "sup_restart_count",
    "a transport failure with no output normalises to 0",
    { systemdUser: false, stdout: "", rc: 1 },
    { value: "0", argv: ["systemctl", ...NRESTARTS] },
  )

  // THE ONE THIS SUITE EXISTS FOR (second of two), and the one with teeth: a
  // count printed alongside a NON-ZERO exit concatenates to "4\n0", which is
  // not a bare run of digits, so the regex guard collapses it to "0" and the
  // crash-loop check is disabled rather than mis-fired. A port that returned
  // "4" would report a healthy unit as crash-looping against baseline 0 - a
  // needless auto-rollback, with a different READINESS_DETAIL to explain it.
  captureParity(
    "sup_restart_count",
    "a count printed alongside a failure concatenates, fails the digit guard, and collapses to 0",
    { systemdUser: false, stdout: "4\n", rc: 1 },
    { value: "0", argv: ["systemctl", ...NRESTARTS] },
  )

  captureParity(
    "sup_restart_count",
    "--user is inserted between systemctl and the subcommand",
    { systemdUser: true, stdout: "2\n", rc: 0 },
    { value: "2", argv: ["systemctl", "--user", ...NRESTARTS] },
  )
})

// --- the two curls, driven in situ through the real readiness_ok -------------

interface GateScenario {
  readonly systemdUser: boolean
  readonly isActive: { readonly stdout: string; readonly rc: number }
  readonly nrestarts: { readonly stdout: string; readonly rc: number }
  readonly healthz: { readonly stdout: string; readonly rc: number }
  readonly readyz: { readonly stdout: string; readonly rc: number }
}

const gateBase: GateScenario = {
  systemdUser: false,
  isActive: { stdout: "active\n", rc: 0 },
  nrestarts: { stdout: "0\n", rc: 0 },
  healthz: { stdout: "200", rc: 0 },
  readyz: { stdout: '{"mode":"normal"}\n200', rc: 0 },
}

interface GateTrace {
  readonly rc: number
  readonly detail: string
  readonly argv: ReadonlyArray<ReadonlyArray<string>>
}

/**
 * The REAL `readiness_ok` with the REAL `sup_is_active`/`sup_restart_count`
 * beneath it and one logging `run_target_capture` beneath those. Timeout and
 * interval are both 1 so the loop makes exactly ONE attempt, matching the fake
 * clock the TS side is given (the same pinning readiness-parity.test.ts uses,
 * and the reason a failing scenario costs one real second rather than a minute).
 */
const runBashGate = (s: GateScenario): GateTrace => {
  const dir = scratch()
  const argvLog = join(dir, "argv.log")
  writeFileSync(argvLog, "")
  const answers = join(dir, "answers")
  mkdirSync(answers, { recursive: true })
  for (const [kind, a] of [
    ["isactive", s.isActive], ["nrestarts", s.nrestarts], ["healthz", s.healthz], ["readyz", s.readyz],
  ] as const) {
    writeFileSync(join(answers, `${kind}.out`), a.stdout)
    writeFileSync(join(answers, `${kind}.rc`), String(a.rc))
  }
  const r = runBash([
    "set -uo pipefail",
    `ARGV_LOG=${JSON.stringify(argvLog)}`,
    `ANSWERS=${JSON.stringify(answers)}`,
    LOG_ARGV,
    'answer() { cat "$ANSWERS/$1.out"; return "$(cat "$ANSWERS/$1.rc")"; }',
    `run_target_capture() {
       log_argv "$@"
       case "$*" in
         *is-active*)  answer isactive ;;
         *NRestarts*)  answer nrestarts ;;
         */healthz*)   answer healthz ;;
         */readyz*)    answer readyz ;;
         *) printf 'unroutable stub argv: %s\\n' "$*" >&2; return 1 ;;
       esac
     }`,
    'SUPERVISOR="systemd"',
    `SYSTEMD_USER=${s.systemdUser}`,
    `SERVICE_NAME=${JSON.stringify(SERVICE)}`,
    `READINESS_PORT=${PORT}`,
    "READINESS_TIMEOUT=1",
    "READINESS_INTERVAL=1",
    `READINESS_CURL_MAX_TIME=${JSON.stringify(CURL_MAX_TIME)}`,
    'EXPECTED_BUILD_SHA=""',
    "ALLOW_MISSING_BUILD_SHA=false",
    'READINESS_DETAIL=""',
    "luna_warn() { :; }",
    evalFn("_systemctl_user_flag"),
    evalFn("sup_is_active"),
    evalFn("sup_restart_count"),
    evalFn("readiness_ok"),
    "readiness_ok 0; rc=$?",
    'printf "%s\\n%s" "$rc" "$READINESS_DETAIL"',
  ])
  const nl = r.stdout.indexOf("\n")
  return { rc: Number(r.stdout.slice(0, nl)), detail: r.stdout.slice(nl + 1), argv: readArgvLog(argvLog) }
}

/**
 * The same gate driven by readiness.ts over probes.ts's four capture probes.
 *
 * `now`/`sleep` from makeReadinessProbes are OVERRIDDEN here with the fake
 * clock, exactly as readiness-parity.test.ts does, so both drives make the same
 * number of attempts without paying wall-clock time; the two real
 * implementations get their own golden scenarios further down. The other four
 * seams are the production ones, unmodified - which is what makes this an
 * in-situ proof rather than a re-statement of the module's unit tests.
 */
const runTsGate = (s: GateScenario): GateTrace => {
  const byKind = (argv: ReadonlyArray<string>): { readonly stdout: string; readonly rc: number } => {
    const joined = argv.join(" ")
    if (joined.includes("is-active")) return s.isActive
    if (joined.includes("NRestarts")) return s.nrestarts
    if (joined.includes("/healthz")) return s.healthz
    if (joined.includes("/readyz")) return s.readyz
    throw new Error(`unroutable stub argv: ${joined}`)
  }
  const { run, argv } = recordingRunner((a) => {
    const answer = byKind(a)
    return { status: answer.rc, stdout: answer.stdout }
  })
  let clock = 0
  const probes = makeReadinessProbes({
    serviceName: SERVICE,
    systemdUser: s.systemdUser,
    readinessPort: PORT,
    curlMaxTime: CURL_MAX_TIME,
    runTargetCapture: run,
  })
  const result = readinessOkSync({
    ...probes,
    serviceName: SERVICE,
    readinessPort: PORT,
    timeoutSecs: 1,
    intervalSecs: 1,
    expectedBuildSha: "",
    allowMissingBuildSha: false,
    baseline: 0,
    now: () => clock,
    sleep: (secs) => { clock += secs },
  })
  return { rc: result.ready ? 0 : 1, detail: result.detail, argv }
}

const gateParity = (name: string, s: GateScenario, expected: { readonly rc: number; readonly argv?: ReadonlyArray<ReadonlyArray<string>>; readonly detail?: string }) => {
  it(name, () => {
    const bash = runBashGate(s)
    const ts = runTsGate(s)
    expect(bash.rc, `bash rc (detail: ${bash.detail})`).toBe(expected.rc)
    expect(ts.rc, `port rc (detail: ${ts.detail})`).toBe(expected.rc)
    expect(ts.detail).toBe(bash.detail)
    expect(ts.argv).toEqual(bash.argv)
    if (expected.argv) expect(bash.argv).toEqual(expected.argv)
    if (expected.detail !== undefined) expect(bash.detail).toBe(expected.detail)
  })
}

describe("probes: the two readiness curls, in situ against the real readiness_ok", () => {
  gateParity("the happy path emits all four probes with byte-identical argv", gateBase, {
    rc: 0,
    argv: [
      ["systemctl", "is-active", SERVICE],
      ["systemctl", "show", SERVICE, "--property=NRestarts", "--value"],
      // -f + -o /dev/null: the gate wants only the status line.
      ["curl", "-fsS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", CURL_MAX_TIME, `http://127.0.0.1:${PORT}/healthz`],
      // No -f (the BODY is the payload), and a LITERAL backslash-n that curl -
      // not bash - expands. `\\n` in this TS source is those two characters.
      ["curl", "-sS", "-w", "\\n%{http_code}", "--max-time", CURL_MAX_TIME, `http://127.0.0.1:${PORT}/readyz`],
    ],
  })

  gateParity("--user reaches both systemctl probes and neither curl", { ...gateBase, systemdUser: true }, {
    rc: 0,
    argv: [
      ["systemctl", "--user", "is-active", SERVICE],
      ["systemctl", "--user", "show", SERVICE, "--property=NRestarts", "--value"],
      ["curl", "-fsS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", CURL_MAX_TIME, `http://127.0.0.1:${PORT}/healthz`],
      ["curl", "-sS", "-w", "\\n%{http_code}", "--max-time", CURL_MAX_TIME, `http://127.0.0.1:${PORT}/readyz`],
    ],
  })

  // The concatenating fallback, observed where it is actually read: the state
  // systemctl printed AND the literal `unknown`, rendered verbatim into the
  // detail an operator reads off a rolled-back deploy.
  gateParity(
    "a stopped unit's concatenated state reaches READINESS_DETAIL verbatim",
    { ...gateBase, isActive: { stdout: "inactive\n", rc: 3 } },
    { rc: 1, detail: `${SERVICE} is not active (state=inactive\nunknown)` },
  )

  // The count-plus-failure case with teeth: "4\n0" fails the digit guard and
  // collapses to 0, so the gate proceeds to /healthz. A port that read "4"
  // would stop one rung earlier with a crash-looping diagnosis.
  gateParity(
    "a failing NRestarts read does not fabricate a crash loop",
    { ...gateBase, nrestarts: { stdout: "4\n", rc: 1 }, healthz: { stdout: "503", rc: 0 } },
    { rc: 1, detail: `/healthz did not return 200 on :${PORT}` },
  )

  // The `\n000` fallback: the body is lost, the code is recoverable, and the
  // gate reports http=000 rather than accepting a corpse as a legacy 404.
  gateParity(
    "a /readyz transport failure falls back to newline + 000",
    { ...gateBase, readyz: { stdout: "", rc: 7 } },
    { rc: 1, detail: '/readyz did not report "mode":"normal" (still booting or in setup-mode; http=000)' },
  )

  gateParity(
    "a /healthz transport failure falls back to 000",
    { ...gateBase, healthz: { stdout: "", rc: 7 } },
    { rc: 1, detail: `/healthz did not return 200 on :${PORT}` },
  )
})

describe("probes: the curl probes read standalone", () => {
  // Same fallbacks, asserted directly on the two exported probes so a caller
  // outside readiness.ts (the rollback path builds its own probe set) is
  // covered by name and not only by the gate above.
  it("probeHealthzSync returns the bare code and falls back to 000", () => {
    const opts = { readinessPort: PORT, curlMaxTime: CURL_MAX_TIME }
    expect(probeHealthzSync({ ...opts, runTargetCapture: () => ({ status: 0, stdout: "200" }) })).toBe("200")
    expect(probeHealthzSync({ ...opts, runTargetCapture: () => ({ status: 7, stdout: "" }) })).toBe("000")
    expect(probeHealthzSync({ ...opts, runTargetCapture: () => ({ status: null, stdout: "" }) })).toBe("000")
  })

  it("probeReadyzSync keeps the body/code split and falls back to a REAL newline + 000", () => {
    const opts = { readinessPort: PORT, curlMaxTime: CURL_MAX_TIME }
    expect(probeReadyzSync({ ...opts, runTargetCapture: () => ({ status: 0, stdout: '{"mode":"normal"}\n200' }) }))
      .toBe('{"mode":"normal"}\n200')
    const failed = probeReadyzSync({ ...opts, runTargetCapture: () => ({ status: 7, stdout: "" }) })
    expect(failed).toBe("\n000")
    // The property readiness.ts:160 depends on: the code is the segment after
    // the LAST newline, so a transport failure parses as 000 and never as "".
    expect(failed.slice(failed.lastIndexOf("\n") + 1)).toBe("000")
  })

  it("the curl argv builders carry a LITERAL backslash-n, never a real newline", () => {
    expect(readyzArgv(PORT, CURL_MAX_TIME)).toContain("\\n%{http_code}")
    expect(readyzArgv(PORT, CURL_MAX_TIME).join("")).not.toContain("\n")
    expect(healthzArgv(PORT, CURL_MAX_TIME)).toContain("%{http_code}")
    // The max-time value is carried as a string precisely so an operator's own
    // spelling survives into the argv rather than being renormalised.
    expect(healthzArgv(PORT, "5.0")).toContain("5.0")
  })
})

// --- the systemctl transport restart.ts drives -------------------------------

/**
 * `sup_reload` / `sup_stop` / `sup_start` (scripts/luna-update-server:
 * 1308-1381) are the bash oracle for makeRunSystemctl's argv. Their bodies are
 * evaluated for real with `run_target` / `run_target_capture` logging; the rc
 * table below drives sup_start's start-limit-latched recovery, which is the
 * only one of the three that emits more than a single command.
 */
const runBashSupervisorArgv = (
  fn: "sup_reload" | "sup_stop" | "sup_start",
  opts: { readonly systemdUser: boolean; readonly firstStartRc?: number; readonly isFailedRc?: number },
): ReadonlyArray<ReadonlyArray<string>> => {
  const dir = scratch()
  const argvLog = join(dir, "argv.log")
  writeFileSync(argvLog, "")
  const startedMark = join(dir, "start.attempted")
  const r = runBash([
    "set -uo pipefail",
    `ARGV_LOG=${JSON.stringify(argvLog)}`,
    LOG_ARGV,
    'SUPERVISOR="systemd"',
    "DRY_RUN=false",
    `SYSTEMD_USER=${opts.systemdUser}`,
    `SERVICE_NAME=${JSON.stringify(SERVICE)}`,
    "luna_warn() { :; }",
    // The first `start` answers firstStartRc; every later one succeeds, which
    // is what makes the latch recovery observable as a four-command sequence.
    `run_target() {
       log_argv "$@"
       case "$*" in
         *" start "*)
           if [[ -f ${JSON.stringify(startedMark)} ]]; then return 0; fi
           : > ${JSON.stringify(startedMark)}
           return ${opts.firstStartRc ?? 0} ;;
         *) return 0 ;;
       esac
     }`,
    `run_target_capture() { log_argv "$@"; return ${opts.isFailedRc ?? 0}; }`,
    evalFn("_systemctl_user_flag"),
    evalFn(fn),
    `${fn} >/dev/null 2>&1 || true`,
  ])
  expect(r.status, `bash oracle for ${fn} failed: ${r.stderr}`).toBe(0)
  return readArgvLog(argvLog)
}

/** The same steps as makeRunSystemctl sees them: restart.ts calls it with the SUBCOMMAND only (restart.ts:183-196), and this module supplies `systemctl` and `--user`. */
const runTsSystemctlArgv = (
  systemdUser: boolean,
  steps: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const { run, argv } = recordingRunner(() => ({ status: 0, stdout: "" }))
  const runSystemctl = makeRunSystemctl({ systemdUser, runTargetCapture: run })
  for (const step of steps) runSystemctl(step)
  return argv
}

describe("probes: makeRunSystemctl argv parity with sup_reload/sup_stop/sup_start", () => {
  for (const systemdUser of [false, true]) {
    const scope = systemdUser ? "--user scope" : "system scope"

    it(`sup_reload -> daemon-reload (${scope})`, () => {
      const bash = runBashSupervisorArgv("sup_reload", { systemdUser })
      expect(runTsSystemctlArgv(systemdUser, [["daemon-reload"]])).toEqual(bash)
      expect(bash).toEqual([systemctlArgv(systemdUser, ["daemon-reload"])])
    })

    it(`sup_stop -> stop <unit> (${scope})`, () => {
      const bash = runBashSupervisorArgv("sup_stop", { systemdUser })
      expect(runTsSystemctlArgv(systemdUser, [["stop", SERVICE]])).toEqual(bash)
      expect(bash).toEqual([systemctlArgv(systemdUser, ["stop", SERVICE])])
    })

    it(`sup_start -> start <unit> when the unit starts (${scope})`, () => {
      const bash = runBashSupervisorArgv("sup_start", { systemdUser, firstStartRc: 0 })
      expect(runTsSystemctlArgv(systemdUser, [["start", SERVICE]])).toEqual(bash)
      expect(bash).toEqual([systemctlArgv(systemdUser, ["start", SERVICE])])
    })

    // The start-limit-latched recovery (scripts/luna-update-server:1371-1381),
    // which restart.ts reproduces step for step at restart.ts:193-197.
    // reset-failed must never precede a start that would have succeeded on its
    // own, and this ordering is the only artifact that proves it did not.
    it(`sup_start -> start, is-failed, reset-failed, start when the unit is latched (${scope})`, () => {
      const bash = runBashSupervisorArgv("sup_start", { systemdUser, firstStartRc: 1, isFailedRc: 0 })
      const steps = [["start", SERVICE], ["is-failed", SERVICE], ["reset-failed", SERVICE], ["start", SERVICE]]
      expect(runTsSystemctlArgv(systemdUser, steps)).toEqual(bash)
      expect(bash).toEqual(steps.map((s) => systemctlArgv(systemdUser, s)))
    })

    // A unit that is NOT latched gets exactly one start and one is-failed, and
    // the recovery stops there (`|| return 1`).
    it(`sup_start stops after is-failed when the unit is not latched (${scope})`, () => {
      const bash = runBashSupervisorArgv("sup_start", { systemdUser, firstStartRc: 1, isFailedRc: 1 })
      const steps = [["start", SERVICE], ["is-failed", SERVICE]]
      expect(runTsSystemctlArgv(systemdUser, steps)).toEqual(bash)
      expect(bash).toEqual(steps.map((s) => systemctlArgv(systemdUser, s)))
    })
  }

  it("makeRunSystemctl passes the capture's status and stdout through unchanged", () => {
    const runSystemctl = makeRunSystemctl({
      systemdUser: false,
      runTargetCapture: () => ({ status: 4, stdout: "inactive\n" }),
    })
    // restart.ts's guard fallback reads .stdout off this and strips it itself
    // (restart.ts:175), so the probe must not strip or trim on its behalf.
    expect(runSystemctl(["is-active", SERVICE])).toEqual({ status: 4, stdout: "inactive\n" })
  })

  // The test above injects `status: 4` - a value `?? 0` is a no-op on, so it
  // cannot see a coalesced default. Only a null status exercises that branch,
  // and a stubbed `status: null` would prove no more than the test above does:
  // it is still a canned value, never a status the port actually produced. So
  // this drives a REAL child process, killed by a REAL signal via spawnSync's
  // own `timeout` option - the same mechanism an OOM-killer or an operator's
  // Ctrl-C uses on a live `systemctl` - so `r.status` here is null because the
  // OS says so, not because a test double was told to say so.
  it("makeRunSystemctl passes through a genuine null status from a real signal-killed process, not coerced to success", () => {
    const realCapture: RunTargetCapture = () => {
      const r = spawnSync("sleep", ["5"], { timeout: 50 })
      return { status: r.status, stdout: r.stdout ? r.stdout.toString() : "" }
    }
    const runSystemctl = makeRunSystemctl({ systemdUser: false, runTargetCapture: realCapture })
    const result = runSystemctl(["stop", SERVICE])
    // restart.ts:181 takes this `.status` as the step's rc. A signal-killed
    // systemctl must stay null (failure) here - `?? 0` would read it as
    // success and let a rolled-back transaction proceed to the readiness gate
    // on a service that was never actually restarted.
    expect(result.status).toBeNull()
  })
})

describe("probes: _systemctl_user_flag", () => {
  it("emits --user only in the user scope, and emits NO argument otherwise", () => {
    const flagOf = (systemdUser: boolean): string => {
      const r = runBash([
        "set -uo pipefail",
        `SYSTEMD_USER=${systemdUser}`,
        evalFn("_systemctl_user_flag"),
        // The call site is an UNQUOTED substitution, so an empty flag is
        // removed by word splitting rather than passed as "".
        'set -- systemctl $(_systemctl_user_flag) is-active unit',
        'printf "%s\\n" "$#"',
      ])
      expect(r.status, r.stderr).toBe(0)
      return r.stdout.trim()
    }
    expect(flagOf(false)).toBe("3")
    expect(systemctlArgv(false, ["is-active", "unit"])).toHaveLength(3)
    expect(flagOf(true)).toBe("4")
    expect(systemctlArgv(true, ["is-active", "unit"])).toEqual(["systemctl", "--user", "is-active", "unit"])
  })
})

// --- the clock and the sleep -------------------------------------------------

describe("probes: makeMonotonicSeconds vs bash SECONDS", () => {
  it("starts at 0 and returns whole seconds, as SECONDS does at shell start", () => {
    const now = makeMonotonicSeconds()
    expect(now()).toBe(0)
    expect(Number.isInteger(now())).toBe(true)
  })

  it("truncates a 1.05s wait to a whole second, as bash's SECONDS does", () => {
    expect(runBash(['printf "%s" "$SECONDS"']).stdout).toBe("0")

    // One real second on each side, spent the same way. The assertion is the
    // TRUNCATION, not the elapsed time: a float clock would read 1.06 here and
    // drift readiness_ok's attempt count away from bash's integer arithmetic.
    // Deliberately NOT an equality between the two numbers - a preempted
    // runner could spend 2.1s on either side, and a flaky clock test would get
    // deleted rather than believed. What must hold on any machine is that
    // BOTH advanced past 1 and NEITHER carries a fraction.
    const now = makeMonotonicSeconds()
    spawnSync("sleep", ["1.05"])
    const tsElapsed = now()
    const bashElapsed = Number(runBash(["sleep 1.05", 'printf "%s" "$SECONDS"']).stdout)

    expect(Number.isInteger(tsElapsed)).toBe(true)
    expect(Number.isInteger(bashElapsed)).toBe(true)
    expect(tsElapsed).toBeGreaterThanOrEqual(1)
    expect(bashElapsed).toBeGreaterThanOrEqual(1)
  })

  it("is monotonic", () => {
    const now = makeMonotonicSeconds()
    let previous = now()
    for (let i = 0; i < 50; i += 1) {
      const current = now()
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
  })

  // Deterministic version of the truncation claim above: the wall-clock test
  // only proves "past 1 second", which a rounding implementation also
  // satisfies. Stubbing process.hrtime.bigint puts the elapsed time exactly
  // past the rounding boundary (1.6s) with no real sleep and no scheduler
  // slack to explain away a wrong answer: bash's SECONDS is integer division,
  // which floors, so 1.6 elapsed seconds reads as 1, never 2.
  it("floors 1.6 elapsed seconds to 1, the way bigint division truncates and Math.round would not", () => {
    const realBigint = process.hrtime.bigint
    let ns = 0n
    process.hrtime.bigint = () => ns
    try {
      const now = makeMonotonicSeconds()
      ns = 1_600_000_000n
      expect(now()).toBe(1)
    } finally {
      process.hrtime.bigint = realBigint
    }
  })
})

describe("probes: sleepSecondsSync argv parity with bash's sleep", () => {
  /** A `sleep` on PATH that records its argv instead of waiting. */
  const stubSleepBin = (): { readonly bin: string; readonly log: string } => {
    const dir = scratch()
    const bin = join(dir, "bin")
    mkdirSync(bin, { recursive: true })
    const log = join(dir, "sleep.log")
    writeFileSync(log, "")
    writeFileSync(join(bin, "sleep"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nexit 0\n`)
    spawnSync("chmod", ["+x", join(bin, "sleep")])
    return { bin, log }
  }

  const readLog = (log: string): ReadonlyArray<string> =>
    (spawnSync("cat", [log], { encoding: "utf8" }).stdout ?? "").split("\n").filter((l) => l !== "")

  for (const interval of ["2", "0.3"]) {
    it(`spawns \`sleep ${interval}\`, exactly as readiness_ok's own sleep does`, () => {
      const bashRig = stubSleepBin()
      const bashRun = runBash([
        "set -uo pipefail",
        `PATH=${JSON.stringify(bashRig.bin)}:$PATH`,
        `READINESS_INTERVAL=${interval}`,
        // The bare `sleep "$READINESS_INTERVAL"` from scripts/luna-update-
        // server:1124 - never routed through run_target, so under incus the
        // poll interval is spent on the host.
        'sleep "$READINESS_INTERVAL"',
      ])
      expect(bashRun.status, bashRun.stderr).toBe(0)

      const tsRig = stubSleepBin()
      const savedPath = process.env.PATH
      try {
        // spawnSync resolves the binary against process.env at CALL time, so
        // overriding PATH here is enough - no re-import, and the override is
        // restored on every exit path so a parallel suite cannot inherit it.
        process.env.PATH = `${tsRig.bin}:${savedPath ?? ""}`
        sleepSecondsSync(Number(interval))
      } finally {
        if (savedPath === undefined) delete process.env.PATH
        else process.env.PATH = savedPath
      }

      expect(readLog(tsRig.log)).toEqual(readLog(bashRig.log))
      expect(readLog(bashRig.log)).toEqual([interval])
    })
  }
})

describe("probes: makeReadinessProbes wires the real poll-interval sleep", () => {
  // makeReadinessProbes is the one place readiness.ts's `sleep` seam gets its
  // implementation. A stub that returns a no-op function type-checks and lets
  // every other test in this file pass, because they all override `sleep`
  // themselves before calling readinessOkSync - so the wiring can only be
  // caught here, by proving the returned function still has the real side
  // effect: it spawns the `sleep` binary with the interval argv, exactly as
  // sleepSecondsSync's own parity test above proves in isolation.
  it("probes.sleep(n) spawns the real `sleep n`, not a no-op", () => {
    const dir = scratch()
    const bin = join(dir, "bin")
    mkdirSync(bin, { recursive: true })
    const log = join(dir, "sleep.log")
    writeFileSync(log, "")
    writeFileSync(join(bin, "sleep"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nexit 0\n`)
    spawnSync("chmod", ["+x", join(bin, "sleep")])

    const { run } = recordingRunner(() => ({ status: 0, stdout: "" }))
    const probes = makeReadinessProbes({
      serviceName: SERVICE,
      systemdUser: false,
      readinessPort: PORT,
      curlMaxTime: CURL_MAX_TIME,
      runTargetCapture: run,
    })

    const savedPath = process.env.PATH
    try {
      process.env.PATH = `${bin}:${savedPath ?? ""}`
      probes.sleep(2)
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
    }

    const logged = readFileSync(log, "utf8").split("\n").filter((l) => l !== "")
    expect(logged).toEqual(["2"])
  })
})

describe("probes: makeReadinessProbes wires one anchored clock, not a fresh one per call", () => {
  // Every gate test in this file overrides BOTH now and sleep before calling
  // readinessOkSync, so a `now` that re-anchors on every call (rather than
  // anchoring once, at makeReadinessProbes construction time, the way
  // makeMonotonicSeconds is documented to) can hide behind those stubs
  // forever. readiness.ts computes `deadline = now() + timeoutSecs` once and
  // then loops `while (now() < deadline)` - a re-anchored clock reads 0 at
  // every call, so the deadline is never reached and the gate spins forever
  // instead of giving up. Stubbing hrtime directly proves the SAME clock
  // instance is threaded through, independent of wall-clock timing.
  it("probes.now() advances across calls instead of re-anchoring to 0 each time", () => {
    const realBigint = process.hrtime.bigint
    let ns = 0n
    process.hrtime.bigint = () => ns
    try {
      const { run } = recordingRunner(() => ({ status: 0, stdout: "" }))
      const probes = makeReadinessProbes({
        serviceName: SERVICE,
        systemdUser: false,
        readinessPort: PORT,
        curlMaxTime: CURL_MAX_TIME,
        runTargetCapture: run,
      })

      expect(probes.now()).toBe(0)
      ns = 2_000_000_000n // 2 seconds after the probes were constructed
      expect(probes.now()).toBe(2)
    } finally {
      process.hrtime.bigint = realBigint
    }
  })
})

// --- the two wiring-layer adapters -------------------------------------------

describe("probes: the rollback.ts adapters narrow without weakening the primitives", () => {
  it("restartOutcomeRc yields the rc rollback.ts's restartService seam takes", () => {
    expect(restartOutcomeRc({ code: 0, settle: { kind: "skipped-zero" } })).toBe(0)
    expect(restartOutcomeRc({ code: 1, step: "stop" })).toBe(1)
    // 3 is the session-guard defer rollback.ts branches on (rollback.ts's
    // EXIT_DEFERRED comparison) - the one value that MUST survive the narrowing.
    expect(restartOutcomeRc({ code: 3, verdict: { permitted: false, reason: "live-sessions", sessionCount: 2 } })).toBe(3)
  })

  it("readinessResultOk yields the boolean, and the caller keeps the detail", () => {
    const failed = { ready: false, detail: "/healthz did not return 200 on :4753" }
    expect(readinessResultOk(failed)).toBe(false)
    expect(readinessResultOk({ ready: true, detail: "" })).toBe(true)
    // The point of keeping the ReadinessResult rather than replacing it with a
    // boolean: readinessGaveUpLine still has something to say.
    expect(failed.detail).not.toBe("")
  })
})
