/**
 * THE POLL-COLLAPSE NORMALISATION, tested against logs the STUBS ACTUALLY
 * WROTE rather than against a transcription of what they are believed to
 * write.
 *
 * WHY THE RULE EXISTS. `readiness_ok` polls against a WALL CLOCK
 * (scripts/luna-update-server:1071 sets `deadline=$((SECONDS +
 * READINESS_TIMEOUT))`, :1074 is the loop, :1122 is the per-iteration sleep),
 * so on the one scenario whose loop runs to exhaustion the number of entries
 * in trace.log, systemctl.log, curl.log and incus.log is a function of
 * subprocess latency. Measured, bash against bash, same fixture, four runs:
 * curl.log 6/7/7/7 lines and systemctl.log 20/22/22/22. Byte-diffing that is
 * invalid by construction, so for that ONE scenario those four logs are
 * compared in normalised form.
 *
 * WHY THIS FILE IS THE THING THAT KEEPS IT HONEST. A collapse is only
 * legitimate if it collapses the non-deterministic dimension AND NOTHING ELSE.
 * Revision 3 of the spec describes the earlier definition as one that
 * "described a sequence the harness never produces and so never collapsed
 * anything" - a normalisation that silently does nothing is the failure mode
 * to design against, and its twin is a normalisation that silently eats a real
 * difference. So this file asserts both directions:
 *
 *   - a two-iteration log and a three-iteration log normalise to the SAME
 *     bytes, on BOTH topologies and on all four logs, which is the collapse
 *     actually firing;
 *   - a log differing in any NON-poll entry does NOT normalise to the same
 *     bytes, which is what stops the collapse swallowing a real difference.
 *
 * WHERE THE FIXTURES COME FROM. They are CAPTURED, by driving the fixture's
 * own stubs with the exact argv `readiness_ok` issues and reading back what
 * they wrote. A hand-written literal would be a transcription of the stub, and
 * asserting a transcription against the thing it transcribes proves nothing -
 * the same objection the spec raises against using flow-lines.ts as a proof
 * oracle. Capturing means a future edit to a stub's log format shows up here
 * as a failure rather than as a normalisation that quietly stops matching.
 */
import { describe, expect, it, afterAll } from "vitest"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import {
  cleanupTempDirs,
  driveEnv,
  makeFixture,
  normalisePollBlocks,
  POLL_REPEATED,
  type Fixture,
} from "./bash-fixtures.js"

afterAll(() => {
  cleanupTempDirs()
})

const CONTAINER = "test-container"

/**
 * The four probe commands ONE readiness iteration issues, in bash's order:
 * `sup_is_active` (:1389), `sup_restart_count` (:1408), the /healthz curl
 * (:1082) and the /readyz curl (:1087). The argv is byte-for-byte what the
 * engine passes, because the whole point of capturing is that the block
 * definition matches real entries.
 */
const probeArgv = (fixture: Fixture): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => [
  ["systemctl", ["is-active", fixture.serviceName]],
  ["systemctl", ["show", fixture.serviceName, "--property=NRestarts", "--value"]],
  [
    "curl",
    ["-fsS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", `http://127.0.0.1:${fixture.readinessPort}/healthz`],
  ],
  ["curl", ["-sS", "-w", "\\n%{http_code}", "--max-time", "5", `http://127.0.0.1:${fixture.readinessPort}/readyz`]],
]

/**
 * Run one simulated readiness iteration through the fixture's stubs.
 *
 * On the incus topology every probe goes through `run_target_capture`
 * (:361-369), which wraps it as `incus exec <container> -- <argv>`; the incus
 * stub logs the raw argv and then re-execs the payload, which logs itself. So
 * that topology produces a WRAPPER entry immediately followed by its payload
 * entry, which is the second reason the naive four-line block definition never
 * matched anything.
 */
const runIteration = (fixture: Fixture, topology: "bare-host" | "incus"): void => {
  const env = driveEnv(fixture)
  for (const [tool, argv] of probeArgv(fixture)) {
    const spawned =
      topology === "bare-host"
        ? spawnSync(join(fixture.bin, tool), [...argv], { env, encoding: "utf8" })
        : spawnSync(join(fixture.bin, "incus"), ["exec", CONTAINER, "--", tool, ...argv], { env, encoding: "utf8" })
    // A stub that failed to run would produce an EMPTY log and every assertion
    // below would pass vacuously, so the spawn itself is checked.
    expect(spawned.error, `${topology} ${tool} ${argv.join(" ")}`).toBeUndefined()
  }
}

interface Capture {
  readonly trace: string
  readonly systemctl: string
  readonly curl: string
  readonly incus: string | null
}

