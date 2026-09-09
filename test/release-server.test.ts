import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

// Execute the actual publication step with a recording CLI; never contact GitHub.
const workflow = readFileSync(new URL("../.github/workflows/release-server.yml", import.meta.url), "utf8")
const publishStep = workflow.split("      - name: Create GitHub Release (--latest=false)")[1]!
const script = publishStep.split("        run: |\n")[1]!
  .split("\n\n")[0]!.replace(/^          /gm, "")

describe("server release publication", () => {
  it.each(["missing", "empty", "present"] as const)("handles %s release notes before publishing", (state) => {
    const root = mkdtempSync(join(tmpdir(), "luna-release-test-"))
    try {
      mkdirSync(join(root, "bin"))
      mkdirSync(join(root, "docs/releases"), { recursive: true })
      const notes = "docs/releases/server-v0.4.0.md"
      if (state !== "missing") writeFileSync(join(root, notes), state === "present" ? "Upgrade prerequisites\n" : "")
      writeFileSync(join(root, "bin/gh"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$RELEASE_CALL"\n', { mode: 0o755 })
      const call = join(root, "call")
      const result = spawnSync("bash", ["-c", script], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, RELEASE_CALL: call,
          TAG: "server-v0.4.0", VERSION: "0.4.0", REPO: "fourcolors/luna", COMMIT_SHA: "abc123" },
      })
      if (state === "present") {
        expect(result.status, result.stderr).toBe(0)
        const args = readFileSync(call, "utf8").trim().split("\n")
        expect(args).toEqual(["release", "create", "server-v0.4.0", "--title", "Luna Server 0.4.0",
          "--notes-file", notes, "--latest=false", "--target", "abc123", "server-latest.json", "--repo", "fourcolors/luna"])
      } else {
        expect(result.status).toBe(1)
        expect(result.stderr).toContain("missing release notes")
        expect(() => readFileSync(call)).toThrow()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
