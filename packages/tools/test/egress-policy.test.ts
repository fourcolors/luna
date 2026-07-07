import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { egressAllowlist, type EgressDecision } from "../src/egress-policy"
import { classifyTool } from "../src/effect-class"
import type { PolicySubject } from "../src/egress-policy"
import type { InterceptorVerdict } from "../src/interception"

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Run the egress interceptor synchronously and return the verdict. Callers
 * pass a fresh `records` array via `onDecision` when they want to inspect the
 * audit trail.
 */
const run = (
  opts: Parameters<typeof egressAllowlist>[0],
  tool: string,
  input: Record<string, unknown>,
): InterceptorVerdict => Effect.runSync(egressAllowlist(opts)(tool, input))

/** Convenience: run with a captured audit array. */
const runWithRecords = (
  opts: Omit<Parameters<typeof egressAllowlist>[0], "onDecision">,
  tool: string,
  input: Record<string, unknown>,
): { verdict: InterceptorVerdict; records: EgressDecision[] } => {
  const records: EgressDecision[] = []
  const verdict = run(
    { ...opts, onDecision: (d) => records.push(d) },
    tool,
    input,
  )
  return { verdict, records }
}

/**
 * Assert exactly one decision record was captured and return it with a
 * non-undefined type. Under `noUncheckedIndexedAccess`, `recs[0]` is
 * `EgressDecision | undefined`; this narrows it honestly.
 */
const only = (recs: ReadonlyArray<EgressDecision>): EgressDecision => {
  expect(recs).toHaveLength(1)
  const d = recs[0]
  if (d === undefined) throw new Error("expected exactly one decision record")
  return d
}

/* -------------------------------------------------------------------------- */
/* classifyTool                                                               */
/* -------------------------------------------------------------------------- */

describe("classifyTool", () => {
  it("classifies egress tools", () => {
    expect(classifyTool("WebFetch")).toBe("egress")
    expect(classifyTool("WebSearch")).toBe("egress")
  })

  it("classifies read tools", () => {
    expect(classifyTool("Read")).toBe("read")
    expect(classifyTool("Grep")).toBe("read")
    expect(classifyTool("Glob")).toBe("read")
    expect(classifyTool("NotebookRead")).toBe("read")
  })

  it("classifies write tools", () => {
    expect(classifyTool("Edit")).toBe("write")
    expect(classifyTool("Write")).toBe("write")
    expect(classifyTool("MultiEdit")).toBe("write")
    expect(classifyTool("NotebookEdit")).toBe("write")
  })

  it("classifies exec tools", () => {
    expect(classifyTool("Bash")).toBe("exec")
    expect(classifyTool("mcp__local_shell__local_shell_run")).toBe("exec")
  })

  it("classifies unknown / other tools as meta", () => {
    expect(classifyTool("TodoWrite")).toBe("meta")
    expect(classifyTool("SomeRandomTool")).toBe("meta")
    expect(classifyTool("")).toBe("meta")
  })
})

/* -------------------------------------------------------------------------- */
/* Non-egress pass-through                                                    */
/* -------------------------------------------------------------------------- */