const readLogs = (fixture: Fixture, topology: "bare-host" | "incus"): Capture => ({
  trace: readFileSync(fixture.traceLog, "utf8"),
  systemctl: readFileSync(fixture.systemctlLog, "utf8"),
  curl: readFileSync(fixture.curlLog, "utf8"),
  incus: topology === "incus" && fixture.incusLog !== undefined ? readFileSync(fixture.incusLog, "utf8") : null,
})

/**
 * Capture the same fixture's logs after TWO iterations and again after THREE.
 *
 * One fixture, read twice, rather than two fixtures: the three-iteration log
 * must be the two-iteration log plus exactly one more block, and building it
 * that way removes any chance that an incidental difference between two
 * fixture roots is what the equality assertion is really observing.
 */
const captureTwoAndThree = (topology: "bare-host" | "incus"): { readonly two: Capture; readonly three: Capture } => {
  const fixture = makeFixture(
    topology === "incus"
      ? { readyAtTarget: true, readyAtPrev: false, incus: CONTAINER }
      : { readyAtTarget: true, readyAtPrev: false },
  )
  runIteration(fixture, topology)
  runIteration(fixture, topology)
  const two = readLogs(fixture, topology)
  runIteration(fixture, topology)
  const three = readLogs(fixture, topology)
  return { two, three }
}

