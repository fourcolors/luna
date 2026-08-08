/**
 * Golden parity for the readiness gate (S22c): every scenario runs the REAL
 * `readiness_ok` out of scripts/luna-update-server and the TypeScript port over
 * the same inputs, then asserts BOTH agree on the verdict AND on
 * `READINESS_DETAIL` byte for byte.
 *
 * WHY THE DETAIL STRING IS ASSERTED AND NOT JUST THE VERDICT. A rolled-back
 * deploy leaves an operator exactly two artifacts: the `ROLLED BACK to` marker
 * and this sentence. A port that agreed on pass/fail while drifting on the
 * diagnosis would be silently worse than the bash at the only moment anyone
 * reads it.
 *
 * HOW THE BASH SIDE IS DRIVEN. `readiness_ok` is extracted from the script by
 * awk and eval'd into a shell where every collaborator it reads
 * (`sup_is_active`, `sup_restart_count`, `run_target_capture`, `luna_warn`) is
 * a stub - the same technique test/engine-pin.test.ts uses for
 * `luna_pin_engine`, and the reason this suite needs no deploy repo, no unit
 * file and no systemd.
 *
 * TIMING IS PINNED, NOT WAITED ON. Every scenario runs with timeout=1 and
 * interval=1, so the bash loop makes exactly ONE attempt and then finds
 * `SECONDS` past the deadline. The TS side is given a fake clock that advances
 * only when `sleep` is called, which reproduces that attempt count exactly
 * rather than approximating it - so a port that retried a different number of
 * times would show up here as a detail mismatch, not as a slow test.
 */
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  type ReadyzCapture,
  readinessOkSync,
  readinessRestartBaseline,
} from "../../src/update/readiness.js"
import { repoRoot } from "./temp-dirs.js"

const UPDATE_SERVER = join(repoRoot, "scripts/luna-update-server")

const SERVICE = "luna-chat-server.service"
const PORT = 4753

interface Scenario {
  readonly active: string
  readonly restarts: string
  readonly healthz: string
  /**
   * The /readyz BODY and CODE are kept apart, then joined with a real newline
   * on each side. An earlier version of this file passed the joined string
   * through JSON.stringify into the shell, where `printf '%s'` printed a
   * LITERAL backslash-n - so bash never saw a newline, `${readyz##*$'\n'}`
   * returned the whole string, and the suite was comparing two implementations
   * of a case that cannot occur. Splitting it makes that unrepresentable.
   */
  readonly readyzBody: string
  readonly readyzCode: string
  readonly expectedBuildSha: string
  readonly allowMissingBuildSha: boolean
  readonly baseline: number
}

const base: Scenario = {
  active: "active",
  restarts: "0",
  healthz: "200",
  readyzBody: '{"mode":"normal"}',
  readyzCode: "200",
  expectedBuildSha: "",
  allowMissingBuildSha: false,
  baseline: 0,
}

/** Run the REAL bash readiness_ok over a scenario; return its rc + READINESS_DETAIL. */
const runBash = (s: Scenario): { readonly rc: number; readonly detail: string } => {
  // `run_target_capture curl ... /healthz ...` vs `... /readyz ...` is
  // distinguished on the argv, exactly as the two call sites differ.
  const script = [
    "set -uo pipefail",
    `SERVICE_NAME=${JSON.stringify(SERVICE)}`,
    `READINESS_PORT=${PORT}`,
    "READINESS_TIMEOUT=1",
    "READINESS_INTERVAL=1",
    "READINESS_CURL_MAX_TIME=5",
    `EXPECTED_BUILD_SHA=${JSON.stringify(s.expectedBuildSha)}`,
    `ALLOW_MISSING_BUILD_SHA=${s.allowMissingBuildSha}`,
    'READINESS_DETAIL=""',
    `sup_is_active() { printf '%s' ${JSON.stringify(s.active)}; }`,
    `sup_restart_count() { printf '%s' ${JSON.stringify(s.restarts)}; }`,
    "luna_warn() { :; }",
    `run_target_capture() {
       case "$*" in
         */healthz*) printf '%s' ${JSON.stringify(s.healthz)} ;;
         */readyz*)  printf '%s\\n%s' ${JSON.stringify(s.readyzBody)} ${JSON.stringify(s.readyzCode)} ;;
         *) printf '' ;;
       esac
     }`,
    `eval "$(awk '/^readiness_ok\\(\\)/{f=1} f{print} f && /^}$/{exit}' ${JSON.stringify(UPDATE_SERVER)})"`,
    `readiness_ok ${s.baseline}; rc=$?`,
    'printf "%s\\n%s" "$rc" "$READINESS_DETAIL"',
  ].join("\n")

  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" })
  const out = r.stdout ?? ""
  const nl = out.indexOf("\n")
  return { rc: Number(out.slice(0, nl)), detail: out.slice(nl + 1) }
}