describe("egressAllowlist: non-egress tools", () => {
  it("passes on a non-egress tool and does NOT call onDecision", () => {
    const records: EgressDecision[] = []
    const verdict = run(
      { allowedHosts: ["anthropic.com"], onDecision: (d) => records.push(d) },
      "Read",
      { file_path: "/etc/hosts" },
    )
    expect(verdict).toBe("pass")
    expect(records).toHaveLength(0)
  })

  it("passes on Bash (exec) without invoking onDecision", () => {
    const records: EgressDecision[] = []
    const verdict = run(
      { allowedHosts: ["anthropic.com"], onDecision: (d) => records.push(d) },
      "Bash",
      { command: "ls" },
    )
    expect(verdict).toBe("pass")
    expect(records).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* WebFetch allow                                                             */
/* -------------------------------------------------------------------------- */

describe("egressAllowlist: WebFetch allow", () => {
  it("allows an exact allow-listed host and preserves updatedInput identity", () => {
    const input = { url: "https://anthropic.com/index.html" }
    const verdict = run(
      { allowedHosts: ["anthropic.com"] },
      "WebFetch",
      input,
    )
    expect(verdict).toMatchObject({ behavior: "allow" })
    // updatedInput must be the SAME object reference (no rewrite).
    expect((verdict as { updatedInput: unknown }).updatedInput).toBe(input)
  })

  it("allows a subdomain of an allow-listed host", () => {
    const { verdict, records } = runWithRecords(
      { allowedHosts: ["anthropic.com"] },
      "WebFetch",
      { url: "https://api.anthropic.com/v1/messages" },
    )
    expect(verdict).toMatchObject({ behavior: "allow" })
    expect(only(records).decision).toBe("allow")
    expect(only(records).target).toBe("api.anthropic.com")
  })

  it("matches host case-insensitively (uppercase URL host)", () => {
    const { verdict } = runWithRecords(
      { allowedHosts: ["anthropic.com"] },
      "WebFetch",
      { url: "https://ANTHROPIC.COM/x" },
    )
    expect(verdict).toMatchObject({ behavior: "allow" })
  })

  it("matches host case-insensitively (uppercase allowedHosts entry)", () => {
    const { verdict } = runWithRecords(
      { allowedHosts: ["ANTHROPIC.COM"] },
      "WebFetch",
      { url: "https://api.anthropic.com/x" },
    )
    expect(verdict).toMatchObject({ behavior: "allow" })
  })
})

/* -------------------------------------------------------------------------- */
/* WebFetch deny                                                              */
/* -------------------------------------------------------------------------- */

describe("egressAllowlist: WebFetch deny", () => {
  it("denies an unlisted host and mentions the host in the message", () => {
    const verdict = run(
      { allowedHosts: ["anthropic.com"] },
      "WebFetch",
      { url: "https://evil.example.com/steal" },
    )
    expect(verdict).toMatchObject({ behavior: "deny" })
    const message = (verdict as { message: string }).message
    expect(message).toContain("evil.example.com")
  })

  it("does not treat a look-alike suffix as a subdomain match", () => {
    // notanthropic.com must NOT match anthropic.com
    const { verdict, records } = runWithRecords(
      { allowedHosts: ["anthropic.com"] },
      "WebFetch",
      { url: "https://notanthropic.com/x" },
    )
    expect(verdict).toMatchObject({ behavior: "deny" })
    expect(only(records).decision).toBe("deny")
    expect(only(records).target).toBe("notanthropic.com")
  })
})

/* -------------------------------------------------------------------------- */
/* Fail-closed: missing / bad targets                                         */
/* -------------------------------------------------------------------------- */

describe("egressAllowlist: fail-closed (no valid target)", () => {
  it("denies WebFetch with a missing url (rule egress-no-target)", () => {
    const { verdict, records } = runWithRecords(
      { allowedHosts: ["anthropic.com"] },
      "WebFetch",
      {},
    )
    expect(verdict).toMatchObject({ behavior: "deny" })
    expect(only(records).rule).toBe("egress-no-target")
    expect(only(records).target).toBeNull()
  })

  it("denies WebFetch with a non-string url (rule egress-no-target)", () => {
    const { verdict, records } = runWithRecords(
      { allowedHosts: ["anthropic.com"] },
      "WebFetch",
      { url: 42 },
    )
    expect(verdict).toMatchObject({ behavior: "deny" })
    expect(only(records).rule).toBe("egress-no-target")
    expect(only(records).target).toBeNull()
  })

  it("denies WebFetch with a malformed url (rule egress-no-target)", () => {
    const { verdict, records } = runWithRecords(
      { allowedHosts: ["anthropic.com"] },
      "WebFetch",
      { url: "not a url" },
    )
    expect(verdict).toMatchObject({ behavior: "deny" })
    expect(only(records).rule).toBe("egress-no-target")
    expect(only(records).target).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* Subject policy                                                             */
/* -------------------------------------------------------------------------- */

describe("egressAllowlist: subject policy", () => {
  it("denies a subagent even for an allow-listed host (rule subject-no-egress)", () => {
    const { verdict, records } = runWithRecords(
      { allowedHosts: ["anthropic.com"], subject: "subagent" },
      "WebFetch",
      { url: "https://anthropic.com/x" },
    )
    expect(verdict).toMatchObject({ behavior: "deny" })
    expect(only(records).rule).toBe("subject-no-egress")
    expect(only(records).subject).toBe("subagent")
    expect(only(records).decision).toBe("deny")
  })

  it("denies a background-job even for an allow-listed host", () => {
    const { verdict, records } = runWithRecords(
      { allowedHosts: ["anthropic.com"], subject: "background-job" },
      "WebFetch",
      { url: "https://anthropic.com/x" },
    )
    expect(verdict).toMatchObject({ behavior: "deny" })
    expect(only(records).rule).toBe("subject-no-egress")
    expect(only(records).subject).toBe("background-job")
  })

  it("allows the main-thread subject (explicit) for an allow-listed host", () => {
    const { verdict, records } = runWithRecords(
      { allowedHosts: ["anthropic.com"], subject: "main-thread" },
      "WebFetch",
      { url: "https://anthropic.com/x" },
    )
    expect(verdict).toMatchObject({ behavior: "allow" })
    expect(only(records).subject).toBe("main-thread")
  })
})

/* -------------------------------------------------------------------------- */
/* WebSearch                                                                  */
/* -------------------------------------------------------------------------- */

describe("egressAllowlist: WebSearch", () => {
  it("allows when all allowed_domains are within the allowlist (rule search-domains-allowlisted)", () => {
    const { verdict, records } = runWithRecords(
      { allowedHosts: ["anthropic.com", "docs.effect.website"] },
      "WebSearch",
      { query: "effect", allowed_domains: ["anthropic.com", "docs.effect.website"] },
    )
    expect(verdict).toMatchObject({ behavior: "allow" })
    expect(only(records).rule).toBe("search-domains-allowlisted")
    expect(only(records).decision).toBe("allow")
  })

  it("allows when an allowed_domain is a subdomain of an allowlisted host", () => {
    const { verdict } = runWithRecords(
      { allowedHosts: ["anthropic.com"] },
      "WebSearch",
      { query: "x", allowed_domains: ["api.anthropic.com"] },
    )
    expect(verdict).toMatchObject({ behavior: "allow" })
  })

  it("matches allowed_domains case-insensitively (uppercase allowed_domains entry)", () => {
    const { verdict, records } = runWithRecords(
      { allowedHosts: ["anthropic.com"] },
      "WebSearch",
      { query: "x", allowed_domains: ["ANTHROPIC.COM"] },
    )
    expect(verdict).toMatchObject({ behavior: "allow" })
    expect(only(records).rule).toBe("search-domains-allowlisted")
    expect(only(records).decision).toBe("allow")
  })

  it("matches a mixed-case allowed_domains subdomain against an allowlisted host", () => {
    const { verdict } = runWithRecords(
      { allowedHosts: ["anthropic.com"] },
      "WebSearch",
      { query: "x", allowed_domains: ["API.Anthropic.com"] },
    )
    expect(verdict).toMatchObject({ behavior: "allow" })
  })

  it("denies when one allowed_domain falls outside the allowlist", () => {
    const { verdict, records } = runWithRecords(
      { allowedHosts: ["anthropic.com"] },
      "WebSearch",
      { query: "x", allowed_domains: ["anthropic.com", "evil.example.com"] },
    )
    expect(verdict).toMatchObject({ behavior: "deny" })
    expect(only(records).decision).toBe("deny")
  })

  it("records the joined requested domains as target when not all are allow-listed (rule search-domains-not-allowlisted)", () => {
    const { verdict, records } = runWithRecords(
      { allowedHosts: ["github.com"] },
      "WebSearch",
      { query: "x", allowed_domains: ["evil.com", "github.com"] },
    )
    expect(verdict).toMatchObject({ behavior: "deny" })
    expect(only(records).decision).toBe("deny")
    expect(only(records).rule).toBe("search-domains-not-allowlisted")
    expect(only(records).target).toBe("evil.com,github.com")
  })

  it("denies when there are no allowed_domains (fail-closed, unscoped search) with a null target", () => {
    const { verdict, records } = runWithRecords(
      { allowedHosts: ["anthropic.com"] },
      "WebSearch",
      { query: "x" },
    )
    expect(verdict).toMatchObject({ behavior: "deny" })
    expect(only(records).target).toBeNull()
  })

  it("denies WebSearch for a non-main subject regardless of domains", () => {
    const { verdict, records } = runWithRecords(
      { allowedHosts: ["anthropic.com"], subject: "subagent" },
      "WebSearch",
      { query: "x", allowed_domains: ["anthropic.com"] },
    )
    expect(verdict).toMatchObject({ behavior: "deny" })
    expect(only(records).rule).toBe("subject-no-egress")
  })
})

/* -------------------------------------------------------------------------- */
/* Audit trail                                                                */
/* -------------------------------------------------------------------------- */

describe("egressAllowlist: audit trail", () => {
  it("calls onDecision exactly once per egress evaluation", () => {
    const records: EgressDecision[] = []
    run(
      { allowedHosts: ["anthropic.com"], onDecision: (d) => records.push(d) },
      "WebFetch",
      { url: "https://anthropic.com/x" },
    )
    expect(records).toHaveLength(1)
  })

  it("emits a fully-shaped decision record on allow", () => {
    const { records } = runWithRecords(
      { allowedHosts: ["anthropic.com"] },
      "WebFetch",
      { url: "https://anthropic.com/x" },
    )
    expect(records).toHaveLength(1)
    const d = records[0]
    if (d === undefined) throw new Error("expected exactly one decision record")
    expect(d.tool).toBe("WebFetch")
    expect(d.effectClass).toBe("egress")
    expect(d.subject).toBe("main-thread")
    expect(d.target).toBe("anthropic.com")
    expect(d.decision).toBe("allow")
    expect(typeof d.rule).toBe("string")
    expect(d.rule.length).toBeGreaterThan(0)
  })

  it("emits a fully-shaped decision record on deny", () => {
    const { records } = runWithRecords(
      { allowedHosts: ["anthropic.com"] },
      "WebFetch",
      { url: "https://evil.example.com/x" },
    )
    expect(records).toHaveLength(1)
    const d = records[0]
    if (d === undefined) throw new Error("expected exactly one decision record")
    expect(d.tool).toBe("WebFetch")
    expect(d.effectClass).toBe("egress")
    expect(d.decision).toBe("deny")
    expect(d.target).toBe("evil.example.com")
    expect(typeof d.rule).toBe("string")
  })

  it("defaults subject to main-thread when none is supplied", () => {
    const { records } = runWithRecords(
      { allowedHosts: ["anthropic.com"] },
      "WebFetch",
      { url: "https://anthropic.com/x" },
    )
    const subject: PolicySubject = only(records).subject
    expect(subject).toBe("main-thread")
  })

  it("works with no onDecision callback provided (does not throw)", () => {
    const verdict = run(
      { allowedHosts: ["anthropic.com"] },
      "WebFetch",
      { url: "https://anthropic.com/x" },
    )
    expect(verdict).toMatchObject({ behavior: "allow" })
  })
})
