import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

const root = new URL("..", import.meta.url).pathname
const probe = join(root, "scripts/luna-guardian-remote-check")
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const setup = (completedAt: number) => {
  const temp = mkdtempSync(join(tmpdir(), "luna-guardian-remote-"))
  dirs.push(temp)
  const bin = join(temp, "bin")
  const sha = "a".repeat(40)
  mkdirSync(bin)
  writeFileSync(join(bin, "ssh"), `#!/usr/bin/env bash
printf 'profile=stable\ncompleted_at=${completedAt}\nrepo_sha=${sha}\nengine_sha=${sha}\noutcome=healthy\nconsecutive_healthy=3\n'
`)
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
printf '{"status":"ok","mode":"normal","buildSha":"${sha.slice(0, 8)}"}\n'
`)
  spawnSync("chmod", ["+x", join(bin, "ssh"), join(bin, "curl")])
  return { bin, sha }
}

describe("luna-guardian-remote-check", () => {
  it("accepts a fresh matching heartbeat and readyz SHA", () => {
    const { bin, sha } = setup(Math.floor(Date.now() / 1000))
    const result = spawnSync(
      "bash",
      [probe, "root@100.93.215.30", "stable", "--expected-sha", sha],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } },
    )
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain("guardian-remote: OK")
  })

  it("fails when the guardian heartbeat is stale", () => {
    const { bin } = setup(Math.floor(Date.now() / 1000) - 600)
    const result = spawnSync(
      "bash",
      [probe, "jax-box", "stable", "--max-age", "180"],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("heartbeat stale")
  })
})
