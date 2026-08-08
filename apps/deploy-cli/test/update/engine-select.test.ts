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
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { cleanupTempDirs, makeTempDir, repoRoot } from "./temp-dirs.js"

afterEach(() => { cleanupTempDirs() })

const AUTODEPLOY = join(repoRoot, "scripts/luna-autodeploy")

/** A pin dir holding a bash engine and, optionally, an executable deploy-cli. */
const makePin = (opts: { readonly cli: "executable" | "not-executable" | "absent" }): string => {
  const pin = makeTempDir("engine-select-")
  const engine = join(pin, "luna-update-server")
  writeFileSync(engine, "#!/usr/bin/env bash\nexit 0\n")
  chmodSync(engine, 0o755)
  if (opts.cli !== "absent") {
    const cli = join(pin, "deploy-cli")
    writeFileSync(cli, "#!/usr/bin/env bash\nexit 0\n")
    chmodSync(cli, opts.cli === "executable" ? 0o755 : 0o644)
  }
  return engine
}

const select = (pinnedEngine: string, env: Record<string, string | undefined>) => {
  const script = [
    "set -uo pipefail",
    `eval "$(awk '/^luna_select_engine\\(\\)/{f=1} f{print} f && /^}$/{exit}' ${JSON.stringify(AUTODEPLOY)})"`,
    `luna_select_engine ${JSON.stringify(pinnedEngine)}; printf '\\n%s' "$?"`,
  ].join("\n")
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } })
  const out = r.stdout ?? ""
  const nl = out.lastIndexOf("\n")
  return { chosen: out.slice(0, nl), rc: Number(out.slice(nl + 1)), stderr: r.stderr ?? "" }
}

describe("LUNA_DEPLOY_ENGINE", () => {
  describe("defaults to bash", () => {
    it("UNSET selects the pinned bash engine - the whole point of this slice", () => {
      const engine = makePin({ cli: "executable" })
      const r = select(engine, { LUNA_DEPLOY_ENGINE: undefined })
      expect(r.rc).toBe(0)
      expect(r.chosen).toBe(engine)
      expect(r.stderr).toBe("")
    })

    it("chooses bash even when a perfectly good binary sits beside it", () => {
      // The binary being PRESENT must not change the default - publishing it
      // fleet-wide (S21) is explicitly safe precisely because of this.
      const engine = makePin({ cli: "executable" })
      expect(select(engine, {}).chosen).toBe(engine)
    })

    it("an explicit bash is the same as unset", () => {
      const engine = makePin({ cli: "executable" })
      expect(select(engine, { LUNA_DEPLOY_ENGINE: "bash" }).chosen).toBe(engine)
    })
  })

  describe("binary", () => {
    it("selects the deploy-cli beside the pinned engine", () => {
      const engine = makePin({ cli: "executable" })
      const r = select(engine, { LUNA_DEPLOY_ENGINE: "binary" })
      expect(r.rc).toBe(0)
      expect(r.chosen).toBe(join(engine, "..", "deploy-cli").replace("/..", ""))
    })

    it("REFUSES when the binary is absent rather than falling back to bash", () => {
      const engine = makePin({ cli: "absent" })
      const r = select(engine, { LUNA_DEPLOY_ENGINE: "binary" })
      expect(r.rc).toBe(1)
      expect(r.chosen).toBe("")
      expect(r.stderr).toContain("refusing rather than silently running bash")
    })

    it("REFUSES when the binary is present but not executable", () => {
      const engine = makePin({ cli: "not-executable" })
      const r = select(engine, { LUNA_DEPLOY_ENGINE: "binary" })
      expect(r.rc).toBe(1)
      expect(r.stderr).toContain("no executable deploy-cli")
    })
  })

  describe("an unrecognised value", () => {
    it("REFUSES rather than silently choosing one", () => {
      // A typo that quietly ran bash would let someone believe they had soaked
      // the binary when they had not.
      const engine = makePin({ cli: "executable" })
      const r = select(engine, { LUNA_DEPLOY_ENGINE: "binry" })
      expect(r.rc).toBe(1)
      expect(r.chosen).toBe("")
      expect(r.stderr).toContain("is not one of bash|binary")
      expect(r.stderr).toContain("binry")
    })

    it("treats an empty value as unset, not as an error", () => {
      // `${LUNA_DEPLOY_ENGINE:-bash}` - an exported-but-empty variable is the
      // same as absent, which is what a shell profile that sets it to "" does.
      const engine = makePin({ cli: "executable" })
      const r = select(engine, { LUNA_DEPLOY_ENGINE: "" })
      expect(r.rc).toBe(0)
      expect(r.chosen).toBe(engine)
    })
  })
})