describe("normalisePollBlocks: the ONE normalisation rule, on captured logs from both topologies", () => {
  for (const topology of ["bare-host", "incus"] as const) {
    it(
      `${topology}: a two-iteration log and a three-iteration log normalise to the SAME bytes`,
      () => {
        const { two, three } = captureTwoAndThree(topology)

        // The premise: the two captures really do differ before normalisation.
        // Without this the equality below could hold because nothing varied.
        expect(three.trace).not.toBe(two.trace)
        expect(three.systemctl).not.toBe(two.systemctl)
        expect(three.curl).not.toBe(two.curl)

        expect(normalisePollBlocks(three.trace)).toBe(normalisePollBlocks(two.trace))
        expect(normalisePollBlocks(three.systemctl)).toBe(normalisePollBlocks(two.systemctl))
        expect(normalisePollBlocks(three.curl)).toBe(normalisePollBlocks(two.curl))
        if (three.incus !== null && two.incus !== null) {
          expect(three.incus).not.toBe(two.incus)
          expect(normalisePollBlocks(three.incus)).toBe(normalisePollBlocks(two.incus))
        }

        // The collapse FIRED, rather than the two logs happening to be equal:
        // the normalised form carries the token and is strictly shorter.
        for (const normalised of [
          normalisePollBlocks(three.trace),
          normalisePollBlocks(three.systemctl),
          normalisePollBlocks(three.curl),
        ]) {
          expect(normalised).toContain(POLL_REPEATED)
        }
        expect(normalisePollBlocks(three.trace).split("\n").length).toBeLessThan(three.trace.split("\n").length)
      },
      { timeout: 120_000 },
    )

    it(
      `${topology}: a log differing in any NON-poll entry does NOT normalise to the same bytes`,
      () => {
        const { three } = captureTwoAndThree(topology)

        // THE ASSERTION THAT KEEPS THIS A NORMALISATION AND NOT A MASK. A
        // `bun install` entry is not a probe, so it must survive the collapse
        // in full - both its presence and its argv. If it did not, a binary
        // that installed the wrong container path, or installed at all when it
        // should not have, would diff clean on the one scenario that uses this
        // rule.
        const bunA = "bun install --cwd /root/luna --frozen-lockfile\n"
        const bunB = "bun install --cwd /wrong/path --frozen-lockfile\n"

        // Differing IN CONTENT, at the head of an otherwise identical log.
        expect(normalisePollBlocks(bunA + three.trace)).not.toBe(normalisePollBlocks(bunB + three.trace))
        // Differing by PRESENCE, in the middle of one.
        const lines = three.trace.split("\n")
        const middle = Math.floor(lines.length / 2)
        const withExtra = [...lines.slice(0, middle), bunA.trimEnd(), ...lines.slice(middle)].join("\n")
        expect(normalisePollBlocks(withExtra)).not.toBe(normalisePollBlocks(three.trace))
        // And the non-poll entry survives verbatim.
        expect(normalisePollBlocks(bunA + three.trace)).toContain(bunA.trimEnd())
      },
      { timeout: 120_000 },
    )
  }

  it("a single, unrepeated poll block is left completely alone", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    runIteration(fixture, "bare-host")
    const one = readFileSync(fixture.traceLog, "utf8")
    expect(normalisePollBlocks(one)).toBe(one)
    expect(normalisePollBlocks(one)).not.toContain(POLL_REPEATED)
  })

  it("collapses only IDENTICAL adjacent blocks: two blocks that differ are both kept", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    runIteration(fixture, "bare-host")
    const block = readFileSync(fixture.traceLog, "utf8")
    // Same shape, different unit name: still four probe entries, so still two
    // blocks, but not identical ones - the collapse must decline.
    const other = block.split("luna-chat-server.service").join("luna-other.service")
    expect(normalisePollBlocks(block + other)).toBe(block + other)
    // and the identical pair DOES collapse, which is the control.
    expect(normalisePollBlocks(block + block)).toBe(`${block.trimEnd()}\n${POLL_REPEATED}\n`)
  })

  it("leaves a log with no poll entries at all byte-identical, including the empty log", () => {
    const plain = "bun install --cwd /root/luna --frozen-lockfile\nbun install --cwd /root/luna --frozen-lockfile\n"
    expect(normalisePollBlocks(plain)).toBe(plain)
    expect(normalisePollBlocks("")).toBe("")
    // No trailing newline in, none out: the harness compares raw file bytes,
    // so the normaliser must not invent or drop one.
    expect(normalisePollBlocks("systemctl is-active x")).toBe("systemctl is-active x")
  })

  it("a poll block interrupted by a git entry is NOT collapsed, which is why the curl stub bypasses the git shim", () => {
    // This is the failure mode THE REPLACEMENT `curl` MUST CALL GIT BY
    // ABSOLUTE PATH exists to prevent, reproduced here so the consequence is
    // visible rather than argued. With a bare `git` in the curl stub every
    // poll would append a git entry between the two curl entries, the blocks
    // would stop being contiguous ascending runs, and the collapse would
    // silently never fire - leaving the exhaustion scenario compared strictly
    // against a log whose length is a function of subprocess latency.
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    runIteration(fixture, "bare-host")
    const clean = readFileSync(fixture.traceLog, "utf8")
    expect(normalisePollBlocks(clean + clean)).toContain(POLL_REPEATED)

    const polluted = clean
      .split("\n")
      .flatMap((l) => (l.startsWith("curl ") ? [`git -C /repo rev-parse HEAD`, l] : [l]))
      .join("\n")
    expect(normalisePollBlocks(polluted + polluted)).not.toContain(POLL_REPEATED)
  })

  it("the captured log shapes are the ones the block definition claims to match", () => {
    // A readability guard rather than a behaviour one: it prints the exact
    // bytes the definition is written against, so a reader of the four-command
    // rule can see the real entries next to it instead of trusting a comment.
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false, incus: CONTAINER })
    runIteration(fixture, "incus")
    const trace = readFileSync(fixture.traceLog, "utf8").split("\n").filter((l) => l !== "")
    expect(trace).toEqual([
      `incus exec ${CONTAINER} -- systemctl is-active ${fixture.serviceName}`,
      `systemctl is-active ${fixture.serviceName}`,
      `incus exec ${CONTAINER} -- systemctl show ${fixture.serviceName} --property=NRestarts --value`,
      `systemctl show ${fixture.serviceName} --property=NRestarts --value`,
      `incus exec ${CONTAINER} -- curl -fsS -o /dev/null -w %{http_code} --max-time 5 http://127.0.0.1:${fixture.readinessPort}/healthz`,
      `curl -fsS -o /dev/null -w %{http_code} --max-time 5 http://127.0.0.1:${fixture.readinessPort}/healthz`,
      `incus exec ${CONTAINER} -- curl -sS -w \\n%{http_code} --max-time 5 http://127.0.0.1:${fixture.readinessPort}/readyz`,
      `curl -sS -w \\n%{http_code} --max-time 5 http://127.0.0.1:${fixture.readinessPort}/readyz`,
    ])
    // incus.log carries ONLY the wrappers, with no payload entries beside
    // them; the block definition has to cover that shape too, which is why it
    // consumes a wrapper alone when the next entry is not its payload.
    expect(fixture.incusLog).toBeDefined()
    const incusLog = readFileSync(fixture.incusLog as string, "utf8").split("\n").filter((l) => l !== "")
    expect(incusLog).toHaveLength(4)
    expect(incusLog.every((l) => l.startsWith(`exec ${CONTAINER} -- `))).toBe(true)
  })

  it("writes no file of its own: the normaliser is pure over strings", () => {
    // Guards against a future implementation that reaches for a temp file to
    // do the collapsing; the parity harness compares captured bytes and must
    // never mutate the fixture root while doing it.
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const probe = join(fixture.temp, "normaliser-probe")
    writeFileSync(probe, "x")
    runIteration(fixture, "bare-host")
    const before = readFileSync(fixture.traceLog, "utf8")
    normalisePollBlocks(before)
    expect(readFileSync(fixture.traceLog, "utf8")).toBe(before)
    expect(readFileSync(probe, "utf8")).toBe("x")
  })
})
