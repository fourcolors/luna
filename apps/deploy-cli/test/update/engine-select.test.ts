/**
 * `LUNA_DEPLOY_ENGINE` selection (S22c part 3).
 *
 * The gate that will eventually flip every production restart onto the binary.
 * S23 is the slice that flips the DEFAULT and needs a soak and a sign-off;
 * this one only makes the choice expressible, so the single most important
 * assertion here is the first: with the variable unset, nothing changes.
 *
 * BOTH REFUSALS ARE TESTED because both are deliberate. A typo'd value and a
 * missing binary each fall back to bash in the "obvious" implementation, and
 * both would leave an operator believing they had soaked the binary when they
 * had not - the silent-wrong-answer class this whole arc exists to remove.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { cleanupTempDirs, makeTempDir, repoRoot } from "./temp-dirs.js"

afterEach(() => { cleanupTempDirs() })

const AUTODEPLOY = join(repoRoot, "scripts/luna-autodeploy")

/**
 * TWO DIRECTORIES, because production has two and the first version of this
 * fixture had one.
 *
 * The bash engine is quarantined by luna_pin_engine into
 * /usr/local/lib/luna/deploy-engine@<sha>/, which it populates with
 * luna-update-server and lib/ and NOTHING ELSE. deploy-cli is published by
 * guardian into a different pin entirely (scripts/luna-guardian:1216-1219),
 * which is the directory autodeploy was exec'd from.
 *
 * The old fixture wrote both artifacts into ONE directory. That shape does not
 * occur on any host, and it is precisely why the gate shipped looking for the
 * binary beside the pinned engine - a path nothing ever writes - without a test
 * noticing. Modelling the split makes that class of bug expressible again.
 */
const makePin = (opts: { readonly cli: "executable" | "not-executable" | "absent" }): {
  readonly engine: string
  readonly binaryDir: string
} => {
  const root = makeTempDir("engine-select-")
  const enginePin = join(root, "deploy-engine@abc123")
  const binaryDir = join(root, "guardian-pin")
  mkdirSync(enginePin, { recursive: true })
  mkdirSync(binaryDir, { recursive: true })

  const engine = join(enginePin, "luna-update-server")
  writeFileSync(engine, "#!/usr/bin/env bash\nexit 0\n")
  chmodSync(engine, 0o755)

  if (opts.cli !== "absent") {
    const cli = join(binaryDir, "deploy-cli")
    writeFileSync(cli, "#!/usr/bin/env bash\nexit 0\n")
    chmodSync(cli, opts.cli === "executable" ? 0o755 : 0o644)
  }
  return { engine, binaryDir }
}

/**
 * The gate emits an argv PREFIX, one field per line - not just a path. The bash
 * engine's surface is flag-only so its prefix is one field; the binary replaces
 * three scripts and needs `update` naming which one, or citty rejects the
 * shared flags with "Unknown command stable" before reaching its own logic.
 */
const select = (pin: { engine: string; binaryDir: string }, env: Record<string, string | undefined>) => {
  const script = [
    "set -uo pipefail",
    `eval "$(awk '/^luna_select_engine\\(\\)/{f=1} f{print} f && /^}$/{exit}' ${JSON.stringify(AUTODEPLOY)})"`,
    `luna_select_engine ${JSON.stringify(pin.engine)} ${JSON.stringify(pin.binaryDir)}; printf '\\n%s' "$?"`,
  ].join("\n")
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } })
  const out = r.stdout ?? ""
  const nl = out.lastIndexOf("\n")
  const argv = out.slice(0, nl).split("\n").filter((l) => l !== "")
  return {
    argv,
    chosen: argv[0] ?? "",
    rc: Number(out.slice(nl + 1)),
    stderr: r.stderr ?? "",
  }
}

