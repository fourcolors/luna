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
  redactInput,
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
