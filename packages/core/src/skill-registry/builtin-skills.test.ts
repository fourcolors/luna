import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BUILTIN_SKILLS } from "./builtin-skills.js"

describe("BUILTIN_SKILLS", () => {
  it("has unique ids", () => {
    const ids = BUILTIN_SKILLS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("gives every skill a description, trigger hint, and body", () => {
    for (const s of BUILTIN_SKILLS) {
      expect(s.source).toBe("builtin")
      expect(s.description.trim().length).toBeGreaterThan(0)
      expect(s.whenToUse.trim().length).toBeGreaterThan(0)
      expect(s.body.trim().length).toBeGreaterThan(0)
    }
  })

  it("ships screenshot-intake, which persists images into workspace notes", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.id === "screenshot-intake")
    expect(skill).toBeDefined()
    expect(skill?.body).toContain(".workspace/notes/")
    expect(skill?.body).toContain('createHash("sha256")')
    expect(skill?.body).toContain("messages.content_json")
    expect(skill?.body).not.toContain(".workspace/attachments/")
    expect(skill?.body).not.toContain("CREATE TABLE IF NOT EXISTS attachments")
    expect(skill?.body).not.toContain("sha256sum")
  })

  it("screenshot-intake guards git, extracts bytes from luna.db, and uses qualified tool names", () => {
    const body = BUILTIN_SKILLS.find((s) => s.id === "screenshot-intake")?.body ?? ""
    // Images must never become committable: the skill checks ignore state first.
    expect(body).toContain("check-ignore")
    expect(body).toContain(".workspace/.gitignore")
    // Concrete recovery path for the bytes (they exist only in luna.db).
    expect(body).toContain("sqlite3 -readonly")
    expect(body).toContain("Buffer.from(b.source.data")
    // Single write under the final content-addressed name.
    expect(body).toContain("existed")
    // Qualified MCP names only; bare names are forbidden in prompts.
    expect(body).toContain("mcp__memory__memory_save")
    expect(body).toContain("mcp__memory__memory_search")
    expect(body).toContain("mcp__observability__obs_note")
    expect(body).toContain("mcp__observability__obs_notes_recent")
    expect(body).not.toMatch(/(?<![_\w])(memory_save|memory_search|obs_note|obs_notes_recent)\b/)
    // Never write rows into the wake-owned table.
    expect(body).not.toContain("next_actions")
  })

  it("screenshot-intake dedupe ignores a sibling markdown note that reuses the image stem", () => {
    const body = BUILTIN_SKILLS.find((s) => s.id === "screenshot-intake")?.body ?? ""
    const script = /node -e '([^']+)' --/.exec(body)?.[1]
    expect(script).toBeDefined()
    const dir = mkdtempSync(join(tmpdir(), "screenshot-intake-"))
    try {
      const png = Buffer.from("not-really-a-png-but-stable-bytes")
      const message = JSON.stringify({
        message: {
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }],
        },
      })
      const run = (): { file: string; existed: boolean } => {
        const out = execFileSync("node", ["-e", script as string, "--", dir, "2026-10-03", "shot", "0"], {
          input: message,
          encoding: "utf8",
        })
        return JSON.parse(out.trim().split("\n").pop() as string)
      }
      const first = run()
      expect(first.existed).toBe(false)
      // A sibling note reusing the image stem sorts before .png.
      const stem = first.file.replace(/\.png$/, "")
      writeFileSync(`${stem}.md`, "facts")
      expect(readdirSync(dir).sort()[0]).toMatch(/\.md$/)
      const second = run()
      expect(second.existed).toBe(true)
      expect(second.file).toBe(first.file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("screenshot-intake does not promise a one-shot reminder from a cron-only scheduler", () => {
    const body = BUILTIN_SKILLS.find((s) => s.id === "screenshot-intake")?.body ?? ""
    expect(body).not.toContain("dated reminder")
    expect(body).toContain("repeats every year")
    expect(body).toContain("mcp__scheduler__schedule_cancel")
  })
})
