/**
 * constellation.test.ts
 *
 * WHY THIS FILE EXISTS: 0.0.73 shipped a constellation that was monochrome in
 * the real app. `kindForTool` was a bare table lookup over Claude Code's
 * built-in tool names with `?? "read"` as the fallback, and every tool Luna
 * actually calls is an MCP tool named `mcp__<server>__<tool>`. So every star
 * fell through to neutral. The bug was invisible to the suite because the only
 * coverage was indirect, through MessageList tests that used names like `Bash`.
 *
 * The rule this file enforces: classification is tested against the tool names
 * that appear in production, not the ones that are convenient to type.
 */
import { describe, expect, it } from "vitest"
import { kindForTool, starsFor, stripMcpPrefix, toolTokens } from "./constellation"
import type { MergedStep } from "./chatModel"

describe("kindForTool - real MCP tool names", () => {
  // These are copied from an actual Luna turn, not invented. If the naming
  // convention on the server changes, this is the test that should fail.
  it("tints a real local-shell run as work, not as a read", () => {
    expect(kindForTool("mcp__local_shell__local_shell_run")).toBe("run")
  })

  it("keeps a listing on the shell server neutral - nothing was executed", () => {
    // The regression guard for over-correcting: it would be easy to classify
    // the whole `local_shell` server as `run` and claim a command ran when the
    // call only enumerated roots.
    expect(kindForTool("mcp__local_shell__local_shell_list_roots")).toBe("read")
  })

  it("leaves an observability read neutral", () => {
    expect(kindForTool("mcp__observability__obs_notes_recent")).toBe("read")
  })

  it("reads a create as a write", () => {
    expect(kindForTool("mcp__github__create_pull_request")).toBe("write")
  })

  it("reads a web search as network", () => {
    expect(kindForTool("mcp__web__web_search")).toBe("web")
  })

  it("does NOT classify a whole turn as one colour", () => {
    // The actual user-visible symptom, stated directly: a turn of real MCP
    // calls must produce more than one kind.
    const names = [
      "mcp__observability__obs_notes_recent",
      "mcp__local_shell__local_shell_run",
      "mcp__local_shell__local_shell_list_roots",
      "mcp__github__create_pull_request",
    ]
    expect(new Set(names.map(kindForTool)).size).toBeGreaterThan(1)
  })
})

describe("kindForTool - built-in names still win", () => {
  it("classifies the exact-match table before falling back to verbs", () => {
    expect(kindForTool("Bash")).toBe("run")
    expect(kindForTool("Read")).toBe("read")
    expect(kindForTool("Write")).toBe("write")
    expect(kindForTool("Task")).toBe("agent")
    expect(kindForTool("WebFetch")).toBe("web")
  })
})

describe("kindForTool - the substring trap", () => {
  it("does not see 'read' inside 'threads'", () => {
    // A substring matcher would classify this on the wrong evidence. It happens
    // to land on `read` either way, so assert the mechanism, not just the
    // answer.
    expect(toolTokens("list_threads")).toEqual(["list", "threads"])
    expect(toolTokens("list_threads")).not.toContain("read")
  })

  it("splits camelCase MCP tools into words", () => {
    expect(toolTokens("getUserProfile")).toEqual(["get", "user", "profile"])
  })

  it("is unfazed by an unknown server with no recognisable verb", () => {
    expect(kindForTool("mcp__weird__zzz_qqq")).toBe("read")
  })
})

describe("stripMcpPrefix", () => {
  it("splits on the DOUBLE underscore, so single-underscore servers survive", () => {
    // `local_shell` contains a single underscore; splitting on `_` would
    // mangle it and drop the real tool name.
    expect(stripMcpPrefix("mcp__local_shell__local_shell_run")).toBe("local_shell_run")
  })

  it("leaves a non-MCP name alone", () => {
    expect(stripMcpPrefix("Bash")).toBe("Bash")
  })

  it("leaves a malformed mcp-ish name alone rather than guessing", () => {
    expect(stripMcpPrefix("mcp__onlytwo")).toBe("mcp__onlytwo")
  })
})

describe("starsFor - failure still outranks kind", () => {
  const toolStep = (name: string, ok: boolean | null): MergedStep =>
    ({
      seg: {
        kind: "tool",
        name,
        result: ok === null ? null : { ok },
      },
    }) as unknown as MergedStep

  it("marks a failed run as bad, not as run", () => {
    const stars = starsFor([toolStep("mcp__local_shell__local_shell_run", false)], 0)
    expect(stars[0]?.kind).toBe("bad")
  })

  it("marks a succeeded run as run", () => {
    const stars = starsFor([toolStep("mcp__local_shell__local_shell_run", true)], 0)
    expect(stars[0]?.kind).toBe("run")
  })

  it("marks an in-flight run as run, not as a failure", () => {
    const stars = starsFor([toolStep("mcp__local_shell__local_shell_run", null)], 0)
    expect(stars[0]?.kind).toBe("run")
  })
})
