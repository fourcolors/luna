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

const setup = (
  completedAt: number | undefined,
  activeState = "inactive",
  timer: { active?: string; lastTrigger?: string } = {},
) => {
  const temp = mkdtempSync(join(tmpdir(), "luna-guardian-remote-"))
  dirs.push(temp)
  const bin = join(temp, "bin")
  const sha = "a".repeat(40)
  const heartbeat = completedAt === undefined
    ? ""
    : `profile=stable\ncompleted_at=${completedAt}\nrepo_sha=${sha}\nengine_sha=${sha}\noutcome=healthy\nconsecutive_healthy=3\n`
  const timerActive = timer.active ?? "active"
  const timerTrigger = timer.lastTrigger ?? "0"
  const timerProps = `timer_LoadState=loaded\ntimer_ActiveState=${timerActive}\ntimer_LastTriggerUSecMonotonic=${timerTrigger}\n`
  mkdirSync(bin)
  writeFileSync(join(bin, "ssh"), `#!/usr/bin/env bash
printf 'LoadState=loaded\nActiveState=${activeState}\n${timerProps}${heartbeat}'
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

  it("does not page while systemd is running a timeout-bounded guardian check", () => {
    const { bin } = setup(Math.floor(Date.now() / 1000) - 600, "activating")
    const result = spawnSync(
      "bash",
      [probe, "jax-box", "stable", "--max-age", "180"],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } },
    )
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain("IN PROGRESS")
  })

  it("does not page during the first guardian check before a heartbeat exists", () => {
    const { bin } = setup(undefined, "activating")
    const result = spawnSync(
      "bash",
      [probe, "jax-box", "stable"],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } },
    )
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain("IN PROGRESS")
  })

  it("does not page while the freshly installed timer has not fired its first cycle", () => {
    const { bin } = setup(undefined, "inactive", { active: "active", lastTrigger: "0" })
    const result = spawnSync(
      "bash",
      [probe, "jax-box", "stable"],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } },
    )
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain("PENDING FIRST CYCLE")
  })

  it("pages when the timer has already fired but no heartbeat was written", () => {
    const { bin } = setup(undefined, "inactive", { active: "active", lastTrigger: "123456789" })
    const result = spawnSync(
      "bash",
      [probe, "jax-box", "stable"],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("invalid heartbeat timestamp")
  })

  it("pages immediately when the guardian service has failed", () => {
    const { bin } = setup(Math.floor(Date.now() / 1000), "failed")
    const result = spawnSync(
      "bash",
      [probe, "jax-box", "stable"],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("guardian service is failed")
  })
})
