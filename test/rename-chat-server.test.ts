import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

// A hardcoded depth below this file (e.g. resolve(__dirname, "../../../.."))
// silently mis-resolves the repo root the moment this file moves - git
// still exits 0 against the wrong tree. Ask git for the real root instead.
const repoRoot = (() => {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: __dirname,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git rev-parse --show-toplevel failed: ${r.stderr}`);
  }
  return r.stdout.trim();
})();

// Dated planning archives narrate work using whatever names were live when
// they were written; they are historical records, not current source, so a
// retired name legitimately still appears inside them. docs/next/ is NOT
// exempted wholesale (it holds live contract docs) - only the two transient
// stack-plan artifacts that describe this guard's own slice; drop those two
// entries when the stack23 artifacts are retired.
const EXCLUDES = [
  ":(exclude)docs/briefs",
  ":(exclude)docs/superpowers",
  ":(exclude)docs/next/stack23-plan.json",
  ":(exclude)docs/next/stack23-slices.md",
  ":(exclude)test/rename-chat-server.test.ts",
];

const NEEDLES = ["dev-server-chat", "dev:server:chat"];

// git grep exits 0 on hits, 1 on none, >1 on error - 1 is the passing case
// and must not be treated as a failure.
const gitList = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const r = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }
  return r.stdout.split("\n").filter(Boolean);
};

describe("retired rename guard: dev-server-chat -> chat-server (completed 2024)", () => {
  it("no live tracked file's contents reference a retired name", () => {
    const flags = NEEDLES.flatMap((n) => ["-e", n]);
    expect(gitList(["grep", "-l", "-F", ...flags, "--", ...EXCLUDES])).toEqual([]);
  });

  it("no live tracked file's path carries a retired name", () => {
    const globs = NEEDLES.map((n) => `*${n}*`);
    expect(gitList(["ls-files", "--", ...globs, ...EXCLUDES])).toEqual([]);
  });
});
