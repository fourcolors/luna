/**
 * composeInterceptors Tier-1 tests.
 *
 * Invariants exercised:
 *  - denyByName matches → deny; non-match → pass
 *  - allowByName matches → allow; non-match → pass
 *  - redactInput strips keys on match; non-match → pass
 *  - compose: first non-pass wins; later interceptors NOT consulted
 *  - compose [] → default allow with original input
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  allowByName,
  composeInterceptors,
  defaultSafetyInterceptors,
  denyByName,
  denyDangerousCommands,
  denySecretPaths,
  mcpToolGate,
  redactInput,
  type McpServerPolicy,
  type ToolInterceptor,
} from "../src/interception.js"

const run = <A>(eff: Effect.Effect<A, never>) => Effect.runPromise(eff)

describe("denyByName", () => {
  it("denies on match, passes on non-match", async () => {
    const d = denyByName(["Bash"])
    expect(await run(d("Bash", {}))).toMatchObject({ behavior: "deny" })
    expect(await run(d("Read", {}))).toBe("pass")
  })
})

describe("allowByName", () => {
  it("allows on match with input preserved, passes on non-match", async () => {
    const a = allowByName(["Read"])
    expect(await run(a("Read", { path: "/x" }))).toEqual({
      behavior: "allow",
      updatedInput: { path: "/x" },
    })
    expect(await run(a("Bash", {}))).toBe("pass")
  })
})

describe("redactInput", () => {
  it("strips listed keys on match; passes otherwise", async () => {
    const r = redactInput(["Fetch"], ["token", "password"])
    const hit = await run(
      r("Fetch", { url: "https://x", token: "sk-…", password: "p" }),
    )
    expect(hit).toEqual({
      behavior: "allow",
      updatedInput: { url: "https://x" },
    })
    expect(await run(r("Read", { token: "sk" }))).toBe("pass")
  })
})

describe("composeInterceptors", () => {
  it("empty list → default allow with original input", async () => {
    const fn = composeInterceptors([])
    const res = await run(fn("X", { a: 1 }))
    expect(res).toEqual({ behavior: "allow", updatedInput: { a: 1 } })
  })

  it("first non-pass wins; later interceptors not consulted", async () => {
    const calls: string[] = []
    const spy = (label: string, out: "pass" | "deny"): ToolInterceptor =>
      (toolName) =>
        Effect.sync(() => {
          calls.push(label)
          return out === "deny"
            ? { behavior: "deny", message: label }
            : "pass"
        })

    const fn = composeInterceptors([
      spy("first", "pass"),
      spy("second", "deny"),
      spy("third", "pass"),
    ])
    const res = await run(fn("Tool", {}))
    expect(res).toEqual({ behavior: "deny", message: "second" })
    // third must NOT run
    expect(calls).toEqual(["first", "second"])
  })

  it("deny-before-allow: deny applies, allow never consulted", async () => {
    const calls: string[] = []
    const track = (label: string, inner: ToolInterceptor): ToolInterceptor =>
      (n, i) =>
        Effect.sync(() => calls.push(label)).pipe(
          Effect.zipRight(inner(n, i)),
        )

    const fn = composeInterceptors([
      track("deny", denyByName(["Bash"])),
      track("allow", allowByName(["Bash"])),
    ])
    const res = await run(fn("Bash", {}))
    expect(res).toMatchObject({ behavior: "deny" })
    expect(calls).toEqual(["deny"])
  })

  it("all pass → default allow with original input", async () => {
    const fn = composeInterceptors([
      denyByName(["Other"]),
      allowByName(["Other"]),
    ])
    const res = await run(fn("Neither", { k: "v" }))
    expect(res).toEqual({ behavior: "allow", updatedInput: { k: "v" } })
  })
})

describe("denyDangerousCommands", () => {
  const d = denyDangerousCommands()

  it("denies rm -rf in every flag spelling/order", async () => {
    for (const cmd of [
      "rm -rf /tmp/x",
      "rm -fr build",
      "rm -r -f node_modules",
      "rm -f -r dist",
      "rm --recursive --force foo",
      "rm --force --recursive foo",
      "sudo rm -rf /",
      "cd /x && rm -rfv .",
      "find . -type d -name node_modules | xargs rm -rf", // piped/xargs
      "find . -name node_modules -exec rm -rf {} +", // find -exec
      'for f in *; do rm -rf "$f"; done', // loop body
    ]) {
      expect(await run(d("Bash", { command: cmd }))).toMatchObject({
        behavior: "deny",
      })
    }
  })

  it("passes rm WITHOUT the force+recursive combo", async () => {
    expect(await run(d("Bash", { command: "rm -f stale.lock" }))).toBe("pass")
    expect(await run(d("Bash", { command: "rm file.txt" }))).toBe("pass")
    expect(await run(d("Bash", { command: "rm -r emptydir" }))).toBe("pass")
  })

  it("denies other catastrophic ops (mkfs, dd-to-device, fork bomb)", async () => {
    for (const cmd of [
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda bs=1M",
      ":(){ :|:& };:",
      "echo hi > /dev/nvme0n1",
    ]) {
      expect(await run(d("Bash", { command: cmd }))).toMatchObject({
        behavior: "deny",
      })
    }
  })

  it("passes benign commands", async () => {
    for (const cmd of [
      "bun test",
      "git status",
      "ls -la",
      "grep -rf pattern .", // -rf here is grep flags, no rm
      "echo 'rm -rf is dangerous'", // mentions but does not invoke rm
      'git commit -m "cleanup: rm -rf old build dir"', // mention in message
    ]) {
      expect(await run(d("Bash", { command: cmd }))).toBe("pass")
    }
  })

  it("passes non-shell tools and empty/missing command", async () => {
    expect(await run(d("WebFetch", { url: "https://x" }))).toBe("pass")
    expect(await run(d("Bash", {}))).toBe("pass")
    expect(await run(d("Bash", { command: "" }))).toBe("pass")
  })
})

describe("denySecretPaths", () => {
  const d = denySecretPaths()

  it("denies secret-bearing paths via file_path", async () => {
    for (const p of [
      ".env",
      ".env.local",
      "apps/api/.env.production",
      "/abs/path/.env",
      "secrets/key.json",
      "config/secret/creds",
      "/home/u/.ssh/id_rsa",
      "/home/u/.ssh/id_dsa",
      "/root/.ssh/authorized_keys",
      "certs/server.pem",
      "certs/server.key",
      "/home/u/.aws/credentials",
      "/home/u/.netrc",
      "project/.npmrc",
      "/home/u/.git-credentials",
      "gcp/credentials.json",
    ]) {
      expect(await run(d("Read", { file_path: p }))).toMatchObject({
        behavior: "deny",
      })
    }
  })

  it("also inspects the `path` key (Grep/Glob-style)", async () => {
    expect(await run(d("Read", { path: "secrets/x" }))).toMatchObject({
      behavior: "deny",
    })
  })

  it("passes ordinary source paths and look-alikes", async () => {
    for (const p of [
      "src/index.ts",
      "README.md",
      ".environment.ts", // not .env
      "env/config.ts", // dir named env, not .env
      "docs/secretsauce.md", // not a secrets/ dir
    ]) {
      expect(await run(d("Read", { file_path: p }))).toBe("pass")
    }
  })

  it("passes non-file tools and missing path", async () => {
    expect(await run(d("Bash", { command: "cat .env" }))).toBe("pass")
    expect(await run(d("Read", {}))).toBe("pass")
  })
})

describe("defaultSafetyInterceptors (composed policy)", () => {
  const policy = composeInterceptors(defaultSafetyInterceptors())

  it("denies destructive Bash, allows benign Bash", async () => {
    expect(await run(policy("Bash", { command: "rm -rf /" }))).toMatchObject({
      behavior: "deny",
    })
    expect(await run(policy("Bash", { command: "bun test" }))).toEqual({
      behavior: "allow",
      updatedInput: { command: "bun test" },
    })
  })

  it("denies secret file access, allows ordinary reads", async () => {
    expect(await run(policy("Read", { file_path: ".env" }))).toMatchObject({
      behavior: "deny",
    })
    expect(
      await run(policy("Read", { file_path: "src/app.ts" })),
    ).toEqual({ behavior: "allow", updatedInput: { file_path: "src/app.ts" } })
  })

  it("default-ALLOWs research tools (WebFetch/WebSearch) unchanged", async () => {
    expect(
      await run(policy("WebFetch", { url: "https://docs.example.com" })),
    ).toEqual({
      behavior: "allow",
      updatedInput: { url: "https://docs.example.com" },
    })
    expect(await run(policy("WebSearch", { query: "x" }))).toEqual({
      behavior: "allow",
      updatedInput: { query: "x" },
    })
  })
})

// ---------------------------------------------------------------------------
// mcpToolGate — Slice C fail-closed MCP server tool gate
// ---------------------------------------------------------------------------

describe("mcpToolGate", () => {
  // Helper: build a gate backed by a static policy map.
  const makeGate = (policies: Record<string, McpServerPolicy>) =>
    mcpToolGate((slug) => policies[slug])

  // (a) Registered slug with allowAll=false and empty allowedTools → DENIED.
  it("(a) denies all tools for a registered server with allowAll=false and empty allowedTools", async () => {
    const gate = makeGate({
      "ic-floor10": { allowAll: false, allowedTools: new Set() },
    })
    const result = await run(
      gate("mcp__ic-floor10__ic_events_list_upcoming", {}),
    )
    expect(result).toMatchObject({ behavior: "deny" })
    expect((result as { behavior: string; message: string }).message).toContain(
      "ic_events_list_upcoming",
    )
    expect((result as { behavior: string; message: string }).message).toContain(
      "ic-floor10",
    )
  })

  // (b) Same server after allowAll=true → ALLOWED.
  it("(b) allows all tools after allowAll is set to true", async () => {
    const gate = makeGate({
      "ic-floor10": { allowAll: true, allowedTools: new Set() },
    })
    const input = { since: "2026-07-07" }
    const result = await run(
      gate("mcp__ic-floor10__ic_events_list_upcoming", input),
    )
    expect(result).toEqual({ behavior: "allow", updatedInput: input })
  })

  // (c) allowAll=false but the exact tool is in allowedTools → ALLOWED;
  //     a different tool → DENIED.
  it("(c) allows only the explicitly listed tool when allowAll=false", async () => {
    const gate = makeGate({
      "ic-floor10": {
        allowAll: false,
        allowedTools: new Set(["ic_events_list_upcoming"]),
      },
    })
    const input = {}
    // Listed tool → allowed.
    expect(
      await run(gate("mcp__ic-floor10__ic_events_list_upcoming", input)),
    ).toEqual({ behavior: "allow", updatedInput: input })
    // Unlisted tool → denied.
    expect(
      await run(gate("mcp__ic-floor10__ic_donate", input)),
    ).toMatchObject({ behavior: "deny" })
  })

  // (d) Non-MCP tool names pass through (no opinion).
  it("(d) passes non-MCP tool names (Read, Bash, etc.)", async () => {
    const gate = makeGate({})
    expect(await run(gate("Read", { file_path: "/x" }))).toBe("pass")
    expect(await run(gate("Bash", { command: "ls" }))).toBe("pass")
    expect(await run(gate("WebFetch", { url: "https://x" }))).toBe("pass")
  })

  // (e) mcp__ tool for a slug the lookup doesn't know → "pass"
  //     (built-ins and connectors are unaffected).
  it("(e) passes built-in and unknown-slug mcp__ tools (built-ins / connectors unaffected)", async () => {
    // The policy map is empty — no operator-registered servers.
    const gate = makeGate({})
    // Built-in server tool.
    expect(await run(gate("mcp__memory__memory_search", {}))).toBe("pass")
    // An unknown slug (e.g. a connector).
    expect(await run(gate("mcp__someconnector__foo", {}))).toBe("pass")
  })

  // (f) Deny-by-default end-to-end: freshly-registered server (allowAll=false,
  //     empty allowedTools) denies ALL its tools.
  it("(f) deny-by-default: freshly-registered server denies ALL its tools", async () => {
    const gate = makeGate({
      "new-server": { allowAll: false, allowedTools: new Set() },
    })
    for (const toolName of [
      "mcp__new-server__tool_a",
      "mcp__new-server__tool_b",
      "mcp__new-server__do_something",
    ]) {
      const result = await run(gate(toolName, {}))
      expect(result).toMatchObject({ behavior: "deny" })
    }
  })

  // (g) Policy change reflected live: same gate instance, policy map mutated
  //     between calls — the gate reads policyLookup on each call.
  it("(g) reflects policy changes live without rebuilding the gate", async () => {
    const liveMap = new Map<string, McpServerPolicy>([
      ["ic-floor10", { allowAll: false, allowedTools: new Set() }],
    ])
    const gate = mcpToolGate((slug) => liveMap.get(slug))

    // Before policy change → denied.
    expect(
      await run(gate("mcp__ic-floor10__ic_events_list_upcoming", {})),
    ).toMatchObject({ behavior: "deny" })

    // Mutate policy in-place (simulates replaceMcpToolPolicy).
    liveMap.set("ic-floor10", {
      allowAll: false,
      allowedTools: new Set(["ic_events_list_upcoming"]),
    })

    // After policy change → allowed.
    expect(
      await run(gate("mcp__ic-floor10__ic_events_list_upcoming", {})),
    ).toMatchObject({ behavior: "allow" })
  })
})

// ---------------------------------------------------------------------------
// mcpToolGate regex routing — pin tests that a future "simplification"
// of the ^mcp__([a-z0-9-]+)__ routing regex cannot silently regress.
// ---------------------------------------------------------------------------

describe("mcpToolGate regex routing (regression pins)", () => {
  const makeGate = (policies: Record<string, McpServerPolicy>) =>
    mcpToolGate((slug) => policies[slug])

  // (i) A built-in tool name that contains underscores
  // (`mcp__local_shell__local_shell_run`) is never denied by the operator
  // gate.  The regex `^mcp__([a-z0-9-]+)__(.+)$` parses it as slug="local"
  // (stops at the first `_`), tool="shell__local_shell_run"; policyLookup
  // for "local" returns undefined → "pass".  The built-in server's tool is
  // never blocked by operator policy, regardless of what policies exist.
  it("(i) mcp__local_shell__local_shell_run passes (built-in underscore name not blocked by operator gate)", async () => {
    // Even with a policy for "local" present (deny-all), the gate parses the
    // built-in name as slug="local" — but no operator server is named "local"
    // in a real deployment.  Here we confirm: with NO entry for "local" the
    // tool passes through (policyLookup returns undefined → "pass").
    const gate = makeGate({
      // No "local" entry — confirms undefined lookup → pass.
    })
    expect(await run(gate("mcp__local_shell__local_shell_run", {}))).toBe("pass")
  })

  // (ii) A hyphenated operator slug "a-b" with allowAll:true — tool names
  // that themselves contain double-underscores (e.g. "c__d") are routed
  // correctly: the regex captures "a-b" as the slug and "c__d" as the tool.
  it("(ii) mcp__a-b__c__d with active allowAll policy for slug 'a-b' → allow; parsed tool is 'c__d'", async () => {
    const gate = makeGate({
      "a-b": { allowAll: true, allowedTools: new Set() },
    })
    const input = { x: 1 }
    const result = await run(gate("mcp__a-b__c__d", input))
    expect(result).toEqual({ behavior: "allow", updatedInput: input })
  })

  // (iii) `mcp__x__` (empty tool segment after the slug) — the gate must
  // not crash and must pass through (no policy lookup should occur for an
  // empty tool name, and no operator server's policy denies "nothing").
  it("(iii) mcp__x__ (empty tool segment) passes without error", async () => {
    const gate = makeGate({
      x: { allowAll: false, allowedTools: new Set() },
    })
    expect(await run(gate("mcp__x__", {}))).toBe("pass")
  })
})