/** Run the TS port over the same scenario with a clock that only moves on sleep. */
const runTs = (s: Scenario): { readonly rc: number; readonly detail: string } => {
  let clock = 0
  const result = readinessOkSync({
    serviceName: SERVICE,
    readinessPort: PORT,
    timeoutSecs: 1,
    intervalSecs: 1,
    expectedBuildSha: s.expectedBuildSha,
    allowMissingBuildSha: s.allowMissingBuildSha,
    baseline: s.baseline,
    isActive: () => s.active,
    restartCount: () => s.restarts,
    probeHealthz: () => s.healthz,
    probeReadyz: () => `${s.readyzBody}\n${s.readyzCode}`,
    now: () => clock,
    sleep: (secs) => { clock += secs },
  })
  return { rc: result.ready ? 0 : 1, detail: result.detail }
}

const parity = (name: string, s: Scenario, expected: { rc: number; detailMatch?: RegExp }) => {
  it(name, () => {
    const bash = runBash(s)
    const ts = runTs(s)
    expect(bash.rc, `bash rc (detail: ${bash.detail})`).toBe(expected.rc)
    expect(ts.rc, `port rc (detail: ${ts.detail})`).toBe(expected.rc)
    // The assertion that matters: identical diagnosis, not merely identical verdict.
    expect(ts.detail).toBe(bash.detail)
    if (expected.detailMatch) expect(bash.detail).toMatch(expected.detailMatch)
  })
}

describe("readiness gate: golden parity with scripts/luna-update-server", () => {
  describe("promotes", () => {
    parity("healthy unit, /readyz normal, no expected sha", base, { rc: 0 })

    parity(
      "a legacy build whose /readyz 404s is accepted",
      { ...base, readyzBody: "", readyzCode: "404" },
      { rc: 0 },
    )

    parity(
      "buildSha matches when the runtime reports a SHORT sha",
      { ...base, readyzBody: '{"mode":"normal","buildSha":"abcdef123456"}', readyzCode: "200", expectedBuildSha: "abcdef123456789abcdef" },
      { rc: 0 },
    )

    parity(
      "buildSha matches when the runtime reports a LONGER sha than expected",
      { ...base, readyzBody: '{"mode":"normal","buildSha":"abcdef123456789abcdef"}', readyzCode: "200", expectedBuildSha: "abcdef123456" },
      { rc: 0 },
    )

    parity(
      "an absent buildSha is accepted on the rollback path only",
      { ...base, readyzBody: '{"mode":"normal"}', readyzCode: "200", expectedBuildSha: "abcdef123456", allowMissingBuildSha: true },
      { rc: 0 },
    )
  })

  describe("refuses", () => {
    // THE ONE THIS SUITE EXISTS FOR. `000` is curl's transport failure - very
    // often the process dying between the healthz and readyz probes. Treating
    // it as a legacy 404 would promote a corpse.
    parity(
      "a /readyz transport failure (000) is NOT treated as a legacy 404",
      { ...base, readyzBody: "", readyzCode: "000" },
      { rc: 1, detailMatch: /^\/readyz did not report "mode":"normal".*http=000\)$/ },
    )

    parity(
      "the unit never reaching active",
      { ...base, active: "activating" },
      { rc: 1, detailMatch: /is not active \(state=activating\)$/ },
    )

    parity(
      "a crash-looping unit (NRestarts past the baseline)",
      { ...base, restarts: "4", baseline: 1 },
      { rc: 1, detailMatch: /is crash-looping \(NRestarts 4 > baseline 1\)$/ },
    )

    parity(
      "a non-numeric NRestarts falls back to 0 rather than throwing",
      { ...base, restarts: "n/a", baseline: 0, healthz: "503" },
      { rc: 1, detailMatch: /^\/healthz did not return 200 on :4753$/ },
    )

    parity(
      "/healthz not answering 200",
      { ...base, healthz: "503" },
      { rc: 1, detailMatch: /^\/healthz did not return 200 on :4753$/ },
    )

    parity(
      "/readyz still in setup-mode",
      { ...base, readyzBody: '{"mode":"setup"}', readyzCode: "200" },
      { rc: 1, detailMatch: /did not report "mode":"normal".*http=200\)$/ },
    )

    parity(
      "a buildSha that identifies a DIFFERENT build",
      { ...base, readyzBody: '{"mode":"normal","buildSha":"999999999999"}', readyzCode: "200", expectedBuildSha: "abcdef123456" },
      { rc: 1, detailMatch: /^\/readyz buildSha 999999999999 does not match expected abcdef123456$/ },
    )

    // The forward path must NOT accept a missing sha - a runtime that resolved
    // its sha to "unknown" would otherwise promote any build at all.
    parity(
      "an absent buildSha on the FORWARD path",
      { ...base, readyzBody: '{"mode":"normal"}', readyzCode: "200", expectedBuildSha: "abcdef123456", allowMissingBuildSha: false },
      { rc: 1, detailMatch: /no usable hex buildSha.*matching abcdef123456 \(set LUNA_BUILD_SHA/ },
    )
  })

  describe("readinessRestartBaseline", () => {
    it("takes the count as written when it is numeric", () => {
      expect(readinessRestartBaseline(() => "7")).toBe(7)
    })

    it("falls back to 0 for anything non-numeric, matching the bash regex guard", () => {
      for (const junk of ["", "n/a", "[not-set]", "3.5", "-1"]) {
        expect(readinessRestartBaseline(() => junk), junk).toBe(0)
      }
    })
  })
})
