import { describe, expect, it } from "vitest"
import {
  createSmartBarContextModule,
  type GitCommandRunner,
  type SmartBarContext,
} from "../src/smart-bar-context.js"

const baseCtx: SmartBarContext = {
  threadId: "thr_test",
  model: undefined,
  accountLabel: undefined,
  workspaceSlug: undefined,
  localShellBridge: null,
}

interface GitResults {
  readonly toplevel: string | null
  readonly branch: string | null
  readonly status: string | null
}

const makeRunner = (
  results: GitResults,
  onCall?: (args: ReadonlyArray<string>) => void,
): GitCommandRunner => async (_cwd, args) => {
  onCall?.(args)
  if (args[0] === "status") return results.status
  return args.includes("--show-toplevel") ? results.toplevel : results.branch
}

const makeModule = (results: GitResults) =>
  createSmartBarContextModule({ runGitCommand: makeRunner(results) })

const cleanGit: GitResults = {
  toplevel: "/home/user/my-repo",
  branch: "main",
  status: "",
}

describe("SmartBarContextModule", () => {
  it("assembles clean repository context", async () => {
    const items = await makeModule(cleanGit).getItems(baseCtx)

    expect(items.find((item) => item.id === "git.worktree")?.value).toBe("my-repo")
    expect(items.find((item) => item.id === "git.branch")?.value).toBe("main")
    expect(items.find((item) => item.id === "git.status")).toMatchObject({
      value: "clean",
      tone: "good",
    })
  })

  it("reports dirty repositories without exposing status output", async () => {
    const items = await makeModule({
      ...cleanGit,
      status: "M packages/foo/bar.ts\n?? untracked.txt",
    }).getItems(baseCtx)

    expect(items.find((item) => item.id === "git.status")).toMatchObject({
      value: "dirty",
      tone: "warn",
    })
  })

  it("omits Git items when sampling fails while preserving other context", async () => {
    const items = await makeModule({ toplevel: null, branch: null, status: null }).getItems({
      ...baseCtx,
      model: "claude-sonnet-4-6",
      workspaceSlug: "my-workspace",
      accountLabel: "primary",
    })
    const ids = items.map((item) => item.id)

    expect(ids).not.toContain("git.worktree")
    expect(ids).not.toContain("git.branch")
    expect(ids).not.toContain("git.status")
    expect(ids).toEqual(expect.arrayContaining(["model", "workspace", "account"]))
  })

  it("omits the branch item for detached HEAD", async () => {
    const items = await makeModule({
      ...cleanGit,
      branch: "HEAD",
    }).getItems(baseCtx)

    expect(items.find((item) => item.id === "git.branch")).toBeUndefined()
    expect(items.find((item) => item.id === "git.status")?.value).toBe("clean")
  })

  it("preserves worktree and status when an unborn HEAD cannot resolve", async () => {
    const items = await makeModule({
      ...cleanGit,
      branch: null,
    }).getItems(baseCtx)

    expect(items.find((item) => item.id === "git.worktree")?.value).toBe("my-repo")
    expect(items.find((item) => item.id === "git.branch")).toBeUndefined()
    expect(items.find((item) => item.id === "git.status")?.value).toBe("clean")
  })

  it("shares one in-flight sample across concurrent callers for the same cwd", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const runGitCommand: GitCommandRunner = async (_cwd, args) => {
      calls += 1
      await gate
      if (args[0] === "status") return ""
      return args.includes("--show-toplevel") ? "/home/user/my-repo" : "main"
    }
    const module = createSmartBarContextModule({ runGitCommand })

    const requests = Array.from({ length: 10 }, () => module.getItems(baseCtx))
    await Promise.resolve()

    expect(calls).toBe(3)
    release()
    await Promise.all(requests)
    expect(calls).toBe(3)
  })

  it("reuses a fresh sample and refreshes it after the freshness window", async () => {
    let now = 1_000
    let calls = 0
    const module = createSmartBarContextModule({
      freshnessMs: 1_000,
      now: () => now,
      runGitCommand: makeRunner(cleanGit, () => { calls += 1 }),
    })

    await module.getItems(baseCtx)
    now = 1_999
    await module.getItems(baseCtx)
    expect(calls).toBe(3)

    now = 2_001
    await module.getItems(baseCtx)
    expect(calls).toBe(6)
  })

  it("starts sampling asynchronously instead of blocking the caller", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const module = createSmartBarContextModule({
      runGitCommand: async (_cwd, args) => {
        await gate
        if (args[0] === "status") return ""
        return args.includes("--show-toplevel") ? "/home/user/my-repo" : "main"
      },
    })

    const pending = module.getItems(baseCtx)
    const outcome = await Promise.race([
      pending.then(() => "completed" as const),
      Promise.resolve("yielded" as const),
    ])

    expect(outcome).toBe("yielded")
    release()
    await expect(pending).resolves.toEqual(expect.any(Array))
  })
})