describe("every engine exec goes through the gate", () => {
  /**
   * A SOURCE invariant, and deliberately so: the property is about the shape of
   * the script, not about one behaviour, and no behavioural test would have
   * caught what this catches.
   *
   * The gate shipped with exactly ONE call site (do_deploy). do_repair exec'd
   * the pinned bash engine directly at both its rungs, so guardian's entire
   * unattended repair ladder ran bash whatever LUNA_DEPLOY_ENGINE said - and
   * rung 2 is a FULL redeploy, not just a restart. A behavioural test of the
   * gate passes happily while a second, ungated exec site sits beside it.
   */
  const source = readFileSync(join(repoRoot, "scripts/luna-autodeploy"), "utf8")

  it("has no exec of the pinned bash engine that bypasses luna_select_engine", () => {
    const bypasses = source
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      // An exec looks like `"$pinned_engine" ...`; the gate's own internal
      // `printf '%s\n' "$pinned_engine"` is not an exec and is excluded.
      .filter(({ line }) => /^"\$pinned_engine"\s/.test(line))

    expect(
      bypasses.map((b) => `${b.n}: ${b.line}`),
      "every engine invocation must exec the argv prefix the gate returned",
    ).toEqual([])
  })

  /**
   * ALSO A SOURCE INVARIANT, and for the same reason as the bypass test above:
   * the property is "every exec site carries it", which is a statement about
   * the shape of the script. A behavioural test can only ever prove the ONE
   * site it drives, and the defect this guards against is precisely a second
   * site that someone forgot - the shape of the do_repair bug.
   *
   * The binary derives the shared bash library as
   * dirname($LUNA_DEPLOY_BASH_ENGINE)/lib/luna-deploy.sh. If the variable is
   * absent, resolveBashLib REFUSES (deliberately, rather than guessing a path),
   * so an exec site missing this prefix means every delegated topology - the
   * ones the binary hands back to bash - dies on that host. The bash engine
   * never reads the variable, so a missing prefix is invisible until someone
   * sets LUNA_DEPLOY_ENGINE=binary, which is the worst time to discover it.
   */
  it("hands the PINNED engine path to every exec site, not just the deploy path", () => {
    const execSites = source
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      // An exec of the gate's argv prefix. The lines that BUILD the arrays use
      // `engine_argv+=(...)`, which this deliberately does not match.
      .filter(({ line }) => /"\$\{(?:engine|repair)_argv\[@\]\}"/.test(line))

    // Guard the guard: if the exec sites are ever renamed, this test must fail
    // loudly rather than silently vacuously passing over an empty list.
    expect(execSites.length, "expected do_deploy plus both do_repair rungs").toBe(3)

    const missing = execSites.filter(
      ({ line }) => !line.startsWith('LUNA_DEPLOY_BASH_ENGINE="$pinned_engine" '),
    )
    expect(
      missing.map((m) => `${m.n}: ${m.line}`),
      "every engine exec must hand over the pinned engine path",
    ).toEqual([])
  })

  it("routes BOTH repair rungs through the gate, not just the deploy path", () => {
    // Rung 1 is --restart-only; rung 2 is a full redeploy. Both were ungated.
    const gateCalls = source.split("\n").filter((l) => l.includes("luna_select_engine \"$pinned_engine\""))
    expect(gateCalls.length, "do_deploy plus both repair rungs share one selection each").toBeGreaterThanOrEqual(2)
    expect(source).toMatch(/repair_argv\[@\]/)
  })
})

describe("LUNA_DEPLOY_ENGINE", () => {
  describe("defaults to bash", () => {
    it("UNSET selects the pinned bash engine - the whole point of this slice", () => {
      const pin = makePin({ cli: "executable" })
      const r = select(pin, { LUNA_DEPLOY_ENGINE: undefined })
      expect(r.rc).toBe(0)
      expect(r.chosen).toBe(pin.engine)
      expect(r.stderr).toBe("")
      // EXACTLY one field: luna-update-server's surface is flag-only, so a
      // subcommand here would be passed through as a positional argument and
      // change the bash invocation this slice promises to leave untouched.
      expect(r.argv, "the bash prefix must be the path alone").toEqual([pin.engine])
    })

    it("chooses bash even when a perfectly good binary sits beside it", () => {
      // The binary being PRESENT must not change the default - publishing it
      // fleet-wide (S21) is explicitly safe precisely because of this.
      const pin = makePin({ cli: "executable" })
      expect(select(pin, {}).chosen).toBe(pin.engine)
    })

    it("an explicit bash is the same as unset", () => {
      const pin = makePin({ cli: "executable" })
      expect(select(pin, { LUNA_DEPLOY_ENGINE: "bash" }).chosen).toBe(pin.engine)
    })
  })

  describe("binary", () => {
    it("selects the deploy-cli beside the pinned engine, WITH the update subcommand", () => {
      const pin = makePin({ cli: "executable" })
      const r = select(pin, { LUNA_DEPLOY_ENGINE: "binary" })
      expect(r.rc).toBe(0)
      expect(r.chosen).toBe(join(pin.binaryDir, "deploy-cli"))
      // Without this the shared flags reach citty as a bare command and it
      // answers "Unknown command stable" (exit 1) - a parse error standing in
      // for whatever the binary would actually have done.
      expect(r.argv[1], "the subcommand naming which script this replaces").toBe("update")
      expect(r.argv).toHaveLength(2)
    })

    it("REFUSES when the binary is absent rather than falling back to bash", () => {
      const pin = makePin({ cli: "absent" })
      const r = select(pin, { LUNA_DEPLOY_ENGINE: "binary" })
      expect(r.rc).toBe(1)
      expect(r.chosen).toBe("")
      expect(r.stderr).toContain("refusing rather than silently running bash")
    })

    it("REFUSES when the binary is present but not executable", () => {
      const pin = makePin({ cli: "not-executable" })
      const r = select(pin, { LUNA_DEPLOY_ENGINE: "binary" })
      expect(r.rc).toBe(1)
      expect(r.stderr).toContain("no executable deploy-cli")
    })
  })

  describe("an unrecognised value", () => {
    it("REFUSES rather than silently choosing one", () => {
      // A typo that quietly ran bash would let someone believe they had soaked
      // the binary when they had not.
      const pin = makePin({ cli: "executable" })
      const r = select(pin, { LUNA_DEPLOY_ENGINE: "binry" })
      expect(r.rc).toBe(1)
      expect(r.chosen).toBe("")
      expect(r.stderr).toContain("is not one of bash|binary")
      expect(r.stderr).toContain("binry")
    })

    it("treats an empty value as unset, not as an error", () => {
      // `${LUNA_DEPLOY_ENGINE:-bash}` - an exported-but-empty variable is the
      // same as absent, which is what a shell profile that sets it to "" does.
      const pin = makePin({ cli: "executable" })
      const r = select(pin, { LUNA_DEPLOY_ENGINE: "" })
      expect(r.rc).toBe(0)
      expect(r.chosen).toBe(pin.engine)
    })
  })
})
