import { describe, it, expect } from "vitest"
import { FakeShellExecutor } from "./helpers/fake-executor.js"

describe("FakeShellExecutor", () => {
  it("exec returns default result when no match", async () => {
    const exe = new FakeShellExecutor()
    const result = await exe.exec({ argv: ["echo", "hello"] })
    expect(result.code).toBe(0)
  })

  it("exec returns configured result for matching argv prefix", async () => {
    const exe = new FakeShellExecutor()
    exe.addResponse(["git", "rev-parse"], { code: 0, stdout: "abc123\n", stderr: "", timedOut: false })
    const result = await exe.exec({ argv: ["git", "rev-parse", "HEAD"] })
    expect(result.stdout).toBe("abc123\n")
  })

  it("last-registered matching entry wins", async () => {
    const exe = new FakeShellExecutor()
    exe.addResponse(["git"], { code: 0, stdout: "first\n", stderr: "", timedOut: false })
    exe.addResponse(["git"], { code: 0, stdout: "second\n", stderr: "", timedOut: false })
    const result = await exe.exec({ argv: ["git", "status"] })
    expect(result.stdout).toBe("second\n")
  })

  it("run throws on nonzero exit", async () => {
    const exe = new FakeShellExecutor()
    exe.addResponse(["false"], { code: 1, stdout: "", stderr: "fail", timedOut: false })
    await expect(exe.run({ argv: ["false"] })).rejects.toThrow()
  })

  it("run returns result on zero exit", async () => {
    const exe = new FakeShellExecutor()
    exe.addResponse(["true"], { code: 0, stdout: "ok", stderr: "", timedOut: false })
    const result = await exe.run({ argv: ["true"] })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("ok")
  })

  it("pathExists returns false for unknown paths", async () => {
    const exe = new FakeShellExecutor()
    expect(await exe.pathExists("/nonexistent")).toBe(false)
  })

  it("pathExists returns true for added paths", async () => {
    const exe = new FakeShellExecutor()
    exe.addExistingPath("/etc/foo")
    expect(await exe.pathExists("/etc/foo")).toBe(true)
  })

  it("writeFile stores contents, readFile retrieves them", async () => {
    const exe = new FakeShellExecutor()
    await exe.writeFile("/tmp/test.txt", "hello world")
    expect(await exe.readFile("/tmp/test.txt")).toBe("hello world")
  })

  it("readFile returns undefined for missing file", async () => {
    const exe = new FakeShellExecutor()
    expect(await exe.readFile("/nonexistent")).toBeUndefined()
  })

  it("logs all calls including stdin", async () => {
    const exe = new FakeShellExecutor()
    await exe.exec({ argv: ["git", "status"] })
    await exe.exec({ argv: ["git", "diff"], stdin: "header\n" })
    const log = exe.getCallLog()
    expect(log).toHaveLength(2)
    expect(log[0]?.argv).toEqual(["git", "status"])
    expect(log[0]).not.toHaveProperty("stdin")
    expect(log[1]?.stdin).toBe("header\n")
  })

  it("stdin is omitted from log when not provided", async () => {
    const exe = new FakeShellExecutor()
    await exe.exec({ argv: ["ls"] })
    const log = exe.getCallLog()
    expect(log[0]).not.toHaveProperty("stdin")
  })

  it("getWrittenFiles reflects writeFile calls", async () => {
    const exe = new FakeShellExecutor()
    await exe.writeFile("/a", "aaa")
    await exe.writeFile("/b", "bbb")
    const files = exe.getWrittenFiles()
    expect(files.get("/a")).toBe("aaa")
    expect(files.get("/b")).toBe("bbb")
  })

  it("setDefault changes fallback result", async () => {
    const exe = new FakeShellExecutor()
    exe.setDefault({ code: 42, stdout: "default-out", stderr: "", timedOut: false })
    const result = await exe.exec({ argv: ["anything"] })
    expect(result.code).toBe(42)
    expect(result.stdout).toBe("default-out")
  })
})
